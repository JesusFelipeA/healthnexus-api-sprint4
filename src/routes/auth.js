const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { ah, auth, audit } = require('../middleware');
const { registrarDispositivo, dispositivoBloqueado, huellaValida } = require('../dispositivos');

// Dos límites sobre los intentos FALLIDOS de login (los exitosos no cuentan):
//  - por IP: 20 cada 15 min (frena el barrido de muchas cuentas desde un mismo origen)
//  - por CUENTA: 5 cada 15 min (frena la fuerza bruta contra un correo aunque cambien de IP)
const base = {
  windowMs: 15 * 60 * 1000, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos. Intenta de nuevo en 15 minutos.' },
};
const limitePorIp = rateLimit({ ...base, max: 20 });
const limitePorCuenta = rateLimit({
  ...base, max: 5,
  keyGenerator: (req) => `cuenta:${String((req.body && req.body.email) || '').trim().toLowerCase() || 'sin-correo'}`,
});

// Intentos de PIN fallidos: 5 cada 15 min por usuario (la clave sale del pinToken).
const limitePorPin = rateLimit({
  ...base, max: 5,
  keyGenerator: (req) => {
    const d = jwt.decode(String((req.body && req.body.pinToken) || ''));
    return d && d.id ? `pin:${d.id}` : `pin-ip:${req.ip}`;
  },
});

const USER_SQL = `
  SELECT u.id, u.name, u.email, u.password, u.pin, u.activo, r.name AS rol
  FROM users u
  LEFT JOIN model_has_roles mr ON mr.model_id = u.id AND mr.model_type LIKE '%User'
  LEFT JOIN roles r ON r.id = mr.role_id`;

// Igual que RoleHelper::esMedico de Laravel: "medico", "Médico", "medicina general", "m"...
const normalizar = (rol) => String(rol || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const esMedico = (rol) => { const r = normalizar(rol); return r === 'm' || r.startsWith('medic'); };

// El pinToken solo sirve para POST /auth/pin: se firma con otra clave y dura 5 minutos,
// así que nunca pasa el middleware `auth` como token de acceso.
const PIN_TTL = '5m';
const clavePin = () => `${process.env.JWT_SECRET}|pin`;

// Se revisa ANTES que la contraseña: si se revisara después, la respuesta diría si la contraseña era correcta.
const MSG_SIN_HUELLA = 'Falta una huella de dispositivo válida. Inicia sesión desde la app de HealthNexus.';
function exigirHuella(req, res, next) {
  if (huellaValida(req)) return next();
  return res.status(400).json({ error: MSG_SIN_HUELLA, code: 'HUELLA_REQUERIDA' });
}

const MSG_BLOQUEADO = 'Este dispositivo está bloqueado. Pide al administrador que lo desbloquee.';

// Igual que la web: un dispositivo bloqueado (dispositivos.activo = 0) no puede iniciar sesión.
// Si la consulta falla, no se impide el acceso (el registro de dispositivos tampoco lo impide).
async function rechazarSiBloqueado(req, res, u) {
  let bloqueado = false;
  try {
    bloqueado = await dispositivoBloqueado(req, u.id);
  } catch (e) {
    console.error('No se pudo revisar el dispositivo:', e.message);
  }
  if (!bloqueado) return false;
  await audit(req, { evento: 'dispositivo_bloqueado', modulo: 'dispositivos', descripcion: 'Intento de acceso desde un dispositivo bloqueado',
    severidad: 'warning', actor: { id: u.id, nombre: u.name, rol: u.rol } });
  res.status(403).json({ error: MSG_BLOQUEADO, code: 'DISPOSITIVO_BLOQUEADO' });
  return true;
}

// Emite el token de acceso, deja el login en la bitácora y registra el dispositivo.
async function completarLogin(req, res, u, extra = {}) {
  const user = { id: u.id, nombre: u.name, email: u.email, rol: u.rol || 'sin_rol' };
  const token = jwt.sign({ id: user.id, nombre: user.nombre, rol: user.rol }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES || '8h' });
  await audit(req, { evento: 'login', modulo: 'auth', descripcion: extra.conPin ? 'Inicio de sesión con PIN' : 'Inicio de sesión', actor: user });
  // El dispositivo se registra para que aparezca en la web (Dispositivos); un fallo aquí nunca impide el acceso.
  try {
    const d = await registrarDispositivo(req, user.id);
    if (d.nuevo) {
      await audit(req, { evento: 'dispositivo_nuevo', modulo: 'dispositivos', descripcion: 'Nuevo dispositivo registrado desde la app móvil',
        tipo: 'App\\Models\\Dispositivo', id: d.id, actor: user });
    }
  } catch (e) {
    console.error('No se pudo registrar el dispositivo:', e.message);
  }
  res.json({ token, user });
}

