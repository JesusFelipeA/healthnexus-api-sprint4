const router = require('express').Router();
const pool = require('../db');
const { ah, HttpError, auth, roles, audit, paginar, idValido } = require('../middleware');
const { AHORA_MX } = require('../hora');

const NIVELES = ['rojo', 'naranja', 'amarillo', 'verde', 'azul'];
const LEER = roles('enfermeria', 'medico');

// Convierte un valor opcional a número dentro de un rango (o null si no viene)
function num(body, key, label, min, max, { int = false } = {}) {
  const v = body[key];
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw new HttpError(400, `${label} fuera de rango (${min} a ${max})`);
  return n;
}

/* ---------------- MODO SIN CONEXIÓN (fase 1: signos vitales) ----------------
   El teléfono o el navegador guardan el registro en una cola cuando no hay conexión y lo envían al reconectar con:
     clientUuid   identificador único que generan ellos; si el mismo registro llega dos veces (reintento), no se duplica
     capturadoEn  hora real de la toma (ISO 8601); se acepta hasta MAX_ATRASO_HORAS después
   Respuestas: 201 creado · 200 { duplicado: true } si ya se había recibido · 409 si ese clientUuid es de otra cuenta. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ATRASO_HORAS = 72;
const TOLERANCIA_RELOJ_MS = 5 * 60 * 1000;

function datosSinConexion(b) {
  if (b.clientUuid === undefined && b.capturadoEn === undefined) return null;
  const clientUuid = String(b.clientUuid || '').trim().toLowerCase();
  if (!UUID.test(clientUuid)) throw new HttpError(400, 'clientUuid inválido');
  if (b.capturadoEn === undefined || b.capturadoEn === null || b.capturadoEn === '') return { clientUuid, capturadoEn: null };
  const t = new Date(b.capturadoEn);
  if (Number.isNaN(t.getTime()) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(b.capturadoEn))) {
    throw new HttpError(400, 'capturadoEn debe ser una fecha ISO 8601 con zona horaria');
  }
  const ahora = Date.now();
  if (t.getTime() > ahora + TOLERANCIA_RELOJ_MS) throw new HttpError(400, 'La hora de captura no puede estar en el futuro');
  if (t.getTime() < ahora - MAX_ATRASO_HORAS * 3600 * 1000) {
    throw new HttpError(400, `El registro tiene más de ${MAX_ATRASO_HORAS} horas sin enviarse; captúralo de nuevo en la web`);
  }
  return { clientUuid, capturadoEn: t };
}

// DATETIME en hora local de México (UTC-6, sin horario de verano), igual que AHORA_MX y que Laravel
const fechaMx = (d) => new Date(d.getTime() - 6 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

// Si el clientUuid ya existe: 200 con el mismo id (reintento) o 409 si lo envió otra cuenta
async function yaRecibido(req, res, clientUuid) {
  const [[prev]] = await pool.query('SELECT id, user_id FROM signos_vitales WHERE client_uuid = ?', [clientUuid]);
  if (!prev) return false;
  if (Number(prev.user_id) !== Number(req.user.id)) throw new HttpError(409, 'Ese registro ya fue enviado desde otra cuenta');
  res.status(200).json({ id: prev.id, duplicado: true });
  return true;
}

async function pacienteActivo(id) {
  const [[p]] = await pool.query('SELECT id FROM pacientes WHERE id = ? AND activo = 1', [id]);
  if (!p) throw new HttpError(404, 'Paciente no encontrado');
}

/* ---------------- SIGNOS VITALES ---------------- */

// GET /api/enfermeria/signos?pacienteId=&limit=
router.get('/signos', auth, LEER, ah(async (req, res) => {
  const params = []; let w = '';
  if (req.query.pacienteId) { w = 'WHERE sv.paciente_id = ?'; params.push(Number(req.query.pacienteId)); }
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const [rows] = await pool.query(
    `SELECT sv.id, sv.paciente_id AS pacienteId, CONCAT_WS(' ', p.nombre, p.apellido_paterno, p.apellido_materno) AS paciente,
            sv.temperatura, sv.frecuencia_cardiaca AS fc, sv.frecuencia_respiratoria AS fr, sv.presion_arterial AS presion,
            sv.saturacion_oxigeno AS spo2, sv.glucosa, sv.peso, sv.talla, sv.escala_dolor AS dolor, sv.triage,
            sv.motivo_consulta AS motivo, sv.notas, u.name AS registradoPor,
            COALESCE(sv.capturado_en, sv.created_at) AS fecha, sv.sin_conexion AS sinConexion
     FROM signos_vitales sv
     JOIN pacientes p ON p.id = sv.paciente_id
     LEFT JOIN users u ON u.id = sv.user_id
     ${w} ORDER BY COALESCE(sv.capturado_en, sv.created_at) DESC, sv.id DESC LIMIT ?`, [...params, limit]);
  res.json(rows.map((r) => ({ ...r, sinConexion: !!r.sinConexion })));
}));

