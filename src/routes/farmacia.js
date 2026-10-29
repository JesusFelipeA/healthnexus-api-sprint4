const router = require('express').Router();
const pool = require('../db');
const { ah, HttpError, auth, roles, audit } = require('../middleware');

const VER_EXISTENCIAS = roles('farmacia', 'enfermeria', 'medico');
const TIPOS = ['entrada', 'salida', 'ajuste', 'devolucion'];

function paging(req, max = 200) {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), max);
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  return { limit, page, offset: (page - 1) * limit };
}

// GET /api/farmacia/resumen  -> contadores para el dashboard de farmacia
router.get('/resumen', auth, roles('farmacia'), ah(async (req, res) => {
  const [[r]] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM medicamentos WHERE activo = 1) AS totalMedicamentos,
       (SELECT COUNT(*) FROM medicamentos WHERE activo = 1 AND stock_actual > 0 AND stock_actual <= stock_minimo) AS stockBajo,
       (SELECT COUNT(*) FROM medicamentos WHERE activo = 1 AND stock_actual = 0) AS sinStock,
       (SELECT COUNT(*) FROM lotes WHERE activo = 1 AND cantidad_disponible > 0 AND fecha_caducidad BETWEEN CURDATE() AND CURDATE() + INTERVAL 30 DAY) AS lotesPorCaducar,
       (SELECT COUNT(*) FROM lotes WHERE activo = 1 AND cantidad_disponible > 0 AND fecha_caducidad < CURDATE()) AS lotesCaducados`);
  res.json(r);
}));

// GET /api/farmacia/medicamentos?q=&estado=bajo|sin_stock&page=&limit=
router.get('/medicamentos', auth, roles('farmacia'), ah(async (req, res) => {
  const where = ['activo = 1']; const params = [];
  if (req.query.q) { where.push('(nombre LIKE ? OR sustancia_activa LIKE ? OR codigo_barras LIKE ?)'); const q = `%${req.query.q}%`; params.push(q, q, q); }
  if (req.query.estado === 'sin_stock') where.push('stock_actual = 0');
  if (req.query.estado === 'bajo') where.push('stock_actual > 0 AND stock_actual <= stock_minimo');
  const { limit, page, offset } = paging(req);
  const w = `WHERE ${where.join(' AND ')}`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM medicamentos ${w}`, params);
  const [rows] = await pool.query(
    `SELECT id, nombre, sustancia_activa AS sustancia, presentacion, concentracion, grupo_terapeutico AS grupo,
            controlado, antibiotico, psicotropico, unidad_medida AS unidad,
            stock_actual AS stock, stock_minimo AS stockMinimo, stock_maximo AS stockMaximo, precio_venta AS precioVenta,
            CASE WHEN stock_actual = 0 THEN 'sin_stock' WHEN stock_actual <= stock_minimo THEN 'bajo' ELSE 'ok' END AS estado
     FROM medicamentos ${w} ORDER BY nombre LIMIT ? OFFSET ?`, [...params, limit, offset]);
  res.json({ total, page, limit, data: rows });
}));

