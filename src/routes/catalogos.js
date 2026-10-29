const router = require('express').Router();
const pool = require('../db');
const { ah, HttpError, auth, roles } = require('../middleware');

// GET /api/catalogos/estados
router.get('/estados', auth, roles('medico', 'enfermeria'), ah(async (req, res) => {
  const [rows] = await pool.query('SELECT id, nombre FROM estados ORDER BY nombre');
  res.json(rows);
}));

// GET /api/catalogos/municipios?estadoId=
router.get('/municipios', auth, roles('medico', 'enfermeria'), ah(async (req, res) => {
  const estadoId = Number(req.query.estadoId);
  if (!Number.isInteger(estadoId) || estadoId < 1) throw new HttpError(400, 'estadoId es obligatorio');
  const [rows] = await pool.query('SELECT id, nombre FROM municipios WHERE estado_id = ? ORDER BY nombre', [estadoId]);
  res.json(rows);
}));

module.exports = router;
