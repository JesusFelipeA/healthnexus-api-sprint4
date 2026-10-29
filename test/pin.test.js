// PIN del médico en el login de la API (igual que la web): credenciales -> pinToken -> POST /auth/pin -> token.
process.env.JWT_SECRET = 'secreto-de-pruebas';
process.env.RATE_LIMIT_MAX = '1000';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const llamadas = [];
const passHash = bcrypt.hashSync('Clave123!', 4);
const pinHash = bcrypt.hashSync('4821', 4);
let usuario;
let bloqueado = false;
let siguienteId = 100; // un id por prueba: el límite de PIN fallidos es por usuario
const pool = {
  query: async (sql, params = []) => {
    llamadas.push({ sql, params });
    if (/FROM users u/.test(sql)) return [[usuario]];
    if (/FROM pacientes p/.test(sql)) return [[]];
    if (/SELECT activo FROM dispositivos/.test(sql)) return [bloqueado ? [{ activo: 0 }] : []];
    if (/SELECT id FROM dispositivos/.test(sql)) return [[]];
    if (/INSERT INTO dispositivos/.test(sql)) return [{ insertId: 9 }];
    return [{ affectedRows: 1 }];
  },
};
require.cache[require.resolve(path.join(__dirname, '../src/db.js'))] = { id: 'db', filename: 'db', loaded: true, exports: pool };
const app = require('../src/app');

let server, base;
test.before(async () => { await new Promise((ok) => { server = app.listen(0, ok); }); base = `http://127.0.0.1:${server.address().port}/api`; });
test.after(() => server.close());
test.beforeEach(() => {
  llamadas.length = 0;
  bloqueado = false;
  usuario = { id: siguienteId++, name: 'Dr. Prueba', email: 'dr@h.com', password: passHash, pin: pinHash, activo: 1, rol: 'medico' };
});

const post = async (ruta, body, headers = {}) => {
  const r = await fetch(base + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Fingerprint': 'prueba-dispositivo-0001', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const login = () => post('/auth/login', { email: 'dr@h.com', password: 'Clave123!' });
const eventos = () => llamadas.filter((l) => /INSERT INTO audit_logs/.test(l.sql)).map((l) => l.params[3]);

test('PIN: el médico recibe pinToken y no token de acceso al validar credenciales', async () => {
  const r = await login();
  assert.equal(r.status, 200);
  assert.equal(r.json.requierePin, true);
  assert.ok(r.json.pinToken);
  assert.equal(r.json.token, undefined);
  assert.equal(llamadas.some((l) => /INSERT INTO dispositivos|UPDATE dispositivos/.test(l.sql)), false, 'el dispositivo se registra hasta después del PIN');
});

test('PIN: con el PIN correcto entrega token, audita y registra el dispositivo', async () => {
  const { json } = await login();
  llamadas.length = 0;
  const r = await post('/auth/pin', { pinToken: json.pinToken, pin: '4821' });
  assert.equal(r.status, 200);
  assert.ok(r.json.token);
  assert.equal(r.json.user.rol, 'medico');
  assert.deepEqual(eventos(), ['pin_exitoso', 'login', 'dispositivo_nuevo']);
});

test('PIN: incorrecto responde 401 y queda pin_fallido en la bitácora', async () => {
  const { json } = await login();
  llamadas.length = 0;
  const r = await post('/auth/pin', { pinToken: json.pinToken, pin: '0000' });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'PIN incorrecto.');
  assert.deepEqual(eventos(), ['pin_fallido']);
});

test('PIN: formato distinto de 4 dígitos responde 400', async () => {
  const { json } = await login();
  assert.equal((await post('/auth/pin', { pinToken: json.pinToken, pin: '12a4' })).status, 400);
  assert.equal((await post('/auth/pin', { pinToken: json.pinToken, pin: '12345' })).status, 400);
});

test('PIN: el pinToken no sirve como token de acceso, y un pinToken vencido se rechaza', async () => {
  const { json } = await login();
  const r = await fetch(`${base}/patients`, { headers: { Authorization: `Bearer ${json.pinToken}` } });
  assert.equal(r.status, 401);
  const vencido = jwt.sign({ id: usuario.id, etapa: 'pin' }, 'secreto-de-pruebas|pin', { expiresIn: -10 });
  assert.equal((await post('/auth/pin', { pinToken: vencido, pin: '4821' })).status, 401);
  const falso = jwt.sign({ id: usuario.id, etapa: 'pin' }, 'secreto-de-pruebas', { expiresIn: '5m' });
  assert.equal((await post('/auth/pin', { pinToken: falso, pin: '4821' })).status, 401);
});

test('PIN: médico sin PIN asignado responde 403 con mensaje claro', async () => {
  const { json } = await login();
  usuario.pin = null;
  const r = await post('/auth/pin', { pinToken: json.pinToken, pin: '4821' });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /no tiene PIN/);
});

