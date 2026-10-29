const router = require('express').Router();
const pool = require('../db');
const { ah, HttpError, auth, roles, audit, idValido } = require('../middleware');
const { AHORA_MX } = require('../hora');

/* ---------------- INTERNAS (movimientos de cama entre áreas) ---------------- */

// GET /api/derivaciones/camas  -> camas disponibles para elegir destino de un traslado
router.get('/camas', auth, roles('medico', 'enfermeria'), ah(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT c.id, c.codigo, c.area, c.tipo, COALESCE(sv.nombre, c.area) AS servicio
     FROM camas c LEFT JOIN servicios sv ON sv.id = c.servicio_id
     WHERE c.activo = 1 AND c.estado = 'disponible' ORDER BY servicio, c.codigo`);
  res.json(rows);
}));

// GET /api/derivaciones/internas
router.get('/internas', auth, roles('medico', 'enfermeria'), ah(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT cp.id, cp.paciente_id AS pacienteId,
            CONCAT_WS(' ', p.nombre, p.apellido_paterno, p.apellido_materno) AS paciente,
            COALESCE(sv.nombre, c.area) AS destino, c.codigo AS cama, u.name AS responsable,
            IF(cp.activa = 1, 'confirmada', 'finalizada') AS estado,
            cp.fecha_ingreso AS fechaIngreso, cp.fecha_egreso AS fechaEgreso, cp.motivo
     FROM cama_paciente cp
     JOIN camas c ON c.id = cp.cama_id
     LEFT JOIN servicios sv ON sv.id = c.servicio_id
     JOIN pacientes p ON p.id = cp.paciente_id
     LEFT JOIN users u ON u.id = cp.user_id
     ORDER BY cp.activa DESC, cp.fecha_ingreso DESC LIMIT 300`);
  res.json(rows);
}));

