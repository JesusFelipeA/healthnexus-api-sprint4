// Crea un usuario de prueba por rol (médico, enfermería, farmacia y administrador). Se puede ejecutar varias veces.
//   docker compose exec api node scripts/crear-usuarios-qa.js
// Clave de los usuarios: QA_PASS (por defecto Qa-Hospital-2026!). Solo para ambientes de desarrollo o pruebas.
// El médico inicia sesión en dos pasos (contraseña + PIN), así que también recibe un PIN de prueba:
// QA_PIN (4 dígitos, por defecto 2468). Si el médico ya tenía PIN, no se cambia.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../src/db');

const CLAVE = process.env.QA_PASS || 'Qa-Hospital-2026!';
const PIN = String(process.env.QA_PIN || '2468');
const USUARIOS = [
  ['QA Medico', 'qa.medico@healthnexus.test', 'medico'],
  ['QA Enfermeria', 'qa.enfermeria@healthnexus.test', 'enfermeria'],
  ['QA Farmacia', 'qa.farmacia@healthnexus.test', 'farmacia'],
  ['QA Administrador', 'qa.admin@healthnexus.test', 'administrador'],   // consulta cuentas y recibos
];

(async () => {
  if (!/^\d{4}$/.test(PIN)) {
    console.log('QA_PIN debe tener exactamente 4 dígitos.');
    process.exit(1);
  }
  // Usa el mismo model_type que ya tienen los usuarios existentes (App\Models\User en Laravel)
  const [[ref]] = await pool.query('SELECT model_type FROM model_has_roles LIMIT 1');
  const tipo = ref ? ref.model_type : 'App\\Models\\User';
  const hash = await bcrypt.hash(CLAVE, 10);
  // Mismo formato que Laravel ($2y$), para que el PIN también funcione en la web
  const pinHash = (await bcrypt.hash(PIN, 10)).replace('$2a$', '$2y$');

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

    if (rol === 'medico') {
      const [up] = await pool.query(
        "UPDATE users SET pin = ?, updated_at = NOW() WHERE id = ? AND (pin IS NULL OR pin = '')",
        [pinHash, u.id]);
      console.log(up.affectedRows ? `  PIN asignado a ${email}` : `  ${email} ya tenía PIN; no se cambió`);
    }
  }
  console.log(`Listo. Clave de los usuarios de prueba: ${CLAVE} · PIN del médico: ${PIN}`);
  await pool.end();
})().catch((e) => { console.error('Error:', e.message); process.exit(1); });
