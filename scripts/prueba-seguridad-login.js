// Actividad 09 – Pruebas de seguridad del módulo de Inicio de sesión (autenticación).
// Crea usuarios temporales, ejecuta las 2 pruebas y los elimina al terminar.
//   Uso:  node scripts/prueba-seguridad-login.js          (API en http://localhost:3000/api)
//   Otra URL:  API_URL=http://localhost:3000/api node scripts/prueba-seguridad-login.js
// Resultado por prueba: VULNERABLE (falla presente) o PROTEGIDO (falla corregida).
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../src/db');

const BASE = process.env.API_URL || 'http://localhost:3000/api';
const PASS = 'Prueba#Act09';
const U_SESION = 'act09.sesion@healthnexus.local';
const U_FUERZA = 'act09.fuerza@healthnexus.local';

async function http(method, path, { token, body, headers } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, json };
}

async function crearUsuario(email, rol) {
  const [[r]] = await pool.query('SELECT id FROM roles WHERE name = ?', [rol]);
  const hash = bcrypt.hashSync(PASS, 10).replace('$2a$', '$2y$');
  const [u] = await pool.query('INSERT INTO users (name, nombre, email, password, activo, created_at, updated_at) VALUES (?,?,?,?,1,NOW(),NOW())', [`Prueba ${email.split('@')[0]}`, 'Prueba', email, hash]);
  await pool.query('INSERT INTO model_has_roles (role_id, model_type, model_id) VALUES (?, ?, ?)', [r.id, 'App\\Models\\User', u.insertId]);
  return u.insertId;
}
async function borrarUsuarios() {
  const [rows] = await pool.query('SELECT id FROM users WHERE email IN (?, ?)', [U_SESION, U_FUERZA]);
  for (const u of rows) {
    await pool.query("DELETE FROM model_has_roles WHERE model_id = ? AND model_type LIKE '%User'", [u.id]);
    await pool.query('DELETE FROM users WHERE id = ?', [u.id]);
  }
}

(async () => {
  const resumen = [];
  await borrarUsuarios();
  const idSesion = await crearUsuario(U_SESION, 'enfermeria');
  await crearUsuario(U_FUERZA, 'enfermeria');
  try {
    // ───────── PRUEBA 2 (se ejecuta primero para no verse afectada por el bloqueo de la prueba 1) ─────────
    console.log('\n=== PRUEBA 2: ¿el token sigue sirviendo si el usuario se desactiva o cambia de rol? ===');
    const login = await http('POST', '/auth/login', { body: { email: U_SESION, password: PASS } });
    const token = login.json && login.json.token;
    console.log(`1) Login de ${U_SESION} (rol enfermería) -> HTTP ${login.status}, token ${token ? 'recibido' : 'NO recibido'}`);
    const base = await http('GET', '/patients', { token });
    console.log(`2) GET /patients con el token (rol enfermería: permitido) -> HTTP ${base.status}`);

    await pool.query('UPDATE users SET activo = 0 WHERE id = ?', [idSesion]);
    const desact = await http('GET', '/patients', { token });
    console.log(`3) Se DESACTIVA la cuenta (users.activo = 0) y se repite GET /patients con el MISMO token -> HTTP ${desact.status} ${desact.status === 200 ? '(la cuenta desactivada sigue entrando)' : '(acceso negado)'}`);
    await pool.query('UPDATE users SET activo = 1 WHERE id = ?', [idSesion]);

    const [[farm]] = await pool.query("SELECT id FROM roles WHERE name = 'farmacia'");
    await pool.query("UPDATE model_has_roles SET role_id = ? WHERE model_id = ? AND model_type LIKE '%User'", [farm.id, idSesion]);
    const rolNuevo = await http('GET', '/patients', { token });
    console.log(`4) Se CAMBIA el rol a farmacia (sin permiso sobre pacientes) y se repite GET /patients con el MISMO token -> HTTP ${rolNuevo.status} ${rolNuevo.status === 200 ? '(sigue usando el rol anterior)' : '(permiso actualizado)'}`);
    const vuln2 = desact.status === 200 || rolNuevo.status === 200;
    console.log(`>>> RESULTADO PRUEBA 2: ${vuln2 ? 'VULNERABLE' : 'PROTEGIDO'}`);
    resumen.push(['Prueba 2 – Sesión no se invalida (cuenta desactivada / cambio de rol)', vuln2 ? 'VULNERABLE' : 'PROTEGIDO']);

    // ───────── PRUEBA 1 ─────────
    console.log('\n=== PRUEBA 1: fuerza bruta de contraseñas (12 intentos, cambiando la IP con X-Forwarded-For) ===');
    const codigos = [];
    for (let i = 1; i <= 12; i++) {
      const r = await http('POST', '/auth/login', { body: { email: U_FUERZA, password: `incorrecta${i}` }, headers: { 'X-Forwarded-For': `203.0.113.${i}` } });
      codigos.push(r.status);
    }
    console.log(`Códigos HTTP de los 12 intentos fallidos: ${codigos.join(' ')}`);
    const final = await http('POST', '/auth/login', { body: { email: U_FUERZA, password: PASS }, headers: { 'X-Forwarded-For': '203.0.113.99' } });
    console.log(`Intento 13 con la contraseña CORRECTA (otra IP falsa) -> HTTP ${final.status} ${final.status === 200 ? '(la cuenta nunca se bloqueó)' : '(cuenta bloqueada)'}`);
    const vuln1 = !codigos.includes(429) || final.status === 200;
    console.log(`>>> RESULTADO PRUEBA 1: ${vuln1 ? 'VULNERABLE' : 'PROTEGIDO'}`);
    resumen.push(['Prueba 1 – Sin bloqueo efectivo ante fuerza bruta (límite evadible)', vuln1 ? 'VULNERABLE' : 'PROTEGIDO']);
  } finally {
    await borrarUsuarios();
    await pool.end();
  }
  console.log('\n--- RESUMEN ---');
  resumen.forEach(([n, r]) => console.log(`${r.padEnd(11)} ${n}`));
})().catch((e) => { console.error('Error en la prueba:', e.message); process.exit(1); });