// POST /api/enfermeria/signos  (todos los valores son opcionales, pero debe venir al menos uno)
router.post('/signos', auth, roles('enfermeria'), ah(async (req, res) => {
  const b = req.body || {};
  if (!b.pacienteId) throw new HttpError(400, 'pacienteId es obligatorio');
  const v = {
    temperatura: num(b, 'temperatura', 'Temperatura', 25, 45),
    fc: num(b, 'frecuenciaCardiaca', 'Frecuencia cardiaca', 10, 300, { int: true }),
    fr: num(b, 'frecuenciaRespiratoria', 'Frecuencia respiratoria', 3, 100, { int: true }),
    spo2: num(b, 'saturacionOxigeno', 'Saturación de oxígeno', 30, 100, { int: true }),
    glucosa: num(b, 'glucosa', 'Glucosa', 10, 1500, { int: true }),
    peso: num(b, 'peso', 'Peso', 0.3, 500),
    talla: num(b, 'talla', 'Talla', 0.2, 2.6),
    dolor: num(b, 'escalaDolor', 'Escala de dolor', 0, 10, { int: true }),
  };
  const presion = b.presionArterial ? String(b.presionArterial).trim() : null;
  if (presion && !/^\d{2,3}\/\d{2,3}$/.test(presion)) throw new HttpError(400, "Presión arterial inválida. Usa el formato 120/80");
  if (!presion && Object.values(v).every((x) => x === null)) throw new HttpError(400, 'Registra al menos un signo vital');
  let triage = null;
  if (b.triage) { triage = String(b.triage).toLowerCase(); if (!NIVELES.includes(triage)) throw new HttpError(400, `triage inválido. Usa: ${NIVELES.join(', ')}`); }
  const offline = datosSinConexion(b);
  if (offline && await yaRecibido(req, res, offline.clientUuid)) return;
  await pacienteActivo(b.pacienteId);

  // Los capturados sin conexión llevan como fecha de registro la hora real de la toma (así quedan en orden en
  // la web, que ordena por created_at); updated_at y la bitácora guardan cuándo llegaron.
  const capturado = offline && offline.capturadoEn ? fechaMx(offline.capturadoEn) : null;
  let r;
  try {
    [r] = await pool.query(
      `INSERT INTO signos_vitales (paciente_id, user_id, client_uuid, temperatura, frecuencia_cardiaca, frecuencia_respiratoria, presion_arterial,
         saturacion_oxigeno, glucosa, peso, talla, escala_dolor, triage, triage_manual, motivo_consulta, notas,
         capturado_en, sin_conexion, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,${capturado ? '?' : AHORA_MX},${AHORA_MX})`,
      [b.pacienteId, req.user.id, offline ? offline.clientUuid : null, v.temperatura, v.fc, v.fr, presion, v.spo2, v.glucosa, v.peso, v.talla, v.dolor,
       triage, triage ? 1 : 0, b.motivoConsulta ? String(b.motivoConsulta).trim() : null, b.notas ? String(b.notas).trim() : null,
       capturado, capturado ? 1 : 0, ...(capturado ? [capturado] : [])]);
  } catch (e) {
    // Dos envíos simultáneos del mismo registro: el segundo choca con el índice único y responde como reintento
    if (e && e.code === 'ER_DUP_ENTRY' && offline && await yaRecibido(req, res, offline.clientUuid)) return;
    throw e;
  }
  const descripcion = offline && offline.capturadoEn
    ? `Signos vitales capturados sin conexión el ${fechaMx(offline.capturadoEn)} y sincronizados`
    : 'Signos vitales registrados';
  await audit(req, { evento: 'created', modulo: 'signos_vitales', descripcion, tipo: 'signos_vitales', id: r.insertId, sensible: 1 });
  res.status(201).json({ id: r.insertId });
}));

