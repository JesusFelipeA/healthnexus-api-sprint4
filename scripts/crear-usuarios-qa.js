// Crea un usuario de prueba por rol (médico, enfermería, farmacia y administrador). Se puede ejecutar varias veces.
//   docker compose exec api node scripts/crear-usuarios-qa.js
// Clave de los usuarios: QA_PASS (por defecto Qa-Hospital-2026!). Solo para ambientes de desarrollo o pruebas.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../src/db');

const CLAVE = process.env.QA_PASS || 'Qa-Hospital-2026!';
const USUARIOS = [
  ['QA Medico', 'qa.medico@healthnexus.test', 'medico'],
  ['QA Enfermeria', 'qa.enfermeria@healthnexus.test', 'enfermeria'],
  ['QA Farmacia', 'qa.farmacia@healthnexus.test', 'farmacia'],
  ['QA Administrador', 'qa.admin@healthnexus.test', 'administrador'],   // consulta cuentas y recibos
];

(async () => {
  // Usa el mismo model_type que ya tienen los usuarios existentes (App\Models\User en Laravel)
  const [[ref]] = await pool.query('SELECT model_type FROM model_has_roles LIMIT 1');
  const tipo = ref ? ref.model_type : 'App\\Models\\User';
  const hash = await bcrypt.hash(CLAVE, 10);

  for (const [name, email, rol] of USUARIOS) {
    const [[r]] = await pool.query('SELECT id FROM roles WHERE name = ? LIMIT 1', [rol]);
    if (!r) { console.log(`No existe el rol "${rol}" en la tabla roles; se omite ${email}`); continue; }

    let [[u]] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (u) console.log(`Ya existía ${email}`);
    else {
      const [ins] = await pool.query(
        'INSERT INTO users (name, email, password, activo, created_at, updated_at) VALUES (?, ?, ?, 1, NOW(), NOW())',
        [name, email, hash]);
      u = { id: ins.insertId };
      console.log(`Creado ${email} (${rol})`);
    }
    await pool.query(
      `INSERT INTO model_has_roles (role_id, model_type, model_id)
       SELECT ?, ?, ? FROM DUAL
       WHERE NOT EXISTS (SELECT 1 FROM model_has_roles WHERE role_id = ? AND model_type = ? AND model_id = ?)`,
      [r.id, tipo, u.id, r.id, tipo, u.id]);
  }
  console.log(`Listo. Clave de los usuarios de prueba: ${CLAVE}`);
  await pool.end();
})().catch((e) => { console.error('Error:', e.message); process.exit(1); });
