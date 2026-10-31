// Recuperación de contraseña desde la app (montado en /api/auth/recuperar).
//   1. POST /             { email }            -> 202 siempre (no revela si el correo existe) y envía un código de 6 dígitos
//   2. POST /verificar    { email, codigo }    -> { resetToken }  (5 intentos por código; vence en 15 min)
//   3. POST /restablecer  { resetToken, nueva } -> 200; cambia la contraseña (misma que la web) y cierra las sesiones de la app
// Tablas: database/recuperacion.sql. Solo se guarda el hash del código. Nada se borra: los códigos se invalidan con usado_en.
// El PIN del médico NO se recupera por aquí: lo regenera el administrador desde la web.
const router = require('express').Router();
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { ah, audit } = require('../middleware');
const { enviarCodigoRecuperacion } = require('../correo');

const MINUTOS_CODIGO = 15;
const MAX_INTENTOS = 5;
const RESET_TTL = '10m';
const claveReset = () => `${process.env.JWT_SECRET}|reset`;

const MSG_ENVIADO = 'Si el correo pertenece a una cuenta activa, te enviamos un código de 6 dígitos. Revisa tu bandeja de entrada y la de correo no deseado.';
const MSG_CODIGO = 'El código no es válido o ya venció.';
const MSG_RESET = 'La verificación expiró. Pide un código nuevo.';

// Un hash cualquiera para que un correo inexistente tarde lo mismo que uno real (no se puede adivinar qué cuentas existen).
const HASH_FALSO = bcrypt.hashSync('codigo-que-no-existe', 10);

const correoDe = (req) => String((req.body && req.body.email) || '').trim().toLowerCase();
const CORREO_VALIDO = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const ipDe = (req) => String(req.ip || '').replace(/^::ffff:/, '').slice(0, 45);

