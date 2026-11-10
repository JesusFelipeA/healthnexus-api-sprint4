// Dispensación de recetas (igual que DispensacionController de la web).
// Una receta es una consulta finalizada con medicamentos en consulta_medicamento o con receta libre.
// Dispensar descuenta del inventario los lotes vigentes que caducan primero (FEFO) y marca la consulta
// como dispensada; revertir (solo administrador) devuelve las unidades a los mismos lotes.
const router = require('express').Router();
const pool = require('../db');
const { ah, HttpError, auth, roles, audit, paginar, idValido } = require('../middleware');
const { AHORA_MX } = require('../hora');

const FARMACIA = roles('farmacia');
const SOLO_ADMIN = roles();
const ES_RECETA = `c.estado = 'finalizada' AND (EXISTS (SELECT 1 FROM consulta_medicamento cm WHERE cm.consulta_id = c.id)
  OR (c.receta_libre IS NOT NULL AND c.receta_libre <> ''))`;
const PACIENTE = "CONCAT_WS(' ', p.nombre, p.apellido_paterno, p.apellido_materno)";
const MAX_UNIDADES = 100;

// GET /api/farmacia/recetas/resumen  -> contadores del tablero (como la web)
router.get('/resumen', auth, FARMACIA, ah(async (req, res) => {
  const [[r]] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM consultas c WHERE ${ES_RECETA} AND c.dispensada = 0) AS pendientes,
       (SELECT COUNT(*) FROM consultas c WHERE c.dispensada = 1 AND DATE(c.dispensada_en) = DATE(${AHORA_MX})) AS dispensadasHoy,
       (SELECT COUNT(*) FROM consultas c WHERE c.dispensada = 1 AND DATE_FORMAT(c.dispensada_en, '%Y-%m') = DATE_FORMAT(${AHORA_MX}, '%Y-%m')) AS dispensadasMes`);
  res.json({ pendientes: Number(r.pendientes), dispensadasHoy: Number(r.dispensadasHoy), dispensadasMes: Number(r.dispensadasMes) });
}));

// GET /api/farmacia/recetas?estado=pendientes|dispensadas|todas&q=&page=&limit=
router.get('/', auth, FARMACIA, ah(async (req, res) => {
  const estado = req.query.estado || 'pendientes';
  if (!['pendientes', 'dispensadas', 'todas'].includes(estado)) throw new HttpError(400, 'estado inválido. Usa: pendientes, dispensadas, todas');
  const where = [ES_RECETA]; const params = [];
  if (estado === 'pendientes') where.push('c.dispensada = 0');
  if (estado === 'dispensadas') where.push('c.dispensada = 1');
  if (req.query.q) { where.push(`(${PACIENTE} LIKE ? OR p.curp LIKE ?)`); const t = `%${String(req.query.q).trim()}%`; params.push(t, t); }
  const w = `WHERE ${where.join(' AND ')}`;
  const { limit, page, offset } = paginar(req, { def: 20, max: 100 });
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM consultas c JOIN pacientes p ON p.id = c.paciente_id ${w}`, params);
  const [rows] = await pool.query(
    `SELECT c.id, c.paciente_id AS pacienteId, ${PACIENTE} AS paciente, p.curp, um.name AS medico,
            COALESCE(c.finalizada_en, c.created_at) AS fecha,
            (SELECT COUNT(*) FROM consulta_medicamento cm WHERE cm.consulta_id = c.id) AS medicamentos,
            (c.receta_libre IS NOT NULL AND c.receta_libre <> '') AS recetaLibre,
            c.dispensada, c.dispensada_en AS dispensadaEn, ud.name AS dispensadaPor
     FROM consultas c
     JOIN pacientes p ON p.id = c.paciente_id
     LEFT JOIN users um ON um.id = c.medico_id
     LEFT JOIN users ud ON ud.id = c.dispensada_por
     ${w} ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  res.json({
    total: Number(total), page, limit,
    data: rows.map((r) => ({ ...r, medicamentos: Number(r.medicamentos), recetaLibre: Boolean(Number(r.recetaLibre)), dispensada: Boolean(Number(r.dispensada)) })),
  });
}));

// GET /api/farmacia/recetas/:id  -> receta con sus medicamentos y lo disponible en lotes vigentes
router.get('/:id', auth, FARMACIA, ah(async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) throw new HttpError(400, 'id inválido');
  const [[c]] = await pool.query(
    `SELECT c.id, c.paciente_id AS pacienteId, ${PACIENTE} AS paciente, p.curp, um.name AS medico, c.estado,
            c.diagnostico_principal AS diagnostico, COALESCE(c.finalizada_en, c.created_at) AS fecha, c.receta_libre AS recetaLibre,
            c.dispensada, c.dispensada_en AS dispensadaEn, ud.name AS dispensadaPor, c.notas_dispensacion AS notasDispensacion
     FROM consultas c
     JOIN pacientes p ON p.id = c.paciente_id
     LEFT JOIN users um ON um.id = c.medico_id
     LEFT JOIN users ud ON ud.id = c.dispensada_por
     WHERE c.id = ?`, [id]);
  if (!c) throw new HttpError(404, 'Receta no encontrada');
  const [meds] = await pool.query(
    `SELECT cm.medicamento_id AS medicamentoId, m.nombre, m.presentacion, m.concentracion, cm.dosis, cm.via, cm.frecuencia,
            cm.duracion, cm.indicaciones, m.controlado, m.psicotropico,
            (SELECT COALESCE(SUM(l.cantidad_disponible), 0) FROM lotes l
              WHERE l.medicamento_id = m.id AND l.activo = 1 AND l.cantidad_disponible > 0 AND l.fecha_caducidad >= DATE(${AHORA_MX})) AS disponible
     FROM consulta_medicamento cm JOIN medicamentos m ON m.id = cm.medicamento_id
     WHERE cm.consulta_id = ? ORDER BY cm.id`, [id]);
  if (c.estado !== 'finalizada' || (!meds.length && !c.recetaLibre)) throw new HttpError(404, 'Receta no encontrada');
  delete c.estado;
  res.json({
    ...c, dispensada: Boolean(Number(c.dispensada)),
    medicamentos: meds.map((m) => ({
      ...m, controlado: Number(m.controlado) === 1 || Number(m.psicotropico) === 1, psicotropico: undefined, disponible: Number(m.disponible),
    })),
  });
}));

// Bloquea la consulta (FOR UPDATE) y valida que sea una receta
async function recetaBloqueada(conn, id) {
  const [[c]] = await conn.query('SELECT id, paciente_id, estado, dispensada, receta_libre FROM consultas WHERE id = ? FOR UPDATE', [id]);
  if (!c) throw new HttpError(404, 'Receta no encontrada');
  if (c.estado !== 'finalizada') throw new HttpError(409, 'La consulta aún no está finalizada', 'CONSULTA_NO_FINALIZADA');
  return c;
}

// POST /api/farmacia/recetas/:id/dispensar  { notas?, unidades?: { [medicamentoId]: n } }
// Igual que la web: 1 unidad por medicamento recetado (se puede indicar otra cantidad por medicamento).
// Todo en una transacción: si falta stock de cualquier medicamento no se descuenta nada (409 SIN_STOCK).
// Los medicamentos y sus lotes se bloquean en orden de id para que dos dispensaciones a la vez no choquen.
router.post('/:id/dispensar', auth, FARMACIA, ah(async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) throw new HttpError(400, 'id inválido');
  const b = req.body || {};
  const notas = b.notas === undefined || b.notas === null ? '' : String(b.notas).trim();
  if (notas.length > 500) throw new HttpError(400, 'Las notas no pueden superar 500 caracteres');
  const pedidas = b.unidades === undefined || b.unidades === null ? {} : b.unidades;
  if (typeof pedidas !== 'object' || Array.isArray(pedidas)) throw new HttpError(400, 'unidades debe ser un objeto { medicamentoId: cantidad }');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const c = await recetaBloqueada(conn, id);
    if (Number(c.dispensada) === 1) throw new HttpError(409, 'Esta receta ya fue dispensada', 'YA_DISPENSADA');

    const [renglones] = await conn.query('SELECT medicamento_id FROM consulta_medicamento WHERE consulta_id = ? ORDER BY medicamento_id', [id]);
    if (!renglones.length && !(c.receta_libre && String(c.receta_libre).trim())) throw new HttpError(409, 'Esta consulta no tiene receta', 'SIN_RECETA');
    const recetados = [...new Set(renglones.map((r) => Number(r.medicamento_id)))].sort((a, b2) => a - b2);
    for (const [k, v] of Object.entries(pedidas)) {
      if (!recetados.includes(Number(k))) throw new HttpError(400, `El medicamento ${k} no está en la receta`);
      if (!Number.isInteger(v) || v < 1 || v > MAX_UNIDADES) throw new HttpError(400, `Las unidades deben ser un número entero de 1 a ${MAX_UNIDADES}`);
    }

    // 1. Bloquear y revisar existencias de todos antes de tocar nada
    const plan = [];
    const faltantes = [];
    for (const medId of recetados) {
      const [[med]] = await conn.query('SELECT id, nombre, stock_actual, controlado, psicotropico FROM medicamentos WHERE id = ? FOR UPDATE', [medId]);
      if (!med) throw new HttpError(404, `Medicamento ${medId} no encontrado`);
      const [lotes] = await conn.query(
        `SELECT id, cantidad_disponible FROM lotes
         WHERE medicamento_id = ? AND activo = 1 AND cantidad_disponible > 0 AND fecha_caducidad >= DATE(${AHORA_MX})
         ORDER BY fecha_caducidad ASC, id ASC FOR UPDATE`, [medId]);
      const unidades = pedidas[medId] || 1;
      const disponible = lotes.reduce((s, l) => s + Number(l.cantidad_disponible), 0);
      if (disponible < unidades) faltantes.push(`${med.nombre} (disponible: ${disponible}, se necesitan: ${unidades})`);
      plan.push({ med, lotes, unidades });
    }
    if (faltantes.length) throw new HttpError(409, `Sin stock suficiente de ${faltantes.join('; ')}`, 'SIN_STOCK');

    // 2. Descuento FEFO, un movimiento de salida por lote (cantidad negativa, como la web)
    const resultado = [];
    let controlado = false;
    for (const { med, lotes, unidades } of plan) {
      let restante = unidades;
      let stock = Number(med.stock_actual);
      const movimientos = [];
      for (const lote of lotes) {
        if (restante <= 0) break;
        const descontar = Math.min(Number(lote.cantidad_disponible), restante);
        await conn.query('UPDATE lotes SET cantidad_disponible = cantidad_disponible - ?, updated_at = NOW() WHERE id = ?', [descontar, lote.id]);
        const [mv] = await conn.query(
          `INSERT INTO movimientos_inventario (medicamento_id, lote_id, user_id, tipo, cantidad, stock_anterior, stock_nuevo, referencia_tipo, referencia_id, motivo, created_at, updated_at)
           VALUES (?,?,?,'salida',?,?,?,'consulta',?,'Dispensación de receta',NOW(),NOW())`,
          [med.id, lote.id, req.user.id, -descontar, stock, stock - descontar, id]);
        movimientos.push({ id: mv.insertId, loteId: lote.id, cantidad: descontar });
        stock -= descontar;
        restante -= descontar;
      }
      await conn.query('UPDATE medicamentos SET stock_actual = stock_actual - ?, updated_at = NOW() WHERE id = ?', [unidades, med.id]);
      if (Number(med.controlado) === 1 || Number(med.psicotropico) === 1) controlado = true;
      resultado.push({ medicamentoId: med.id, medicamento: med.nombre, unidades, stockAnterior: Number(med.stock_actual), stockNuevo: stock, movimientos });
    }

    // 3. Marcar la receta como dispensada
    await conn.query(
      `UPDATE consultas SET dispensada = 1, dispensada_en = ${AHORA_MX}, dispensada_por = ?, notas_dispensacion = ?, updated_at = NOW() WHERE id = ?`,
      [req.user.id, notas || null, id]);
    await audit(req, {
      evento: 'dispensada', modulo: 'dispensaciones', tipo: 'consulta', id, sensible: 1, severidad: controlado ? 'warning' : 'info',
      descripcion: `Receta #${id} dispensada: ${resultado.map((r) => `${r.medicamento} x${r.unidades}`).join(', ') || 'receta libre'}`,
      antes: { dispensada: false }, despues: { dispensada: true, medicamentos: resultado.map((r) => ({ id: r.medicamentoId, unidades: r.unidades })) },
    }, conn);
    await conn.commit();
    res.json({ id, dispensada: true, medicamentos: resultado });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