// POST /api/auth/login  { email, password }
//   Médico -> { requierePin: true, pinToken } y debe continuar en POST /auth/pin
//   Otros roles -> { token, user }
router.post('/login', limitePorIp, limitePorCuenta, exigirHuella, ah(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Correo y contraseña son obligatorios' });

  const [rows] = await pool.query(`${USER_SQL} WHERE u.email = ? LIMIT 1`, [String(email).trim().toLowerCase()]);
  const u = rows[0];
  const ok = u && u.activo === 1 && (await bcrypt.compare(String(password), u.password));
  if (!ok) {
    await audit(req, { evento: 'login_fallido', modulo: 'auth', descripcion: `Intento de acceso fallido: ${String(email).slice(0, 100)}`, severidad: 'warning',
      actor: u ? { id: u.id, nombre: u.name, rol: u.rol } : null });
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  if (await rechazarSiBloqueado(req, res, u)) return;

  if (esMedico(u.rol)) {
    const pinToken = jwt.sign({ id: u.id, etapa: 'pin' }, clavePin(), { expiresIn: PIN_TTL });
    return res.json({ requierePin: true, pinToken });
  }
  await completarLogin(req, res, u);
}));

// POST /api/auth/pin  { pinToken, pin }  -> { token, user }   (segundo paso del médico)
router.post('/pin', limitePorIp, limitePorPin, exigirHuella, ah(async (req, res) => {
  const { pinToken, pin } = req.body || {};
  if (!pinToken) return res.status(400).json({ error: 'Falta el pinToken. Inicia sesión de nuevo.' });
  if (!/^\d{4}$/.test(String(pin || ''))) return res.status(400).json({ error: 'El PIN debe tener exactamente 4 dígitos.' });

  let datos;
  try {
    datos = jwt.verify(String(pinToken), clavePin(), { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'La verificación expiró. Inicia sesión de nuevo.' });
  }
  if (datos.etapa !== 'pin') return res.status(401).json({ error: 'La verificación expiró. Inicia sesión de nuevo.' });

  const [rows] = await pool.query(`${USER_SQL} WHERE u.id = ? LIMIT 1`, [datos.id]);
  const u = rows[0];
  if (!u || u.activo !== 1 || !esMedico(u.rol)) return res.status(401).json({ error: 'La verificación expiró. Inicia sesión de nuevo.' });
  if (!u.pin) {
    return res.status(403).json({ error: 'Tu cuenta no tiene PIN asignado. Pide al administrador que lo genere.' });
  }
  if (!(await bcrypt.compare(String(pin), u.pin))) {
    await audit(req, { evento: 'pin_fallido', modulo: 'auth', descripcion: 'PIN incorrecto', severidad: 'warning',
      actor: { id: u.id, nombre: u.name, rol: u.rol } });
    return res.status(401).json({ error: 'PIN incorrecto.' });
  }
  // Pudo bloquearse en los 5 minutos entre la contraseña y el PIN
  if (await rechazarSiBloqueado(req, res, u)) return;
  await audit(req, { evento: 'pin_exitoso', modulo: 'auth', descripcion: 'PIN verificado', actor: { id: u.id, nombre: u.name, rol: u.rol } });
  await completarLogin(req, res, u, { conPin: true });
}));

// GET /api/auth/me
router.get('/me', auth, ah(async (req, res) => {
  const [rows] = await pool.query(`${USER_SQL} WHERE u.id = ? LIMIT 1`, [req.user.id]);
  if (!rows[0] || rows[0].activo !== 1) return res.status(401).json({ error: 'Usuario no disponible' });
  res.json({ id: rows[0].id, nombre: rows[0].name, email: rows[0].email, rol: rows[0].rol || 'sin_rol' });
}));

module.exports = router;