// POST /api/derivaciones/internas  { pacienteId, camaId, motivo }
router.post('/internas', auth, roles('medico'), ah(async (req, res) => {
  const { motivo } = req.body || {};
  const pacienteId = idValido((req.body || {}).pacienteId);
  const camaId = idValido((req.body || {}).camaId);
  if (!pacienteId || !camaId) throw new HttpError(400, 'pacienteId y camaId son obligatorios (números)');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[cama]] = await conn.query('SELECT id, codigo, estado FROM camas WHERE id = ? AND activo = 1 FOR UPDATE', [camaId]);
    if (!cama) throw new HttpError(404, 'Cama no encontrada');
    if (cama.estado !== 'disponible') throw new HttpError(409, 'La cama no está disponible');
    const [[pac]] = await conn.query('SELECT id FROM pacientes WHERE id = ? AND activo = 1', [pacienteId]);
    if (!pac) throw new HttpError(404, 'Paciente no encontrado');

    // Cierra la cama activa anterior del paciente (pasa a limpieza)
    const [prev] = await conn.query('SELECT id, cama_id FROM cama_paciente WHERE paciente_id = ? AND activa = 1', [pacienteId]);
    for (const p of prev) {
      await conn.query(`UPDATE cama_paciente SET activa = 0, fecha_egreso = ${AHORA_MX}, updated_at = NOW() WHERE id = ?`, [p.id]);
      await conn.query("UPDATE camas SET estado = 'limpieza', updated_at = NOW() WHERE id = ?", [p.cama_id]);
    }
    const [r] = await conn.query(
      `INSERT INTO cama_paciente (cama_id, paciente_id, user_id, fecha_ingreso, motivo, activa, created_at, updated_at)
       VALUES (?,?,?,${AHORA_MX},?,1,NOW(),NOW())`, [camaId, pacienteId, req.user.id, motivo || null]);
    await conn.query("UPDATE camas SET estado = 'ocupada', updated_at = NOW() WHERE id = ?", [camaId]);
    await conn.query('UPDATE admisiones SET cama_id = ?, updated_at = NOW() WHERE id = (SELECT m FROM (SELECT MAX(id) AS m FROM admisiones WHERE paciente_id = ?) x)', [camaId, pacienteId]);
    await conn.query(
      `INSERT INTO seguimientos (paciente_id, user_id, cama_id, tipo, contenido, created_at, updated_at)
       VALUES (?,?,?,'traslado',?,NOW(),NOW())`, [pacienteId, req.user.id, camaId, `Traslado interno a cama ${cama.codigo}${motivo ? ': ' + motivo : ''}`]);
    await audit(req, { evento: 'created', modulo: 'derivaciones_internas', descripcion: `Traslado interno a cama ${cama.codigo}`, tipo: 'cama_paciente', id: r.insertId, despues: { pacienteId, camaId } }, conn);
    await conn.commit();
    res.status(201).json({ id: r.insertId, estado: 'confirmada', cama: cama.codigo });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

// PATCH /api/derivaciones/internas/:id  { estado: 'finalizada' }  -> libera la cama
router.patch('/internas/:id', auth, roles('medico', 'enfermeria'), ah(async (req, res) => {
  if ((req.body || {}).estado !== 'finalizada') throw new HttpError(400, "Estado inválido. Usa: 'finalizada'");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[cp]] = await conn.query('SELECT id, cama_id, activa FROM cama_paciente WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!cp) throw new HttpError(404, 'Derivación no encontrada');
    if (cp.activa !== 1) throw new HttpError(409, 'La derivación ya estaba finalizada');
    await conn.query('UPDATE cama_paciente SET activa = 0, fecha_egreso = NOW(), updated_at = NOW() WHERE id = ?', [cp.id]);
    await conn.query("UPDATE camas SET estado = 'limpieza', updated_at = NOW() WHERE id = ?", [cp.cama_id]);
    await audit(req, { evento: 'updated', modulo: 'derivaciones_internas', descripcion: 'Derivación interna finalizada', tipo: 'cama_paciente', id: cp.id }, conn);
    await conn.commit();
    res.json({ id: cp.id, estado: 'finalizada' });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

/* ---------------- EXTERNAS (traslado a otro hospital, sobre admisiones) ---------------- */

// GET /api/derivaciones/externas
router.get('/externas', auth, roles('medico'), ah(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.id, a.paciente_id AS pacienteId,
            CONCAT_WS(' ', p.nombre, p.apellido_paterno, p.apellido_materno) AS paciente,
            h.id AS hospitalId, h.nombre AS hospital, a.motivo_derivacion AS motivo,
            a.fecha_derivacion AS fecha, a.estado, a.folio
     FROM admisiones a
     JOIN pacientes p ON p.id = a.paciente_id
     JOIN hospitales h ON h.id = a.hospital_derivado_id
     ORDER BY a.fecha_derivacion DESC LIMIT 300`);
  res.json(rows);
}));

// POST /api/derivaciones/externas  { pacienteId, hospitalId, motivo }
router.post('/externas', auth, roles('medico'), ah(async (req, res) => {
  const { motivo } = req.body || {};
  const pacienteId = idValido((req.body || {}).pacienteId);
  const hospitalId = idValido((req.body || {}).hospitalId);
  if (!pacienteId || !hospitalId || !motivo || String(motivo).trim().length < 3) throw new HttpError(400, 'pacienteId, hospitalId (números) y motivo son obligatorios');
  const [[h]] = await pool.query('SELECT id, nombre FROM hospitales WHERE id = ? AND activo = 1', [hospitalId]);
  if (!h) throw new HttpError(404, 'Hospital no encontrado');
  const [[adm]] = await pool.query('SELECT id, estado, folio FROM admisiones WHERE paciente_id = ? ORDER BY id DESC LIMIT 1', [pacienteId]);
  if (!adm) throw new HttpError(404, 'El paciente no tiene admisión registrada');
  if (adm.estado === 'derivado') throw new HttpError(409, 'El paciente ya fue derivado a otro hospital');
  await pool.query(
    `UPDATE admisiones SET hospital_derivado_id = ?, estado = 'derivado', fecha_derivacion = NOW(), motivo_derivacion = ?, updated_at = NOW() WHERE id = ?`,
    [hospitalId, String(motivo).trim(), adm.id]);
  await audit(req, { evento: 'created', modulo: 'derivaciones_externas', descripcion: `Traslado externo a ${h.nombre}`, tipo: 'admision', id: adm.id, despues: { hospitalId, pacienteId }, severidad: 'warning', sensible: 1 });
  res.status(201).json({ id: adm.id, folio: adm.folio, hospital: h.nombre, estado: 'derivado' });
}));

module.exports = router;