// GET /api/farmacia/catalogo?q=  -> lista corta para elegir un medicamento (sin precios)
router.get('/catalogo', auth, VER_EXISTENCIAS, ah(async (req, res) => {
  const params = []; let w = 'WHERE activo = 1';
  if (req.query.q) { w += ' AND (nombre LIKE ? OR sustancia_activa LIKE ?)'; params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const [rows] = await pool.query(
    `SELECT id, nombre, presentacion, concentracion, via_administracion AS via, stock_actual AS stock, controlado
     FROM medicamentos ${w} ORDER BY nombre LIMIT 500`, params);
  res.json(rows);
}));

// GET /api/farmacia/existencias?q=&caduca=vencidos|<días>&todos=1
router.get('/existencias', auth, VER_EXISTENCIAS, ah(async (req, res) => {
  const where = ['l.activo = 1']; const params = [];
  if (req.query.todos !== '1') where.push('l.cantidad_disponible > 0');
  if (req.query.q) { where.push('(m.nombre LIKE ? OR l.codigo_lote LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  if (req.query.caduca === 'vencidos') where.push('l.fecha_caducidad < CURDATE()');
  else if (req.query.caduca) {
    const d = parseInt(req.query.caduca);
    if (!(d >= 1 && d <= 365)) throw new HttpError(400, "caduca debe ser 'vencidos' o un número de días (1 a 365)");
    where.push('l.fecha_caducidad BETWEEN CURDATE() AND CURDATE() + INTERVAL ? DAY'); params.push(d);
  }
  const { limit, page, offset } = paging(req);
  const w = `WHERE ${where.join(' AND ')}`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM lotes l JOIN medicamentos m ON m.id = l.medicamento_id ${w}`, params);
  const [rows] = await pool.query(
    `SELECT l.id, l.medicamento_id AS medicamentoId, m.nombre AS medicamento, m.presentacion, l.codigo_lote AS lote,
            l.fecha_caducidad AS caducidad, DATEDIFF(l.fecha_caducidad, CURDATE()) AS diasParaCaducar,
            l.cantidad_disponible AS disponible, l.cantidad_inicial AS inicial, l.proveedor
     FROM lotes l JOIN medicamentos m ON m.id = l.medicamento_id ${w}
     ORDER BY l.fecha_caducidad ASC, l.id ASC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  res.json({ total, page, limit, data: rows });
}));

// GET /api/farmacia/movimientos?tipo=&q=&page=
router.get('/movimientos', auth, roles('farmacia', 'enfermeria'), ah(async (req, res) => {
  const where = []; const params = [];
  if (TIPOS.includes(req.query.tipo)) { where.push('mv.tipo = ?'); params.push(req.query.tipo); }
  if (req.query.q) { where.push('m.nombre LIKE ?'); params.push(`%${req.query.q}%`); }
  const { limit, page, offset } = paging(req);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM movimientos_inventario mv JOIN medicamentos m ON m.id = mv.medicamento_id ${w}`, params);
  const [rows] = await pool.query(
    `SELECT mv.id, mv.tipo, mv.cantidad, mv.stock_anterior AS stockAnterior, mv.stock_nuevo AS stockNuevo,
            m.nombre AS medicamento, l.codigo_lote AS lote, u.name AS usuario, mv.motivo, mv.created_at AS fecha
     FROM movimientos_inventario mv
     JOIN medicamentos m ON m.id = mv.medicamento_id
     LEFT JOIN lotes l ON l.id = mv.lote_id
     LEFT JOIN users u ON u.id = mv.user_id
     ${w} ORDER BY mv.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  res.json({ total, page, limit, data: rows });
}));

// POST /api/farmacia/movimientos  { loteId, tipo, cantidad, motivo }
//   entrada / devolucion: suman · salida: resta · ajuste: "cantidad" es la nueva cantidad del lote
router.post('/movimientos', auth, roles('farmacia'), ah(async (req, res) => {
  const { loteId, tipo, motivo } = req.body || {};
  const cantidad = Number(req.body && req.body.cantidad);
  if (!loteId) throw new HttpError(400, 'loteId es obligatorio');
  if (!TIPOS.includes(tipo)) throw new HttpError(400, `tipo inválido. Usa: ${TIPOS.join(', ')}`);
  if (!Number.isInteger(cantidad) || cantidad < (tipo === 'ajuste' ? 0 : 1) || cantidad > 1000000) throw new HttpError(400, 'Cantidad inválida (número entero)');
  if ((tipo === 'salida' || tipo === 'ajuste') && String(motivo || '').trim().length < 3) throw new HttpError(400, 'El motivo es obligatorio para salidas y ajustes');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[lote]] = await conn.query('SELECT id, medicamento_id, cantidad_disponible, fecha_caducidad FROM lotes WHERE id = ? AND activo = 1 FOR UPDATE', [loteId]);
    if (!lote) throw new HttpError(404, 'Lote no encontrado');
    const [[med]] = await conn.query('SELECT id, nombre, stock_actual, controlado, psicotropico FROM medicamentos WHERE id = ? FOR UPDATE', [lote.medicamento_id]);

    const caducado = new Date(`${lote.fecha_caducidad}T23:59:59`) < new Date();
    if (caducado && (tipo === 'entrada' || tipo === 'devolucion')) throw new HttpError(409, 'El lote está caducado: no puede recibir entradas');

    let delta;
    if (tipo === 'entrada' || tipo === 'devolucion') delta = cantidad;
    else if (tipo === 'salida') {
      if (cantidad > lote.cantidad_disponible) throw new HttpError(409, `Solo hay ${lote.cantidad_disponible} unidades disponibles en el lote`);
      delta = -cantidad;
    } else delta = cantidad - lote.cantidad_disponible;
    if (delta === 0) throw new HttpError(400, 'El ajuste no cambia la cantidad del lote');

    const nuevoStock = med.stock_actual + delta;
    await conn.query('UPDATE lotes SET cantidad_disponible = cantidad_disponible + ?, updated_at = NOW() WHERE id = ?', [delta, lote.id]);
    await conn.query('UPDATE medicamentos SET stock_actual = stock_actual + ?, updated_at = NOW() WHERE id = ?', [delta, med.id]);
    const [r] = await conn.query(
      `INSERT INTO movimientos_inventario (medicamento_id, lote_id, user_id, tipo, cantidad, stock_anterior, stock_nuevo, referencia_tipo, motivo, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,'app_movil',?,NOW(),NOW())`,
      [med.id, lote.id, req.user.id, tipo, Math.abs(delta), med.stock_actual, nuevoStock, motivo ? String(motivo).trim() : null]);
    const controlado = med.controlado === 1 || med.psicotropico === 1;
    await audit(req, {
      evento: tipo, modulo: 'farmacia', descripcion: `${tipo} de ${Math.abs(delta)} u. de ${med.nombre}`, tipo: 'movimiento_inventario', id: r.insertId,
      antes: { stock: med.stock_actual, lote: lote.cantidad_disponible }, despues: { stock: nuevoStock, lote: lote.cantidad_disponible + delta },
      severidad: controlado ? 'warning' : 'info',
    }, conn);
    await conn.commit();
    res.status(201).json({ id: r.insertId, tipo, medicamento: med.nombre, stockAnterior: med.stock_actual, stockNuevo: nuevoStock, cantidadLote: lote.cantidad_disponible + delta });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

// GET /api/farmacia/alertas  -> stock y caducidad (se calculan al momento)
router.get('/alertas', auth, roles('farmacia'), ah(async (req, res) => {
  const [sin] = await pool.query("SELECT id, nombre, stock_minimo FROM medicamentos WHERE activo = 1 AND stock_actual = 0 ORDER BY nombre LIMIT 100");
  const [bajo] = await pool.query("SELECT id, nombre, stock_actual, stock_minimo FROM medicamentos WHERE activo = 1 AND stock_actual > 0 AND stock_actual <= stock_minimo ORDER BY stock_actual / GREATEST(stock_minimo,1) LIMIT 100");
  const lotes = (cond) => pool.query(
    `SELECT l.id, m.nombre, l.codigo_lote, l.fecha_caducidad, l.cantidad_disponible, DATEDIFF(l.fecha_caducidad, CURDATE()) AS dias
     FROM lotes l JOIN medicamentos m ON m.id = l.medicamento_id
     WHERE l.activo = 1 AND l.cantidad_disponible > 0 AND ${cond} ORDER BY l.fecha_caducidad LIMIT 100`);
  const [cad] = await lotes('l.fecha_caducidad < CURDATE()');
  const [por] = await lotes('l.fecha_caducidad BETWEEN CURDATE() AND CURDATE() + INTERVAL 30 DAY');

  const data = [
    ...sin.map((m) => ({ tipo: 'sin_stock', nivel: 'critico', medicamento: m.nombre, detalle: 'Sin existencias', medicamentoId: m.id })),
    ...cad.map((l) => ({ tipo: 'caducado', nivel: 'critico', medicamento: l.nombre, detalle: `Lote ${l.codigo_lote} caducado (${l.cantidad_disponible} u.)`, loteId: l.id, fecha: l.fecha_caducidad })),
    ...bajo.map((m) => ({ tipo: 'stock_bajo', nivel: 'advertencia', medicamento: m.nombre, detalle: `Stock ${m.stock_actual} (mínimo ${m.stock_minimo})`, medicamentoId: m.id })),
    ...por.map((l) => ({ tipo: 'por_caducar', nivel: 'advertencia', medicamento: l.nombre, detalle: `Lote ${l.codigo_lote} caduca en ${l.dias} días (${l.cantidad_disponible} u.)`, loteId: l.id, fecha: l.fecha_caducidad })),
  ];
  res.json({ total: data.length, data });
}));

module.exports = router;
