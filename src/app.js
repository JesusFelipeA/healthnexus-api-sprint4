require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { errorHandler, HttpError } = require('./middleware');
const pool = require('./db');

const app = express();
// Solo confía en X-Forwarded-For si la API está detrás de un proxy real (Nginx, Azure...).
// Con 0 (por defecto) un cliente no puede falsear su IP para evadir los límites.
app.set('trust proxy', Number(process.env.TRUST_PROXY || 0));
app.use(helmet());

// Límite global: frena ráfagas de peticiones desde una misma IP (además de los límites propios del login).
// Con TRUST_PROXY=0 detrás de Nginx todos compartirían la IP del proxy: configura TRUST_PROXY=1 en el servidor.
const limiteGlobal = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX || 120),
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiadas peticiones. Espera un momento.' },
});

app.use('/api', limiteGlobal);

const origins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
// Se permiten los orígenes de CORS_ORIGINS y el propio servidor (Swagger UI en /api/docs llama a la API desde ahí).
const mismoOrigen = (req, origin) => origin === `${req.protocol}://${req.get('host')}`;
app.use(cors((req, cb) => cb(null, {
  // Un origen no permitido recibe 403 (no 500) y no deja la traza en el log
  origin: (origin, ok) => (!origin || origins.includes(origin) || mismoOrigen(req, origin) ? ok(null, true) : ok(new HttpError(403, 'Origen no permitido', 'ORIGEN_NO_PERMITIDO'))),
  exposedHeaders: ['X-Total-Count'],
})));
app.use(express.json({ limit: '1mb' }));

// Salud de la API Y de la base de datos: con la base caída responde 503, así el HEALTHCHECK de Docker
// y cualquier monitoreo detectan el problema (por ejemplo, el apagado nocturno de RDS).
const SALUD_TIMEOUT_MS = 2000;
app.get('/api/health', async (req, res) => {
  let espera;
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, rechazar) => { espera = setTimeout(() => rechazar(new Error('timeout')), SALUD_TIMEOUT_MS); }),
    ]);
    res.json({ ok: true, db: 'ok' });
  } catch {
    res.status(503).json({ ok: false, db: 'sin_conexion', error: 'La base de datos no está disponible.' });
  } finally {
    clearTimeout(espera);
  }
});

// Documentación interactiva (Swagger UI): /api/docs  ·  especificación OpenAPI: /api/docs/openapi.json
const docs = require('./docs');
if (docs.habilitada()) docs.montar(app);

app.use('/api/auth/recuperar', require('./routes/recuperacion')); // recuperar contraseña con código por correo
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/patients'));        // /stats y /patients
app.use('/api', require('./routes/triage'));          // /triage y /patients/:id/triage
app.use('/api/catalogos', require('./routes/catalogos'));
app.use('/api/derivaciones', require('./routes/derivaciones'));
app.use('/api/hospitals', require('./routes/hospitals'));
app.use('/api/seguimiento', require('./routes/seguimiento'));
app.use('/api/auditoria', require('./routes/auditoria'));
app.use('/api/emergencias', require('./routes/emergencias'));
app.use('/api/farmacia/recetas', require('./routes/recetas'));
app.use('/api/farmacia', require('./routes/farmacia'));
app.use('/api/enfermeria', require('./routes/enfermeria'));
app.use('/api', require('./routes/cuentas'));          // /cuentas, /cuentas/:id y /pagos/:id/recibo (solo administrador)
app.use('/api/notificaciones', require('./routes/notificaciones')); // token FCM del dispositivo

app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
app.use(errorHandler);

module.exports = app;