/* ---------------- ADMINISTRACIÓN DE MEDICAMENTOS ---------------- */

// GET /api/enfermeria/administraciones?pacienteId=&limit=&page=  (total en la cabecera X-Total-Count)
router.get('/administraciones', auth, LEER, ah(async (req, res) => {
  const params = []; let w = '';
  if (req.query.pacienteId) { w = 'WHERE a.paciente_id = ?'; params.push(Number(req.query.pacienteId)); }
  const { limit, offset } = paginar(req, { def: 50, max: 200 });
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM administraciones_medicamento a ${w}`, params);
  const [rows] = await pool.query(
    `SELECT a.id, a.paciente_id AS pacienteId, CONCAT_WS(' ', p.nombre, p.apellido_paterno, p.apellido_materno) AS paciente,
            m.nombre AS medicamento, a.dosis, a.via, a.administrado_en AS fecha, a.reaccion_adversa AS reaccionAdversa,
            a.observaciones, u.name AS administradoPor
     FROM administraciones_medicamento a
     JOIN pacientes p ON p.id = a.paciente_id
     JOIN medicamentos m ON m.id = a.medicamento_id
     LEFT JOIN users u ON u.id = a.user_id
     ${w} ORDER BY a.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  res.set('X-Total-Count', String(total)).json(rows);
}));

