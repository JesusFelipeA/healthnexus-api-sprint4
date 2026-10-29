// Notificaciones push con Firebase Cloud Messaging (FCM).
//
// Configuración (una de las dos, solo en el servidor; nunca en el repositorio):
//   FIREBASE_CREDENTIALS_FILE=/ruta/a/cuenta-de-servicio.json
//   FIREBASE_CREDENTIALS_BASE64=<contenido del JSON en base64>   (útil con .env.rds o AWS SSM)
// Si no hay credenciales, las notificaciones se desactivan y la API sigue funcionando igual.
//
// Privacidad: los mensajes nunca llevan nombres de pacientes ni datos clínicos, porque se ven
// en la pantalla bloqueada. La app consulta el detalle con su sesión y permisos.

const fs = require('node:fs');
const pool = require('./db');

let messaging;          // instancia de firebase-admin/messaging, o null si está desactivado
let avisado = false;

function leerCredenciales(env = process.env) {
  if (env.FIREBASE_CREDENTIALS_BASE64) return JSON.parse(Buffer.from(env.FIREBASE_CREDENTIALS_BASE64, 'base64').toString('utf8'));
  if (env.FIREBASE_CREDENTIALS_FILE) return JSON.parse(fs.readFileSync(env.FIREBASE_CREDENTIALS_FILE, 'utf8'));
  return null;
}

function obtenerMessaging() {
  if (messaging !== undefined) return messaging;
  try {
    const cred = leerCredenciales();
    if (!cred) {
      messaging = null;
    } else {
      const { initializeApp, cert, getApps } = require('firebase-admin/app');
      const { getMessaging } = require('firebase-admin/messaging');
      const app = getApps()[0] || initializeApp({ credential: cert(cred) });
      messaging = getMessaging(app);
    }
  } catch (e) {
    console.error('No se pudo iniciar Firebase para notificaciones:', e.message);
    messaging = null;
  }
  if (!messaging && !avisado) {
    avisado = true;
    if (process.env.NODE_ENV !== 'test') console.warn('Notificaciones push desactivadas: faltan FIREBASE_CREDENTIALS_FILE o FIREBASE_CREDENTIALS_BASE64.');
  }
  return messaging;
}

const pushActivo = () => !!obtenerMessaging();

// Solo para pruebas: reemplaza el cliente de FCM.
function _usarMessaging(m) { messaging = m; }

const TOKEN_RE = /^[A-Za-z0-9_:\-.]{20,4096}$/;
const tokenValido = (t) => typeof t === 'string' && TOKEN_RE.test(t);

// Guarda el token FCM del dispositivo con el que el usuario inició sesión (user_id + huella).
async function guardarToken(userId, huella, token) {
  const [r] = await pool.query(
    'UPDATE dispositivos SET fcm_token = ?, fcm_actualizado = NOW() WHERE user_id = ? AND huella = ? AND activo = 1',
    [token, userId, huella]);
  // El mismo token no debe quedar asignado a otra cuenta (cambio de usuario en el mismo teléfono).
  await pool.query('UPDATE dispositivos SET fcm_token = NULL WHERE fcm_token = ? AND NOT (user_id = ? AND huella = ?)', [token, userId, huella]);
  return r.affectedRows > 0;
}

async function quitarToken(userId, huella) {
  await pool.query('UPDATE dispositivos SET fcm_token = NULL WHERE user_id = ? AND huella = ?', [userId, huella]);
}

// Tokens de los dispositivos activos de usuarios activos con alguno de los roles indicados.
async function tokensPorRol(rolesDestino, excluirUserId = null) {
  const [rows] = await pool.query(
    `SELECT DISTINCT d.fcm_token AS token
       FROM dispositivos d
       JOIN users u ON u.id = d.user_id AND u.activo = 1
       JOIN model_has_roles mr ON mr.model_id = u.id AND mr.model_type LIKE '%User'
       JOIN roles r ON r.id = mr.role_id
      WHERE d.activo = 1 AND d.fcm_token IS NOT NULL AND r.name IN (?) AND u.id <> ?`,
    [rolesDestino, excluirUserId || 0]);
  return rows.map((x) => x.token);
}

const ERRORES_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);

// Envía la notificación. `datos` solo admite textos cortos sin información sensible
// (por ejemplo { tipo: 'emergencia', pantalla: 'Dashboard' }).
async function enviar(tokens, { titulo, cuerpo, datos = {} }) {
  const m = obtenerMessaging();
  if (!m || !tokens.length) return { enviados: 0, fallidos: 0 };
  const data = Object.fromEntries(Object.entries(datos).map(([k, v]) => [k, String(v)]));
  let enviados = 0, fallidos = 0;
  for (let i = 0; i < tokens.length; i += 500) {            // FCM acepta hasta 500 tokens por envío
    const lote = tokens.slice(i, i + 500);
    const r = await m.sendEachForMulticast({
      tokens: lote,
      notification: { title: titulo, body: cuerpo },
      data,
      android: { priority: datos.tipo === 'emergencia' ? 'high' : 'normal', notification: { channelId: 'alertas' } },
    });
    enviados += r.successCount; fallidos += r.failureCount;
    const invalidos = r.responses.map((x, j) => (!x.success && x.error && ERRORES_TOKEN.has(x.error.code) ? lote[j] : null)).filter(Boolean);
    if (invalidos.length) await pool.query('UPDATE dispositivos SET fcm_token = NULL WHERE fcm_token IN (?)', [invalidos]);
  }
  return { enviados, fallidos };
}

// Notifica a todos los usuarios de ciertos roles. Nunca lanza error: una falla de FCM
// no debe impedir que se registre la emergencia o el cambio de triage.
async function notificarRoles(rolesDestino, mensaje, { excluirUserId } = {}) {
  try {
    if (!pushActivo()) return { enviados: 0, fallidos: 0 };
    return await enviar(await tokensPorRol(rolesDestino, excluirUserId), mensaje);
  } catch (e) {
    console.error('No se pudo enviar la notificación push:', e.message);
    return { enviados: 0, fallidos: 0, error: true };
  }
}

module.exports = { pushActivo, tokenValido, guardarToken, quitarToken, tokensPorRol, enviar, notificarRoles, leerCredenciales, _usarMessaging };
