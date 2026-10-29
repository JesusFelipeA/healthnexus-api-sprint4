const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { ah, HttpError, auth, roles, audit, leerCoordenadas, idValido } = require('../middleware');
const { notificarRoles } = require('../push');
const { AHORA_MX } = require('../hora');

// Emergencias que siguen abiertas: 'activa' o 'vista' (mismo criterio que la pantalla Alertas de la web).
// Solo las de las últimas 24 horas, para que una alerta olvidada no se quede en el Dashboard para siempre.
const FILTRO_ABIERTAS = `tipo = 'emergencia' AND categoria = 'codigo_emergencia' AND estado IN ('activa','vista')
  AND created_at >= DATE_SUB(${AHORA_MX}, INTERVAL 24 HOUR)`;

function leerDatos(valor) {
  if (!valor) return {};
  if (typeof valor === 'object') return valor;          // mysql2 ya convierte las columnas JSON
  try { return JSON.parse(valor); } catch { return {}; }
}

// Máximo 3 activaciones por minuto por usuario: evita alertas repetidas por error o por un dedo nervioso.
const limitePorUsuario = rateLimit({
  windowMs: 60 * 1000, max: 3, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `emergencia:${req.user.id}`,
  message: { error: 'Ya se enviaron varias alertas en el último minuto. Espera un momento.' },
});

// POST /api/emergencias  { mensaje?, ubicacion?: { lat, lng } }  -> registra una alerta crítica
//   Solo médico y enfermería (y el administrador). Responde 201 con el número de registro.
router.post('/', auth, roles('medico', 'enfermeria'), limitePorUsuario, ah(async (req, res) => {
  const b = req.body || {};
  const mensaje = String(b.mensaje || 'Código de emergencia activado').slice(0, 500);

  let ubicacion = null;
  if (b.ubicacion !== undefined && b.ubicacion !== null) {
    if (typeof b.ubicacion !== 'object') throw new HttpError(400, 'Ubicación inválida');
    ubicacion = leerCoordenadas(b.ubicacion.lat, b.ubicacion.lng);
  }

  // user_id es "a quién va dirigida" en la web (NULL = todos). Una emergencia es para todo el personal,
  // así que va en NULL; quien la activó queda en referencia_* y en datos. Hora de México, como la web.
  const [r] = await pool.query(
    `INSERT INTO alertas (tipo, categoria, nivel, titulo, mensaje, datos, referencia_tipo, referencia_id, estado, user_id, created_at, updated_at)
     VALUES ('emergencia','codigo_emergencia','critico','Código de emergencia',?,?,?,?, 'activa', NULL, ${AHORA_MX}, ${AHORA_MX})`,
    [mensaje, JSON.stringify({ ubicacion, activadaPor: req.user.nombre, activadaPorId: req.user.id }), 'App\\Models\\User', req.user.id]);
  await audit(req, { evento: 'emergencia', modulo: 'emergencias', descripcion: `Código de emergencia activado por ${req.user.nombre}`, tipo: 'alerta', id: r.insertId, severidad: 'critical',
    despues: ubicacion ? { ubicacion } : null });
  // Aviso push a médicos y enfermería (sin el texto libre ni la ubicación: se ven en la pantalla bloqueada).
  // No se espera la respuesta de Firebase para no retrasar la alerta.
  notificarRoles(['medico', 'enfermeria'], {
    titulo: 'Código de emergencia activado',
    cuerpo: 'Abre HealthNexus para ver los detalles.',
    datos: { tipo: 'emergencia', alertaId: r.insertId, pantalla: 'Dashboard' },
  }, { excluirUserId: req.user.id });
  res.status(201).json({ id: r.insertId, mensaje, estado: 'activa' });
}));

// GET /api/emergencias/activas  -> emergencias abiertas de las últimas 24 h, la más reciente primero
//   [{ id, mensaje, estado, creada, activadaPor, activadaPorId, ubicacion }]
router.get('/activas', auth, roles('medico', 'enfermeria'), ah(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, mensaje, estado, datos, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS creada
       FROM alertas
      WHERE ${FILTRO_ABIERTAS}
      ORDER BY created_at DESC, id DESC
      LIMIT 20`);
  res.json(rows.map((a) => {
    const d = leerDatos(a.datos);
    return {
      id: a.id,
      mensaje: a.mensaje,
      estado: a.estado,
      creada: a.creada,
      activadaPor: d.activadaPor || null,
      activadaPorId: d.activadaPorId || null,
      ubicacion: d.ubicacion || null,
    };
  }));
}));

// PATCH /api/emergencias/:id/atender  -> la marca como resuelta (resuelta_por, resuelta_en) y queda en la bitácora
router.patch('/:id/atender', auth, roles('medico', 'enfermeria'), ah(async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) throw new HttpError(400, 'Identificador inválido');
  const [r] = await pool.query(
    `UPDATE alertas SET estado = 'resuelta', resuelta_por = ?, resuelta_en = ${AHORA_MX}, updated_at = ${AHORA_MX}
      WHERE id = ? AND tipo = 'emergencia' AND categoria = 'codigo_emergencia' AND estado IN ('activa','vista')`,
    [req.user.id, id]);
  if (!r.affectedRows) throw new HttpError(404, 'La emergencia no existe o ya fue atendida.');
  await audit(req, { evento: 'emergencia_atendida', modulo: 'emergencias', descripcion: `Código de emergencia #${id} atendido por ${req.user.nombre}`,
    tipo: 'alerta', id, despues: { estado: 'resuelta' }, severidad: 'warning' });
  res.json({ id, estado: 'resuelta' });
}));

module.exports = router;