// POST /api/enfermeria/administraciones  { pacienteId, medicamentoId, dosis, via?, unidades?, observaciones?, reaccionAdversa? }
// Igual que la web (AdministracionMedicamentoController + InventarioService::salida), en una sola transacción:
//   1. el paciente debe estar hospitalizado (cama activa); el administrador queda exento, como en la web;
//   2. descuenta las unidades de los lotes vigentes que caducan primero (FEFO) y del stock del medicamento;
//   3. registra un movimiento de salida por lote (cantidad negativa, como la web), la nota de enfermería
//      en el seguimiento y la administración enlazada a esa nota.
// Las filas del medicamento y de sus lotes se bloquean (FOR UPDATE): dos administraciones al mismo tiempo
// nunca dejan el stock en negativo.
const TEXTO = (v, max) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max + 1));
router.post('/administraciones', auth, roles('enfermeria'), ah(async (req, res) => {
  const b = req.body || {};
  const pacienteId = idValido(b.pacienteId);
  const medicamentoId = idValido(b.medicamentoId);
  if (!pacienteId || !medicamentoId) throw new HttpError(400, 'pacienteId y medicamentoId son obligatorios (números)');
  const dosis = TEXTO(b.dosis, 50);
  if (!dosis) throw new HttpError(400, 'La dosis es obligatoria');
  if (dosis.length > 50) throw new HttpError(400, 'La dosis no puede superar 50 caracteres');
  const unidades = b.unidades === undefined || b.unidades === null || b.unidades === '' ? 1 : Number(b.unidades);
  if (!Number.isInteger(unidades) || unidades < 1 || unidades > 20) throw new HttpError(400, 'Las unidades deben ser un número entero de 1 a 20');
  const observaciones = TEXTO(b.observaciones, 1000);
  if (observaciones.length > 1000) throw new HttpError(400, 'Las observaciones no pueden superar 1000 caracteres');
  const reaccion = b.reaccionAdversa === true || b.reaccionAdversa === 1 || b.reaccionAdversa === '1' ? 1 : 0;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[pac]] = await conn.query('SELECT id FROM pacientes WHERE id = ? AND activo = 1', [pacienteId]);
    if (!pac) throw new HttpError(404, 'Paciente no encontrado');
    const [[cama]] = await conn.query('SELECT cama_id FROM cama_paciente WHERE paciente_id = ? AND activa = 1 ORDER BY id DESC LIMIT 1', [pacienteId]);
    if (!cama && req.user.rol !== 'administrador') throw new HttpError(409, 'El paciente no está hospitalizado', 'NO_HOSPITALIZADO');

    const [[med]] = await conn.query('SELECT id, nombre, concentracion, via_administracion, stock_actual, controlado, psicotropico FROM medicamentos WHERE id = ? AND activo = 1 FOR UPDATE', [medicamentoId]);
    if (!med) throw new HttpError(404, 'Medicamento no encontrado');
    const via = TEXTO(b.via, 50) || TEXTO(med.via_administracion, 50);
    if (!via) throw new HttpError(400, 'La vía de administración es obligatoria');
    if (via.length > 50) throw new HttpError(400, 'La vía no puede superar 50 caracteres');

    const [lotes] = await conn.query(
      `SELECT id, cantidad_disponible FROM lotes
       WHERE medicamento_id = ? AND activo = 1 AND cantidad_disponible > 0 AND fecha_caducidad >= DATE(${AHORA_MX})
       ORDER BY fecha_caducidad ASC, id ASC FOR UPDATE`, [med.id]);
    const disponible = lotes.reduce((s, l) => s + Number(l.cantidad_disponible), 0);
    if (disponible < unidades) {
      throw new HttpError(409, `Sin stock suficiente de ${med.nombre}. Disponible: ${disponible}`, 'SIN_STOCK');
    }

    // Nota de enfermería (mismo texto que la web)
    const nombreMed = med.concentracion ? `${med.nombre} (${med.concentracion})` : med.nombre;
    const contenido = `Se administró ${nombreMed}. Dosis: ${dosis}. Vía: ${via}.${observaciones ? ` ${observaciones}` : ''}`;
    const [nota] = await conn.query(
      `INSERT INTO seguimientos (paciente_id, user_id, cama_id, tipo, contenido, estado_paciente, created_at, updated_at)
       VALUES (?,?,?,'nota_enfermeria',?,'estable',NOW(),NOW())`,
      [pacienteId, req.user.id, cama ? cama.cama_id : null, contenido]);

    // Descuento FEFO
    let restante = unidades;
    let stock = Number(med.stock_actual);
    const movimientos = [];
    for (const lote of lotes) {
      if (restante <= 0) break;
      const descontar = Math.min(Number(lote.cantidad_disponible), restante);
      await conn.query('UPDATE lotes SET cantidad_disponible = cantidad_disponible - ?, updated_at = NOW() WHERE id = ?', [descontar, lote.id]);
      const [mv] = await conn.query(
        `INSERT INTO movimientos_inventario (medicamento_id, lote_id, user_id, tipo, cantidad, stock_anterior, stock_nuevo, referencia_tipo, referencia_id, motivo, created_at, updated_at)
         VALUES (?,?,?,'salida',?,?,?,'nota_enfermeria',?,?,NOW(),NOW())`,
        [med.id, lote.id, req.user.id, -descontar, stock, stock - descontar, nota.insertId, `Administración de enfermería: ${dosis} vía ${via}`]);
      movimientos.push({ id: mv.insertId, loteId: lote.id, cantidad: descontar });
      stock -= descontar;
      restante -= descontar;
    }
    await conn.query('UPDATE medicamentos SET stock_actual = stock_actual - ?, updated_at = NOW() WHERE id = ?', [unidades, med.id]);

    const [r] = await conn.query(
      `INSERT INTO administraciones_medicamento (paciente_id, medicamento_id, user_id, seguimiento_id, dosis, via, administrado_en, reaccion_adversa, observaciones, created_at, updated_at)
       VALUES (?,?,?,?,?,?,${AHORA_MX},?,?,NOW(),NOW())`,
      [pacienteId, med.id, req.user.id, nota.insertId, dosis, via, reaccion, observaciones || null]);
    const controlado = med.controlado === 1 || med.psicotropico === 1;
    await audit(req, {
      evento: 'created', modulo: 'administraciones', tipo: 'administracion_medicamento', id: r.insertId, sensible: 1,
      descripcion: `Administración de ${med.nombre} (${dosis})${reaccion ? ' con reacción adversa' : ''}: -${unidades} u. de inventario`,
      antes: { stock: Number(med.stock_actual) }, despues: { stock, lotes: movimientos.map((m) => m.loteId) },
      severidad: reaccion || controlado ? 'warning' : 'info',
    }, conn);
    await conn.commit();
    res.status(201).json({
      id: r.insertId, medicamento: med.nombre, notaId: nota.insertId, unidades,
      stockAnterior: Number(med.stock_actual), stockNuevo: stock, movimientos,
    });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

module.exports = router;
