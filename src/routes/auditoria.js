const router = require('express').Router();
const pool = require('../db');
const { ah, auth, roles } = require('../middleware');

// GET /api/auditoria?q=texto&desde=2026-10-01&hasta=2026-10-06&severidad=critical&page=1&limit=50
router.get('/', auth, roles(), ah(async (req, res) => {
  const where = []; const params = [];
  if (req.query.q) { where.push('(descripcion LIKE ? OR user_nombre LIKE ? OR evento LIKE ? OR modulo LIKE ?)'); const q = `%${req.query.q}%`; params.push(q, q, q, q); }
  if (req.query.desde) { where.push('created_at >= ?'); params.push(`${req.query.desde} 00:00:00`); }
  if (req.query.hasta) { where.push('created_at <= ?'); params.push(`${req.query.hasta} 23:59:59`); }
  if (['info', 'warning', 'critical'].includes(req.query.severidad)) { where.push('severidad = ?'); params.push(req.query.severidad); }
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const offset = (Math.max(parseInt(req.query.page) || 1, 1) - 1) * limit;
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM audit_logs ${w}`, params);
  const [rows] = await pool.query(
    `SELECT id, user_nombre AS usuario, user_rol AS rol, evento, modulo, descripcion AS accion,
            severidad, (severidad = 'critical') AS critica, created_at AS fecha
     FROM audit_logs ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  res.json({ total, page: Math.floor(offset / limit) + 1, limit, data: rows });
}));

module.exports = router;
