// Crea un usuario con rol para probar la app (compatible con tu proyecto Laravel).
// Uso:  node scripts/crear-usuario.js correo@hospital.com "Nombre Apellido" enfermeria "Contraseña123"
// Roles: administrador | medico | enfermeria | farmacia
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../src/db');

(async () => {
  const [email, nombre, rol, password] = process.argv.slice(2);
  if (!email || !nombre || !rol || !password) {
    console.log('Uso: node scripts/crear-usuario.js correo "Nombre Apellido" rol contraseña');
    process.exit(1);
  }
  if (password.length < 8) { console.log('La contraseña debe tener al menos 8 caracteres'); process.exit(1); }
  const [[r]] = await pool.query('SELECT id FROM roles WHERE name = ?', [rol]);
  if (!r) { console.log(`El rol "${rol}" no existe en la tabla roles`); process.exit(1); }
  const [[dup]] = await pool.query('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
  if (dup) { console.log('Ya existe un usuario con ese correo'); process.exit(1); }

  const hash = bcrypt.hashSync(password, 12).replace('$2a$', '$2y$'); // formato de Laravel
  const partes = nombre.trim().split(/\s+/);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [u] = await conn.query(
      'INSERT INTO users (name, nombre, apellido_paterno, email, password, activo, created_at, updated_at) VALUES (?,?,?,?,?,1,NOW(),NOW())',
      [nombre.trim(), partes[0], partes.slice(1).join(' ') || null, email.toLowerCase(), hash]);
    await conn.query('INSERT INTO model_has_roles (role_id, model_type, model_id) VALUES (?, ?, ?)', [r.id, 'App\\Models\\User', u.insertId]);
    await conn.commit();
    console.log(`Usuario creado: ${email} (${rol}), id ${u.insertId}`);
  } catch (e) { await conn.rollback(); console.error('Error:', e.message); process.exitCode = 1; } finally { conn.release(); await pool.end(); }
})();
