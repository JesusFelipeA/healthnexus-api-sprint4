const router = require('express').Router();
const pool = require('../db');
const { ah, HttpError, auth, roles, audit, paginar } = require('../middleware');

const ACTIVAS = "('en_espera','atendido','hospitalizado')";
const NIVELES = ['rojo', 'naranja', 'amarillo', 'verde', 'azul'];
// Triage actual = el de la admisión activa más reciente (el mismo criterio que GET /triage)
const TRIAGE_ACTUAL = `(SELECT a.triage FROM admisiones a WHERE a.paciente_id = p.id AND a.estado IN ${ACTIVAS} ORDER BY a.id DESC LIMIT 1)`;
const SEXOS = ['hombre', 'mujer', 'otro'];
const ESTADOS_CIVILES = ['Soltero', 'Casado', 'Divorciado', 'Unión Libre', 'Viudo'];
const SANGRE = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const NACIONALIDADES = ['MEXICANA', 'EXTRANJERA'];
const CURP_RE = /^[A-Z]{4}\d{6}[HMX][A-Z]{2}[B-DF-HJ-NP-TV-Z]{3}[A-Z0-9]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const NOMBRE_COMPLETO = "CONCAT_WS(' ', p.nombre, p.apellido_paterno, p.apellido_materno)";
const EDAD = 'TIMESTAMPDIFF(YEAR, p.fecha_nacimiento, CURDATE())';

// GET /api/stats  -> totales del dashboard (admisiones activas por nivel de triage)
router.get('/stats', auth, roles('medico', 'enfermeria'), ah(async (req, res) => {
  const [[t]] = await pool.query('SELECT COUNT(*) AS n FROM pacientes WHERE activo = 1');
  const [[c]] = await pool.query(
    `SELECT
       SUM(triage = 'rojo') AS rojo,
       SUM(triage IN ('naranja','amarillo')) AS amarillo,
       SUM(triage IN ('verde','azul')) AS verde
     FROM admisiones WHERE estado IN ${ACTIVAS}`);
  res.json({ totalPatients: t.n, redCount: Number(c.rojo || 0), yellowCount: Number(c.amarillo || 0), greenCount: Number(c.verde || 0) });
}));