// POST /api/farmacia/recetas/:id/revertir  (solo administrador)
// Devuelve a cada lote lo que la dispensación le quitó. Se calcula el saldo de los movimientos de la receta
// (salidas negativas y entradas de reversiones anteriores), así una receta dispensada y revertida varias veces
// nunca devuelve dos veces lo mismo. A diferencia de la web, también repone medicamentos.stock_actual.
router.post('/:id/revertir', auth, SOLO_ADMIN, ah(async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) throw new HttpError(400, 'id inválido');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const c = await recetaBloqueada(conn, id);
    if (Number(c.dispensada) !== 1) throw new HttpError(409, 'Esta receta no ha sido dispensada', 'NO_DISPENSADA');

    const [saldos] = await conn.query(
      `SELECT medicamento_id, lote_id, -SUM(cantidad) AS pendiente FROM movimientos_inventario
       WHERE referencia_tipo = 'consulta' AND referencia_id = ? AND tipo IN ('salida', 'entrada') AND lote_id IS NOT NULL
       GROUP BY medicamento_id, lote_id HAVING pendiente > 0 ORDER BY medicamento_id, lote_id`, [id]);
    const porMed = new Map();
    for (const s of saldos) {
      const k = Number(s.medicamento_id);
      if (!porMed.has(k)) porMed.set(k, []);
      porMed.get(k).push({ loteId: Number(s.lote_id), cantidad: Number(s.pendiente) });
    }

    const devueltos = [];
    for (const [medId, lotes] of porMed) {
      const [[med]] = await conn.query('SELECT id, nombre, stock_actual FROM medicamentos WHERE id = ? FOR UPDATE', [medId]);
      if (!med) continue;
      let stock = Number(med.stock_actual);
      let total = 0;
      for (const l of lotes) {
        await conn.query('UPDATE lotes SET cantidad_disponible = cantidad_disponible + ?, updated_at = NOW() WHERE id = ?', [l.cantidad, l.loteId]);
        await conn.query(
          `INSERT INTO movimientos_inventario (medicamento_id, lote_id, user_id, tipo, cantidad, stock_anterior, stock_nuevo, referencia_tipo, referencia_id, motivo, created_at, updated_at)
           VALUES (?,?,?,'entrada',?,?,?,'consulta',?,?,NOW(),NOW())`,
          [medId, l.loteId, req.user.id, l.cantidad, stock, stock + l.cantidad, id, `Reversión de dispensación (Receta #${id})`]);
        stock += l.cantidad;
        total += l.cantidad;
      }
      await conn.query('UPDATE medicamentos SET stock_actual = stock_actual + ?, updated_at = NOW() WHERE id = ?', [total, medId]);
      devueltos.push({ medicamentoId: medId, medicamento: med.nombre, unidades: total, stockNuevo: stock });
    }

    await conn.query('UPDATE consultas SET dispensada = 0, dispensada_en = NULL, dispensada_por = NULL, updated_at = NOW() WHERE id = ?', [id]);
    await audit(req, {
      evento: 'dispensacion_revertida', modulo: 'dispensaciones', tipo: 'consulta', id, sensible: 1, severidad: 'warning',
      descripcion: `Dispensación de la receta #${id} revertida`,
      antes: { dispensada: true }, despues: { dispensada: false, devueltos: devueltos.map((d) => ({ id: d.medicamentoId, unidades: d.unidades })) },
    }, conn);
    await conn.commit();
    res.json({ id, dispensada: false, devueltos });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

module.exports = router;
