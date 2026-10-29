// Registro de dispositivos en el login de la API, igual que DispositivoService de Laravel,
// para que los accesos desde la app móvil aparezcan en la pantalla "Dispositivos" de la web.
const crypto = require('node:crypto');
const pool = require('./db');
const { AHORA_MX } = require('./hora');
const ipLimpia = (req) => String(req.ip || '').replace(/^::ffff:/, '');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ua = (req) => String(req.get('user-agent') || '');

// La API solo atiende a la app móvil, que siempre manda X-Device-Fingerprint (identificador aleatorio
// guardado en el Keychain del teléfono). Sin esa cabecera no hay dispositivo que registrar ni bloquear,
// así que el login se rechaza. (Laravel usa el User-Agent como respaldo porque atiende navegadores.)
const HUELLA_RE = /^[A-Za-z0-9._:-]{16,255}$/;
const huellaCliente = (req) => String(req.get('x-device-fingerprint') || '').trim();
const huellaValida = (req) => HUELLA_RE.test(huellaCliente(req));

// sha256 de X-Device-Fingerprint: el mismo valor que calcula Laravel para esa cabecera.
function generarHuella(req) {
  return sha256(huellaCliente(req));
}

function detectarTipo(req) {
  const u = ua(req).toLowerCase();
  if (/okhttp|cfnetwork|darwin|react-native|dart|flutter/.test(u)) return /ipad|tablet/.test(u) ? 'tablet' : 'mobile';
  if (/tablet|ipad/.test(u)) return 'tablet';
  if (/mobile|android|iphone|ipod/.test(u)) return 'mobile';
  return 'desktop';
}

function detectarSO(req) {
  const u = ua(req);
  const t = (s) => u.toLowerCase().includes(s.toLowerCase());
  if (t('okhttp')) return 'Android';
  if (t('CFNetwork') || t('Darwin')) return 'iOS';
  if (t('Windows NT 10')) return 'Windows 10/11';
  if (t('Windows NT')) return 'Windows';
  if (t('Mac OS X')) return 'macOS';
  if (t('Android')) return 'Android';
  if (t('iPhone') || t('iPad')) return 'iOS';
  if (t('Linux')) return 'Linux';
  return 'Desconocido';
}

function detectarNavegador(req) {
  const u = ua(req);
  const t = (s) => u.toLowerCase().includes(s.toLowerCase());
  if (t('okhttp')) return 'React Native (Android)';
  if (t('CFNetwork') || t('Darwin')) return 'React Native (iOS)';
  if (t('react-native')) return 'React Native';
  if (t('Edg/')) return 'Microsoft Edge';
  if (t('Chrome/')) return 'Google Chrome';
  if (t('Firefox/')) return 'Mozilla Firefox';
  if (t('Safari/')) return 'Safari';
  if (t('Opera') || t('OPR/')) return 'Opera';
  return 'Desconocido';
}

function detectarNombre(req) {
  const so = detectarSO(req); const nav = detectarNavegador(req);
  return nav === 'Desconocido' && so === 'Desconocido' ? 'Dispositivo desconocido' : `${nav} en ${so}`;
}

// Registra (o actualiza) el dispositivo del usuario. Devuelve { nuevo, id }.
// Los timestamps van en hora de México, como los escribe Laravel.
async function registrarDispositivo(req, userId) {
  const huella = generarHuella(req);
  const datos = [detectarNombre(req), detectarTipo(req), detectarSO(req), detectarNavegador(req), ua(req).slice(0, 500), ipLimpia(req)];
  const [nombre, tipo, so, nav, agente, ip] = datos;

  const actualizar = async (id) => {
    await pool.query(
      `UPDATE dispositivos SET ip_ultimo_acceso = ?, ultimo_acceso = ${AHORA_MX}, total_accesos = total_accesos + 1,
         user_agent = ?, tipo = ?, sistema_operativo = ?, navegador = ?, nombre = ?, updated_at = ${AHORA_MX}
       WHERE id = ?`, [ip, agente, tipo, so, nav, nombre, id]);
    return { nuevo: false, id };
  };

  const [rows] = await pool.query('SELECT id FROM dispositivos WHERE user_id = ? AND huella = ? LIMIT 1', [userId, huella]);
  if (rows[0]) return actualizar(rows[0].id);

  try {
    const [r] = await pool.query(
      `INSERT INTO dispositivos (user_id, huella, nombre, tipo, sistema_operativo, navegador, user_agent, ip_registro, ip_ultimo_acceso,
         confiable, activo, ultimo_acceso, total_accesos, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,0,1,${AHORA_MX},1,${AHORA_MX},${AHORA_MX})`,
      [userId, huella, nombre, tipo, so, nav, agente, ip, ip]);
    return { nuevo: true, id: r.insertId };
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') { // dos logins simultáneos del mismo dispositivo
      const [otra] = await pool.query('SELECT id FROM dispositivos WHERE user_id = ? AND huella = ? LIMIT 1', [userId, huella]);
      if (otra[0]) return actualizar(otra[0].id);
    }
    throw e;
  }
}

// true si el administrador bloqueó este dispositivo en la web (Dispositivos → Bloquear: activo = 0).
// Un dispositivo que todavía no existe no está bloqueado.
async function dispositivoBloqueado(req, userId) {
  const [rows] = await pool.query('SELECT activo FROM dispositivos WHERE user_id = ? AND huella = ? LIMIT 1', [userId, generarHuella(req)]);
  return !!rows[0] && Number(rows[0].activo) === 0;
}

module.exports = { registrarDispositivo, dispositivoBloqueado, huellaValida, generarHuella, detectarTipo, detectarSO, detectarNavegador, detectarNombre };