// GET /api/patients?q=texto&nivel=&limit=&page=  -> pacientes (nombre, edad, sexo, CURP, teléfono y triage actual)
router.get('/patients', auth, roles('medico', 'enfermeria'), ah(async (req, res) => {
  const params = []; let where = 'WHERE p.activo = 1';
  const q = String(req.query.q || '').trim();
  if (q) {
    where += ` AND (${NOMBRE_COMPLETO} LIKE ? OR p.curp LIKE ? OR p.telefono_principal LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  // HU-38: ?nivel=rojo|naranja|amarillo|verde|azul|sin
  const nivel = String(req.query.nivel || '').trim().toLowerCase();
  if (nivel === 'sin') where += ` AND ${TRIAGE_ACTUAL} IS NULL`;
  else if (nivel) {
    if (!NIVELES.includes(nivel)) throw new HttpError(400, `nivel inválido. Usa: ${NIVELES.join(', ')} o sin`);
    where += ` AND ${TRIAGE_ACTUAL} = ?`; params.push(nivel);
  }
  const { limit, offset } = paginar(req, { def: 500, max: 1000 });
  const [rows] = await pool.query(
    `SELECT p.id, ${NOMBRE_COMPLETO} AS name, ${EDAD} AS age, p.sexo, p.curp, p.telefono_principal AS telefono,
            ${TRIAGE_ACTUAL} AS triageLevel
     FROM pacientes p ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  res.json(rows);
}));

const FULL_SQL = `
  SELECT p.id, p.nombre, p.apellido_paterno AS apellidoPaterno, p.apellido_materno AS apellidoMaterno,
         p.fecha_nacimiento AS fechaNacimiento, ${EDAD} AS edad, p.sexo, p.estado_civil AS estadoCivil,
         p.nacionalidad, p.pais_nacimiento AS paisNacimiento, p.estado_nacimiento AS estadoNacimiento,
         p.curp, p.pasaporte, p.telefono_principal AS telefonoPrincipal, p.correo_electronico AS correoElectronico,
         p.ocupacion, p.responsable_nombre AS responsableNombre, p.tipo_sanguineo AS tipoSanguineo,
         p.alergias, p.enfermedades_cronicas AS enfermedadesCronicas,
         p.estado_id AS estadoId, e.nombre AS estado, p.municipio_id AS municipioId, m.nombre AS municipio,
         p.colonia, p.calle, p.numero_exterior AS numeroExterior, p.numero_interior AS numeroInterior,
         p.activo, p.created_at AS creadoEn
  FROM pacientes p
  LEFT JOIN estados e ON e.id = p.estado_id
  LEFT JOIN municipios m ON m.id = p.municipio_id`;

// GET /api/patients/:id  -> registro completo del paciente (todos los campos de la tabla)
router.get('/patients/:id(\\d+)', auth, roles('medico', 'enfermeria'), ah(async (req, res) => {
  const [[p]] = await pool.query(`${FULL_SQL} WHERE p.id = ? AND p.activo = 1`, [req.params.id]);
  if (!p) throw new HttpError(404, 'Paciente no encontrado');
  res.json(p);
}));

/* ---------- validación del alta de paciente ---------- */

// Texto opcional/obligatorio, recortado y con longitud máxima
function txt(b, key, label, { max = 255, required = false } = {}) {
  const v = b[key] === undefined || b[key] === null ? '' : String(b[key]).trim();
  if (!v) { if (required) throw new HttpError(400, `${label} es obligatorio`); return null; }
  if (v.length > max) throw new HttpError(400, `${label} no puede superar ${max} caracteres`);
  return v;
}

function fechaValida(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function edadDe(s) {
  const hoy = new Date(); const n = new Date(`${s}T00:00:00Z`);
  let e = hoy.getUTCFullYear() - n.getUTCFullYear();
  if (hoy.getUTCMonth() < n.getUTCMonth() || (hoy.getUTCMonth() === n.getUTCMonth() && hoy.getUTCDate() < n.getUTCDate())) e--;
  return e;
}
const enLista = (v, lista, label) => { if (!lista.includes(v)) throw new HttpError(400, `${label} inválido. Usa: ${lista.join(', ')}`); return v; };

async function parsePaciente(b) {
  const nombre = txt(b, 'nombre', 'El nombre', { required: true });
  const apellidoPaterno = txt(b, 'apellidoPaterno', 'El apellido paterno', { required: true });
  const apellidoMaterno = txt(b, 'apellidoMaterno', 'El apellido materno');

  const fechaNacimiento = txt(b, 'fechaNacimiento', 'La fecha de nacimiento', { required: true });
  if (!fechaValida(fechaNacimiento)) throw new HttpError(400, 'Fecha de nacimiento inválida. Usa el formato AAAA-MM-DD');
  if (fechaNacimiento < '1900-01-01' || fechaNacimiento > new Date().toISOString().slice(0, 10)) throw new HttpError(400, 'La fecha de nacimiento debe estar entre 1900 y hoy');
  const edad = edadDe(fechaNacimiento);

  const sexo = enLista(txt(b, 'sexo', 'El sexo', { required: true }).toLowerCase(), SEXOS, 'Sexo');
  const ec = txt(b, 'estadoCivil', 'El estado civil');
  const estadoCivil = ec ? enLista(ec, ESTADOS_CIVILES, 'Estado civil') : null;
  const nacionalidad = enLista(String(b.nacionalidad || 'MEXICANA').trim().toUpperCase(), NACIONALIDADES, 'Nacionalidad');

  let paisNacimiento = txt(b, 'paisNacimiento', 'El país de nacimiento');
  let pasaporte = txt(b, 'pasaporte', 'El pasaporte', { max: 30 });
  let estadoNacimiento = txt(b, 'estadoNacimiento', 'El estado de nacimiento');
  if (nacionalidad === 'EXTRANJERA') {
    if (!paisNacimiento) throw new HttpError(400, 'El país de nacimiento es obligatorio para extranjeros');
    if (!pasaporte) throw new HttpError(400, 'El pasaporte es obligatorio para extranjeros');
    if (estadoNacimiento) throw new HttpError(400, 'El estado de nacimiento es solo para nacionalidad MEXICANA');
  } else if (paisNacimiento || pasaporte) {
    throw new HttpError(400, 'País de nacimiento y pasaporte son solo para nacionalidad EXTRANJERA');
  }
  if (estadoNacimiento) {
    const [[e]] = await pool.query('SELECT nombre FROM estados WHERE LOWER(nombre) = LOWER(?)', [estadoNacimiento]);
    if (!e) throw new HttpError(400, 'Estado de nacimiento no encontrado en el catálogo');
    estadoNacimiento = e.nombre;
  }

  let curp = txt(b, 'curp', 'La CURP', { max: 18 });
  if (curp) { curp = curp.toUpperCase(); if (!CURP_RE.test(curp)) throw new HttpError(400, 'CURP inválida (18 caracteres con el formato oficial)'); }

  let tel = txt(b, 'telefonoPrincipal', 'El teléfono', { max: 20 });
  if (tel) {
    tel = tel.replace(/\D/g, '');
    if (nacionalidad === 'MEXICANA' ? tel.length !== 10 : (tel.length < 7 || tel.length > 15)) throw new HttpError(400, nacionalidad === 'MEXICANA' ? 'El teléfono debe tener 10 dígitos' : 'El teléfono debe tener entre 7 y 15 dígitos');
  }
  let correo = txt(b, 'correoElectronico', 'El correo electrónico');
  if (correo) { correo = correo.toLowerCase(); if (!EMAIL_RE.test(correo)) throw new HttpError(400, 'Correo electrónico inválido'); }

  const ocupacion = txt(b, 'ocupacion', 'La ocupación');
  const responsableNombre = txt(b, 'responsableNombre', 'El nombre del responsable', { required: edad < 18 });
  const tsg = txt(b, 'tipoSanguineo', 'El tipo sanguíneo');
  const tipoSanguineo = tsg ? enLista(tsg.toUpperCase(), SANGRE, 'Tipo sanguíneo') : null;
  const alergias = txt(b, 'alergias', 'Las alergias', { max: 2000 });
  const enfermedadesCronicas = txt(b, 'enfermedadesCronicas', 'Las enfermedades crónicas', { max: 2000 });

  // Domicilio: el municipio debe pertenecer al estado
  let estadoId = b.estadoId ? Number(b.estadoId) : null;
  let municipioId = b.municipioId ? Number(b.municipioId) : null;
  if ((b.estadoId && !Number.isInteger(estadoId)) || (b.municipioId && !Number.isInteger(municipioId))) throw new HttpError(400, 'estadoId y municipioId deben ser números');
  if (municipioId) {
    const [[m]] = await pool.query('SELECT estado_id FROM municipios WHERE id = ?', [municipioId]);
    if (!m) throw new HttpError(400, 'Municipio no encontrado');
    if (estadoId && m.estado_id !== estadoId) throw new HttpError(400, 'El municipio no pertenece al estado seleccionado');
    estadoId = m.estado_id;
  }
  if (estadoId) {
    const [[e]] = await pool.query('SELECT id FROM estados WHERE id = ?', [estadoId]);
    if (!e) throw new HttpError(400, 'Estado no encontrado');
  }
  return {
    nombre, apellido_paterno: apellidoPaterno, apellido_materno: apellidoMaterno, fecha_nacimiento: fechaNacimiento, sexo,
    estado_civil: estadoCivil, nacionalidad, pais_nacimiento: paisNacimiento, estado_nacimiento: estadoNacimiento, curp, pasaporte,
    telefono_principal: tel, correo_electronico: correo, ocupacion, responsable_nombre: responsableNombre, tipo_sanguineo: tipoSanguineo,
    alergias, enfermedades_cronicas: enfermedadesCronicas, estado_id: estadoId, municipio_id: municipioId,
    colonia: txt(b, 'colonia', 'La colonia'), calle: txt(b, 'calle', 'La calle'),
    numero_exterior: txt(b, 'numeroExterior', 'El número exterior', { max: 30 }), numero_interior: txt(b, 'numeroInterior', 'El número interior', { max: 30 }),
  };
}

// POST /api/patients  -> da de alta un paciente con TODOS los campos de la tabla pacientes
// Obligatorios: nombre, apellidoPaterno, fechaNacimiento (AAAA-MM-DD), sexo. El resto es opcional.
router.post('/patients', auth, roles('medico', 'enfermeria'), ah(async (req, res) => {
  const d = await parsePaciente(req.body || {});
  const cols = Object.keys(d);
  let r;
  try {
    [r] = await pool.query(
      `INSERT INTO pacientes (${cols.join(', ')}, activo, created_at, updated_at) VALUES (${cols.map(() => '?').join(', ')}, 1, NOW(), NOW())`,
      cols.map((c) => d[c]));
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Ya existe un paciente registrado con esa CURP');
    throw e;
  }
  await audit(req, { evento: 'created', modulo: 'pacientes', descripcion: 'Paciente registrado', tipo: 'paciente', id: r.insertId, sensible: 1 });
  const [[p]] = await pool.query(`${FULL_SQL} WHERE p.id = ?`, [r.insertId]);
  res.status(201).json(p);
}));

module.exports = router;
