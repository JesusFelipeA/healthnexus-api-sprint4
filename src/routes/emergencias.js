const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { ah, HttpError, auth, roles, audit, leerCoordenadas } = require('../middleware');
const { notificarRoles } = require('../push');

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

  const [r] = await pool.query(
    `INSERT INTO alertas (tipo, categoria, nivel, titulo, mensaje, datos, estado, user_id, created_at, updated_at)
     VALUES ('emergencia','codigo_emergencia','critico','Código de emergencia',?,?, 'activa', ?, NOW(), NOW())`,
    [mensaje, JSON.stringify({ ubicacion, activadaPor: req.user.nombre }), req.user.id]);
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

module.exports = router;
