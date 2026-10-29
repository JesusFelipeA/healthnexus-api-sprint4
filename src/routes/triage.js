const router = require('express').Router();
const crypto = require('crypto');
const pool = require('../db');
const { ah, HttpError, auth, roles, audit, paginar } = require('../middleware');
const { notificarRoles } = require('../push');
const { AHORA_MX } = require('../hora');

const NIVELES = ['rojo', 'naranja', 'amarillo', 'verde', 'azul'];
const ALIAS = { red: 'rojo', yellow: 'amarillo', green: 'verde', critico: 'rojo', urgente: 'amarillo', leve: 'verde' };
const normNivel = (v) => { const n = ALIAS[String(v || '').toLowerCase()] || String(v || '').toLowerCase(); return NIVELES.includes(n) ? n : null; };
const ACTIVAS = "('en_espera','atendido','hospitalizado')";

// Motivo de consulta y diagnóstico presuntivo (no se copian a la bitácora: son datos clínicos) (columnas admisiones.motivo y admisiones.diagnostico_presuntivo,
// las mismas que lee la aplicación web). Si no se envían, no se tocan los que ya existan.
function textoClinico(valor, etiqueta) {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== 'string') throw new HttpError(400, `${etiqueta} debe ser texto`);
  const t = valor.trim();
  if (!t) return null;
  if (t.length < 3) throw new HttpError(400, `${etiqueta} debe tener al menos 3 caracteres`);
  if (t.length > 1000) throw new HttpError(400, `${etiqueta} no puede pasar de 1000 caracteres`);
  return t;
}

// GET /api/triage?q=&nivel=rojo|naranja|amarillo|verde|azul|sin
//   Pacientes con su triage actual (el de su admisión activa). "sin" = sin clasificar.
router.get('/triage', auth, roles('medico', 'enfermeria'), ah(async (req, res) => {
  const params = []; let where = 'WHERE p.activo = 1';
  const q = String(req.query.q || '').trim();
  if (q) { where += " AND (CONCAT_WS(' ', p.nombre, p.apellido_paterno, p.apellido_materno) LIKE ? OR p.curp LIKE ?)"; params.push(`%${q}%`, `%${q}%`); }
  if (req.query.nivel === 'sin') where += ' AND a.triage IS NULL';
  else if (req.query.nivel) {
    const n = normNivel(req.query.nivel);
    if (!n) throw new HttpError(400, `nivel inválido. Usa: ${NIVELES.join(', ')} o sin`);
    where += ' AND a.triage = ?'; params.push(n);
  }
  const { limit, offset } = paginar(req, { def: 500, max: 1000 });
  const [rows] = await pool.query(
    `SELECT p.id, CONCAT_WS(' ', p.nombre, p.apellido_paterno, p.apellido_materno) AS name,
            TIMESTAMPDIFF(YEAR, p.fecha_nacimiento, CURDATE()) AS age, p.sexo,
            a.id AS admisionId, a.triage AS triageLevel, a.estado AS status, a.fecha_hora_llegada AS arrivedAt,
            a.motivo AS reason, a.diagnostico_presuntivo AS diagnosticoPresuntivo
     FROM pacientes p
     LEFT JOIN admisiones a ON a.id = (SELECT MAX(id) FROM admisiones WHERE paciente_id = p.id AND estado IN ${ACTIVAS})
     ${where}
     ORDER BY (a.triage IS NULL), FIELD(a.triage, 'rojo','naranja','amarillo','verde','azul'), p.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  res.json(rows);
}));

// PATCH /api/patients/:id/triage  { triageLevel, motivo?, diagnosticoPresuntivo? }
//   Solo el médico (y el administrador) cambia el nivel de triage. Si el paciente no tiene una admisión activa, se crea una al clasificarlo.
router.patch('/patients/:id(\\d+)/triage', auth, roles('medico'), ah(async (req, res) => {
  const nivel = normNivel((req.body || {}).triageLevel);
  if (!nivel) throw new HttpError(400, `triageLevel inválido. Usa: ${NIVELES.join(', ')}`);
  const motivo = textoClinico((req.body || {}).motivo, 'El motivo de consulta');
  const diagnostico = textoClinico((req.body || {}).diagnosticoPresuntivo, 'El diagnóstico presuntivo');
  const [[pac]] = await pool.query('SELECT id FROM pacientes WHERE id = ? AND activo = 1', [req.params.id]);
  if (!pac) throw new HttpError(404, 'Paciente no encontrado');
  const critico = nivel === 'rojo' ? 'critical' : 'info';

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[adm]] = await conn.query(`SELECT id, triage FROM admisiones WHERE paciente_id = ? AND estado IN ${ACTIVAS} ORDER BY id DESC LIMIT 1 FOR UPDATE`, [pac.id]);
    let out;
    if (adm) {
      await conn.query(
        `UPDATE admisiones SET triage = ?, motivo = COALESCE(?, motivo), diagnostico_presuntivo = COALESCE(?, diagnostico_presuntivo),
                medico_id = COALESCE(medico_id, ?), updated_at = NOW() WHERE id = ?`,
        [nivel, motivo, diagnostico, req.user.id, adm.id]);
      await audit(req, { evento: 'triage_cambiado', modulo: 'triage', descripcion: `Triage cambiado de ${adm.triage || 'sin clasificar'} a ${nivel}`, tipo: 'paciente', id: pac.id, antes: { triage: adm.triage }, despues: { triage: nivel, motivoActualizado: !!motivo, diagnosticoActualizado: !!diagnostico }, severidad: critico }, conn);
      out = { id: pac.id, admisionId: adm.id, triageLevel: nivel, admisionCreada: false };
    } else {
      const folio = `ADM-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(pac.id).padStart(5, '0')}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
      const [a] = await conn.query(
        `INSERT INTO admisiones (paciente_id, user_id, medico_id, folio, fecha_hora_llegada, tipo, triage, motivo, diagnostico_presuntivo, estado, created_at, updated_at)
         VALUES (?,?,?,?,${AHORA_MX},'urgencias',?,?,?,'en_espera',NOW(),NOW())`,
        [pac.id, req.user.id, req.user.id, folio, nivel, motivo, diagnostico]);
      await audit(req, { evento: 'triage_cambiado', modulo: 'triage', descripcion: `Paciente clasificado en triage ${nivel} (admisión creada)`, tipo: 'paciente', id: pac.id, despues: { triage: nivel, admision: a.insertId, motivoActualizado: !!motivo, diagnosticoActualizado: !!diagnostico }, severidad: critico }, conn);
      out = { id: pac.id, admisionId: a.insertId, triageLevel: nivel, admisionCreada: true };
    }
    await conn.commit();
    if (nivel === 'rojo') {
      // Nivel I (reanimación): aviso a médicos, sin nombre del paciente.
      notificarRoles(['medico'], {
        titulo: 'Paciente en nivel I · Reanimación',
        cuerpo: 'Se clasificó un paciente en nivel I. Revisa Triage.',
        datos: { tipo: 'triage_rojo', pantalla: 'Triage' },
      }, { excluirUserId: req.user.id });
    }
    res.json(out);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

module.exports = router;
