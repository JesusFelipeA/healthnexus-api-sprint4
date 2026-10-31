const jwt = require('jsonwebtoken');
const pool = require('./db');

// Envuelve handlers async para que los errores lleguen al errorHandler
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Error con código HTTP
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const sqlSesion = (revocacion) => `
  SELECT u.id, u.name, u.activo, r.name AS rol${revocacion ? ', sr.desde_epoch' : ''}
  FROM users u
  LEFT JOIN model_has_roles mr ON mr.model_id = u.id AND mr.model_type LIKE '%User'
  LEFT JOIN roles r ON r.id = mr.role_id${revocacion ? '\n  LEFT JOIN sesiones_revocadas sr ON sr.user_id = u.id' : ''}
  WHERE u.id = ? LIMIT 1`;
const conRevocacion = sqlSesion(true);
const sinRevocacion = sqlSesion(false);
let hayTablaRevocacion = true;

// Si aún no se aplicó database/recuperacion.sql la API sigue funcionando (solo sin cierre de sesiones).
async function usuarioDeSesion(id) {
  if (hayTablaRevocacion) {
    try {
      const [rows] = await pool.query(conRevocacion, [id]);
      return rows[0];
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
      hayTablaRevocacion = false;
      console.warn('AVISO: falta la tabla sesiones_revocadas (database/recuperacion.sql). El cambio de contraseña no cerrará sesiones.');
    }
  }
  const [rows] = await pool.query(sinRevocacion, [id]);
  return rows[0];
}

// Verifica el JWT y confirma en la base de datos que la cuenta siga activa.
// El rol se lee de la BD en cada petición (no del token): si desactivan la cuenta
// o le cambian el rol, el cambio surte efecto al instante.
async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
  if (payload.etapa) return res.status(401).json({ error: 'Token inválido o expirado' }); // un pinToken o resetToken no es token de acceso
  try {
    const u = await usuarioDeSesion(payload.id);
    if (!u || u.activo !== 1) return res.status(401).json({ error: 'Sesión no válida' });
    // Tras restablecer la contraseña, los tokens emitidos antes dejan de servir (database/recuperacion.sql)
    if (u.desde_epoch && Number(payload.iat || 0) < Number(u.desde_epoch)) {
      return res.status(401).json({ error: 'Tu sesión se cerró porque cambiaste la contraseña. Inicia sesión de nuevo.', code: 'SESION_REVOCADA' });
    }
    req.user = { id: u.id, nombre: u.name, rol: u.rol || 'sin_rol' };
    next();
  } catch (e) {
    next(e);
  }
}

// Permite solo ciertos roles (el administrador siempre pasa)
const roles = (...permitidos) => (req, res, next) => {
  const rol = req.user && req.user.rol;
  if (rol === 'administrador' || permitidos.includes(rol)) return next();
  // HU-37: el acceso denegado queda en la bitácora (sin query string: puede traer nombres de pacientes)
  const ruta = `${req.method} ${req.baseUrl}${req.route ? req.route.path : req.path}`;
  audit(req, { evento: 'acceso_denegado', modulo: 'auth', descripcion: `Acceso denegado: ${ruta}`, severidad: 'warning' })
    .catch((e) => console.error('No se pudo auditar el acceso denegado:', e.message));
  res.status(403).json({ error: 'No tienes permiso para esta acción' });
};

// Registra una acción en audit_logs (tabla de solo inserción)
async function audit(req, { evento, modulo, descripcion, tipo = null, id = null, antes = null, despues = null, severidad = 'info', sensible = 0, actor = null }, conn = pool) {
  const u = actor || req.user || {};
  await conn.query(
    `INSERT INTO audit_logs (user_id, user_nombre, user_rol, evento, modulo, descripcion, auditable_type, auditable_id,
       datos_antes, datos_despues, metadata, severidad, es_sensible, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
    [u.id || null, u.nombre || null, u.rol || null, evento, modulo, String(descripcion).slice(0, 255), tipo, id,
     antes ? JSON.stringify(antes) : null, despues ? JSON.stringify(despues) : null,
     JSON.stringify({ ip: String(req.ip || '').replace(/^::ffff:/, ''), ua: req.headers['user-agent'] || null }), severidad, sensible]
  );
}

// Paginación común: ?limit= (tope `max`) y ?page= (desde 1)
function paginar(req, { def = 50, max = 200 } = {}) {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || def, 1), max);
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  return { limit, page, offset: (page - 1) * limit };
}

// Coordenadas GPS: ambas o ninguna, y dentro de rango. Devuelve { lat, lng } o null.
function leerCoordenadas(lat, lng) {
  const hayLat = lat !== undefined && lat !== '';
  const hayLng = lng !== undefined && lng !== '';
  if (!hayLat && !hayLng) return null;
  const la = Number(lat), ln = Number(lng);
  if (!hayLat || !hayLng || !Number.isFinite(la) || !Number.isFinite(ln) || la < -90 || la > 90 || ln < -180 || ln > 180) {
    throw new HttpError(400, 'Ubicación inválida: lat debe estar entre -90 y 90, y lng entre -180 y 180');
  }
  return { lat: la, lng: ln };
}

// Entero positivo o null
const idValido = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 && v !== '' && v !== null ? Number(v) : null);

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  // Errores del lector de JSON: mensaje fijo, nunca el texto del parser
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Solicitud demasiado grande' });
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Error interno del servidor' : err.message });
}

module.exports = { ah, HttpError, auth, roles, audit, errorHandler, paginar, leerCoordenadas, idValido };