const base = { standardHeaders: true, legacyHeaders: false };
// Pedir código: 10 por IP cada 15 min y 3 por correo cada hora (frena el envío masivo de correos a una persona).
const limiteSolicitudIp = rateLimit({ ...base, windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo en 15 minutos.' } });
const limiteSolicitudCorreo = rateLimit({ ...base, windowMs: 60 * 60 * 1000, max: 3,
  keyGenerator: (req) => `recuperar:${correoDe(req) || 'sin-correo'}`,
  message: { error: 'Ya pediste varios códigos para este correo. Espera una hora o usa el último que te llegó.' } });
// Verificar código: 20 intentos fallidos por IP cada 15 min (además del tope de 5 por código).
const limiteVerificacion = rateLimit({ ...base, windowMs: 15 * 60 * 1000, max: 20, skipSuccessfulRequests: true,
  message: { error: 'Demasiados intentos. Intenta de nuevo en 15 minutos.' } });

// Igual que la web: mínimo 8 caracteres, una mayúscula y un número. bcrypt solo usa los primeros 72 bytes.
function revisarClave(nueva) {
  const s = String(nueva || '');
  if (s.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (Buffer.byteLength(s, 'utf8') > 72) return 'La contraseña es demasiado larga (máximo 72 caracteres).';
  if (!/[A-ZÁÉÍÓÚÑ]/.test(s)) return 'La contraseña debe tener al menos una letra mayúscula.';
  if (!/\d/.test(s)) return 'La contraseña debe tener al menos un número.';
  return null;
}

const generarCodigo = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

async function buscarUsuario(email) {
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.email, u.activo, r.name AS rol
     FROM users u
     LEFT JOIN model_has_roles mr ON mr.model_id = u.id AND mr.model_type LIKE '%User'
     LEFT JOIN roles r ON r.id = mr.role_id
     WHERE u.email = ? LIMIT 1`, [email]);
  const u = rows[0];
  return u && u.activo === 1 ? u : null;
}

const actorDe = (u) => ({ id: u.id, nombre: u.name, rol: u.rol || 'sin_rol' });

// POST /api/auth/recuperar  { email }
router.post('/', limiteSolicitudIp, limiteSolicitudCorreo, ah(async (req, res) => {
  const email = correoDe(req);
  if (!CORREO_VALIDO.test(email)) return res.status(400).json({ error: 'Escribe un correo electrónico válido.' });

  const u = await buscarUsuario(email);
  if (!u) {
    await bcrypt.hash('relleno', 10); // mismo costo que el camino real
    return res.status(202).json({ mensaje: MSG_ENVIADO, minutos: MINUTOS_CODIGO });
  }

  const codigo = generarCodigo();
  const hash = await bcrypt.hash(codigo, 10);
  // Solo un código vigente por cuenta: los anteriores dejan de servir.
  await pool.query('UPDATE recuperacion_clave SET usado_en = UTC_TIMESTAMP() WHERE user_id = ? AND usado_en IS NULL', [u.id]);
  await pool.query(
    `INSERT INTO recuperacion_clave (user_id, codigo_hash, intentos, expira_en, ip, created_at)
     VALUES (?, ?, 0, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${MINUTOS_CODIGO} MINUTE), ?, UTC_TIMESTAMP())`,
    [u.id, hash, ipDe(req)]);
  await audit(req, { evento: 'recuperacion_solicitada', modulo: 'auth', descripcion: 'Solicitud de código para recuperar la contraseña',
    actor: actorDe(u) });

  // No se espera el envío: la respuesta tarda lo mismo exista o no la cuenta.
  enviarCodigoRecuperacion({ para: u.email, nombre: u.name, codigo, minutos: MINUTOS_CODIGO });
  res.status(202).json({ mensaje: MSG_ENVIADO, minutos: MINUTOS_CODIGO });
}));

// POST /api/auth/recuperar/verificar  { email, codigo }  -> { resetToken, expiraEn }
router.post('/verificar', limiteVerificacion, ah(async (req, res) => {
  const email = correoDe(req);
  const codigo = String((req.body && req.body.codigo) || '').trim();
  if (!CORREO_VALIDO.test(email) || !/^\d{6}$/.test(codigo)) {
    return res.status(400).json({ error: 'Escribe el código de 6 dígitos que te llegó por correo.' });
  }

  const u = await buscarUsuario(email);
  let fila = null;
  if (u) {
    const [rows] = await pool.query(
      `SELECT id, codigo_hash, intentos FROM recuperacion_clave
       WHERE user_id = ? AND usado_en IS NULL AND expira_en > UTC_TIMESTAMP()
       ORDER BY id DESC LIMIT 1`, [u.id]);
    fila = rows[0] || null;
  }
  if (!fila) {
    await bcrypt.compare(codigo, HASH_FALSO);
    return res.status(400).json({ error: MSG_CODIGO, code: 'CODIGO_INVALIDO' });
  }
  if (fila.intentos >= MAX_INTENTOS) {
    return res.status(400).json({ error: 'Demasiados intentos con este código. Pide uno nuevo.', code: 'CODIGO_BLOQUEADO' });
  }

  if (!(await bcrypt.compare(codigo, fila.codigo_hash))) {
    const intentos = fila.intentos + 1;
    // Al 5.º error el código queda invalidado
    await pool.query(
      `UPDATE recuperacion_clave SET intentos = ?, usado_en = IF(? >= ${MAX_INTENTOS}, UTC_TIMESTAMP(), usado_en) WHERE id = ?`,
      [intentos, intentos, fila.id]);
    await audit(req, { evento: intentos >= MAX_INTENTOS ? 'recuperacion_bloqueada' : 'recuperacion_codigo_fallido', modulo: 'auth',
      descripcion: intentos >= MAX_INTENTOS ? 'Código de recuperación invalidado por intentos fallidos' : 'Código de recuperación incorrecto',
      severidad: 'warning', actor: actorDe(u) });
    if (intentos >= MAX_INTENTOS) {
      return res.status(400).json({ error: 'Demasiados intentos con este código. Pide uno nuevo.', code: 'CODIGO_BLOQUEADO' });
    }
    return res.status(400).json({ error: MSG_CODIGO, code: 'CODIGO_INVALIDO' });
  }

  const resetToken = jwt.sign({ id: u.id, rid: fila.id, etapa: 'reset' }, claveReset(), { expiresIn: RESET_TTL });
  res.json({ resetToken, minutos: 10 });
}));

// POST /api/auth/recuperar/restablecer  { resetToken, nueva }
router.post('/restablecer', limiteVerificacion, ah(async (req, res) => {
  const { resetToken, nueva } = req.body || {};
  let datos;
  try {
    datos = jwt.verify(String(resetToken || ''), claveReset(), { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: MSG_RESET, code: 'RESET_EXPIRADO' });
  }
  if (datos.etapa !== 'reset' || !datos.id || !datos.rid) return res.status(401).json({ error: MSG_RESET, code: 'RESET_EXPIRADO' });

  const problema = revisarClave(nueva);
  if (problema) return res.status(400).json({ error: problema, code: 'CLAVE_DEBIL' });

  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.activo, r.name AS rol FROM users u
     LEFT JOIN model_has_roles mr ON mr.model_id = u.id AND mr.model_type LIKE '%User'
     LEFT JOIN roles r ON r.id = mr.role_id
     WHERE u.id = ? LIMIT 1`, [datos.id]);
  const u = rows[0];
  if (!u || u.activo !== 1) return res.status(401).json({ error: MSG_RESET, code: 'RESET_EXPIRADO' });

  // Se "gasta" el código de forma atómica: si dos peticiones llegan a la vez, solo una cambia la contraseña.
  const [gasto] = await pool.query(
    'UPDATE recuperacion_clave SET usado_en = UTC_TIMESTAMP() WHERE id = ? AND user_id = ? AND usado_en IS NULL',
    [datos.rid, u.id]);
  if (!gasto || gasto.affectedRows !== 1) return res.status(401).json({ error: MSG_RESET, code: 'RESET_EXPIRADO' });

  // Mismo formato que Laravel ($2y$, costo 12): la contraseña nueva sirve en la web y en la app.
  const hash = bcrypt.hashSync(String(nueva), 12).replace(/^\$2a\$/, '$2y$');
  await pool.query('UPDATE users SET password = ?, remember_token = NULL, updated_at = NOW() WHERE id = ?', [hash, u.id]);

  // Cierra las sesiones de la app emitidas antes de este momento (ver middleware auth).
  const ahora = Math.floor(Date.now() / 1000);
  try {
    await pool.query(
      `INSERT INTO sesiones_revocadas (user_id, desde_epoch) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE desde_epoch = VALUES(desde_epoch)`, [u.id, ahora]);
  } catch (e) {
    console.error('No se pudieron cerrar las sesiones anteriores:', e.message);
  }

  await audit(req, { evento: 'clave_restablecida', modulo: 'auth', descripcion: 'Contraseña restablecida con código por correo desde la app',
    severidad: 'warning', sensible: 1, actor: actorDe(u) });
  res.json({ ok: true, mensaje: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
}));

module.exports = router;
module.exports.revisarClave = revisarClave;
module.exports.generarCodigo = generarCodigo;