test('PIN: variantes del rol médico también piden PIN y los demás roles no', async () => {
  usuario.rol = 'Médico General';
  assert.equal((await login()).json.requierePin, true);
  usuario.rol = 'enfermeria';
  const r = await login();
  assert.equal(r.json.requierePin, undefined);
  assert.ok(r.json.token);
});

test('PIN: después de 5 PIN fallidos responde 429', async () => {
  const { json } = await login();
  const estados = [];
  for (let i = 0; i < 6; i++) estados.push((await post('/auth/pin', { pinToken: json.pinToken, pin: '0000' })).status);
  assert.deepEqual(estados, [401, 401, 401, 401, 401, 429]);
});

test('HU-37: un acceso denegado (403) queda en la bitácora sin la query string', async () => {
  usuario.rol = 'farmacia';
  const tk = jwt.sign({ id: usuario.id }, 'secreto-de-pruebas', { expiresIn: '1h' });
  const r = await fetch(`${base}/patients?q=Ana%20Lopez`, { headers: { Authorization: `Bearer ${tk}` } });
  assert.equal(r.status, 403);
  await new Promise((ok) => setTimeout(ok, 20));
  const a = llamadas.find((l) => /INSERT INTO audit_logs/.test(l.sql));
  assert.equal(a.params[3], 'acceso_denegado');
  assert.equal(a.params[5], 'Acceso denegado: GET /api/patients');
});

test('PIN: un médico en un dispositivo bloqueado no recibe pinToken', async () => {
  bloqueado = true;
  const r = await login();
  assert.equal(r.status, 403);
  assert.equal(r.json.pinToken, undefined);
  assert.equal(r.json.code, 'DISPOSITIVO_BLOQUEADO');
});

test('PIN: si bloquean el dispositivo entre la contraseña y el PIN, el PIN correcto responde 403', async () => {
  const { json } = await login();
  bloqueado = true;
  llamadas.length = 0;
  const r = await post('/auth/pin', { pinToken: json.pinToken, pin: '4821' });
  assert.equal(r.status, 403);
  assert.equal(r.json.token, undefined);
  assert.deepEqual(eventos(), ['dispositivo_bloqueado']);
});

test('huella: sin X-Device-Fingerprint el login responde 400 antes de revisar la contraseña', async () => {
  for (const headers of [{ 'X-Device-Fingerprint': '' }, { 'X-Device-Fingerprint': 'corta' }, { 'X-Device-Fingerprint': 'con espacios y <script>' }]) {
    llamadas.length = 0;
    const r = await post('/auth/login', { email: 'dr@h.com', password: 'Clave123!' }, headers);
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'HUELLA_REQUERIDA');
    assert.equal(llamadas.some((l) => /FROM users u/.test(l.sql)), false, 'no se consulta al usuario: la respuesta no revela si la contraseña era correcta');
  }
});

test('huella: el paso del PIN también exige la huella', async () => {
  const { json } = await login();
  const r = await post('/auth/pin', { pinToken: json.pinToken, pin: '4821' }, { 'X-Device-Fingerprint': '' });
  assert.equal(r.status, 400);
  assert.equal(r.json.token, undefined);
});
