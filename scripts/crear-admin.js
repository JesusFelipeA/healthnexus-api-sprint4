require("dotenv").config();
const bcrypt = require("bcryptjs");
const pool = require("../src/config/db");

(async () => {
  const [nombre, email, password] = process.argv.slice(2);
  if (!nombre || !email || !password) {
    console.log('Uso: node scripts/crear-admin.js "Nombre" correo password');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    'INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES (?, ?, ?, "admin")',
    [nombre, email, hash],
  );
  console.log("Usuario admin creado:", email);
  await pool.end();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
