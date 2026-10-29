const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const pool = require('./config/db');
const authRoutes = require('./routes/auth.routes');

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());
app.use(morgan(process.env.LOG_LEVEL || 'dev'));

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'conectada' });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'sin conexión' });
  }
});

app.use('/api/auth', authRoutes);

app.use((req, res) => res.status(404).json({ message: 'Ruta no encontrada' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ message: err.message || 'Error interno del servidor' });
});

module.exports = app;