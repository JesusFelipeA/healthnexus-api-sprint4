const router = require('express').Router();
const pool = require('../db');
const { ah, HttpError, auth, roles, audit, paginar } = require('../middleware');
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
            sv.motivo_consulta AS motivo, sv.notas, u.name AS registradoPor, sv.created_at AS fecha
     FROM signos_vitales sv
     JOIN pacientes p ON p.id = sv.paciente_id
     LEFT JOIN users u ON u.id = sv.user_id
     ${w} ORDER BY sv.id DESC LIMIT ?`, [...params, limit]);
  res.json(rows);
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
  await pacienteActivo(b.pacienteId);

  const [r] = await pool.query(
    `INSERT INTO signos_vitales (paciente_id, user_id, temperatura, frecuencia_cardiaca, frecuencia_respiratoria, presion_arterial,
       saturacion_oxigeno, glucosa, peso, talla, escala_dolor, triage, triage_manual, motivo_consulta, notas, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
    [b.pacienteId, req.user.id, v.temperatura, v.fc, v.fr, presion, v.spo2, v.glucosa, v.peso, v.talla, v.dolor,
     triage, triage ? 1 : 0, b.motivoConsulta ? String(b.motivoConsulta).trim() : null, b.notas ? String(b.notas).trim() : null]);
  await audit(req, { evento: 'created', modulo: 'signos_vitales', descripcion: 'Signos vitales registrados', tipo: 'signos_vitales', id: r.insertId, sensible: 1 });
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

// POST /api/enfermeria/administraciones  { pacienteId, medicamentoId, dosis, via?, observaciones?, reaccionAdversa? }
router.post('/administraciones', auth, roles('enfermeria'), ah(async (req, res) => {
  const b = req.body || {};
  if (!b.pacienteId || !b.medicamentoId) throw new HttpError(400, 'pacienteId y medicamentoId son obligatorios');
  const dosis = String(b.dosis || '').trim();
  if (!dosis) throw new HttpError(400, 'La dosis es obligatoria');
  await pacienteActivo(b.pacienteId);
  const [[med]] = await pool.query('SELECT id, nombre, via_administracion FROM medicamentos WHERE id = ? AND activo = 1', [b.medicamentoId]);
  if (!med) throw new HttpError(404, 'Medicamento no encontrado');
  const via = String(b.via || med.via_administracion || '').trim();
  if (!via) throw new HttpError(400, 'La vía de administración es obligatoria');
  const reaccion = b.reaccionAdversa ? 1 : 0;

  const [r] = await pool.query(
    `INSERT INTO administraciones_medicamento (paciente_id, medicamento_id, user_id, dosis, via, administrado_en, reaccion_adversa, observaciones, created_at, updated_at)
     VALUES (?,?,?,?,?,${AHORA_MX},?,?,NOW(),NOW())`,
    [b.pacienteId, med.id, req.user.id, dosis, via, reaccion, b.observaciones ? String(b.observaciones).trim() : null]);
  await audit(req, { evento: 'created', modulo: 'administraciones', descripcion: `Administración de ${med.nombre} (${dosis})${reaccion ? ' con reacción adversa' : ''}`, tipo: 'administracion_medicamento', id: r.insertId, severidad: reaccion ? 'warning' : 'info', sensible: 1 });
  res.status(201).json({ id: r.insertId, medicamento: med.nombre });
}));

module.exports = router;
