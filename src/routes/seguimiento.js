const router = require('express').Router();
const pool = require('../db');
const { ah, auth, roles, paginar } = require('../middleware');

// GET /api/seguimiento?limit=&page=  -> último registro de seguimiento por paciente
//   Devuelve el arreglo de la página; el total viene en la cabecera X-Total-Count.
router.get('/', auth, roles('medico', 'enfermeria'), ah(async (req, res) => {
  const { limit, offset } = paginar(req, { def: 200, max: 200 });
  const ULTIMO = 's.id = (SELECT MAX(id) FROM seguimientos WHERE paciente_id = s.paciente_id)';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM seguimientos s WHERE ${ULTIMO}`);
  const [rows] = await pool.query(
    `SELECT s.id, s.paciente_id AS pacienteId,
            CONCAT_WS(' ', p.nombre, p.apellido_paterno, p.apellido_materno) AS paciente,
            s.tipo, s.estado_paciente AS estado, s.contenido, c.codigo AS cama,
            s.created_at AS fecha, TIMESTAMPDIFF(MINUTE, s.created_at, NOW()) AS minutos
     FROM seguimientos s
     JOIN pacientes p ON p.id = s.paciente_id
     LEFT JOIN camas c ON c.id = s.cama_id
     WHERE ${ULTIMO}
     ORDER BY s.created_at DESC LIMIT ? OFFSET ?`, [limit, offset]);
  res.set('X-Total-Count', String(total)).json(rows);
}));

module.exports = router;
