require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { errorHandler } = require('./middleware');

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
app.use(cors({
  origin: (origin, cb) => (!origin || origins.includes(origin) ? cb(null, true) : cb(new Error('Origen no permitido por CORS'))),
  exposedHeaders: ['X-Total-Count'],
}));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

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
app.use('/api/farmacia', require('./routes/farmacia'));
app.use('/api/enfermeria', require('./routes/enfermeria'));
app.use('/api', require('./routes/cuentas'));          // /cuentas, /cuentas/:id y /pagos/:id/recibo (solo administrador)
app.use('/api/notificaciones', require('./routes/notificaciones')); // token FCM del dispositivo

app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
app.use(errorHandler);

module.exports = app;
