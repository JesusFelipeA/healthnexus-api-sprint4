// El login de la API registra el dispositivo (tabla `dispositivos`) como lo hace Laravel.
process.env.JWT_SECRET = 'secreto-de-pruebas';
process.env.RATE_LIMIT_MAX = '1000';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const llamadas = [];
let existente = null;       // fila que devuelve el SELECT de dispositivos
let fallaDispositivos = null;
let bloqueado = false;      // dispositivos.activo = 0
const hash = bcrypt.hashSync('Clave123!', 4);
const pool = {
  query: async (sql, params = []) => {
    llamadas.push({ sql, params });
    if (/FROM users u/.test(sql)) return [[{ id: 7, name: 'Enf. Prueba', email: 'dr@h.com', password: hash, activo: 1, rol: 'enfermeria' }]];
    if (/dispositivos/.test(sql) && fallaDispositivos) throw fallaDispositivos;
    if (/SELECT activo FROM dispositivos/.test(sql)) return [bloqueado ? [{ activo: 0 }] : []];
    if (/SELECT id FROM dispositivos/.test(sql)) return [existente ? [existente] : []];
    if (/INSERT INTO dispositivos/.test(sql)) return [{ insertId: 55 }];
    return [{ affectedRows: 1 }];
  },
};
require.cache[require.resolve(path.join(__dirname, '../src/db.js'))] = { id: 'db', filename: 'db', loaded: true, exports: pool };
const app = require('../src/app');

let server, base;
test.before(async () => { await new Promise((ok) => { server = app.listen(0, ok); }); base = `http://127.0.0.1:${server.address().port}/api`; });
test.after(() => server.close());
test.beforeEach(() => { llamadas.length = 0; existente = null; fallaDispositivos = null; bloqueado = false; });

const login = (headers = {}) => fetch(`${base}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ email: 'dr@h.com', password: 'Clave123!' }),
});
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sql = (re) => llamadas.find((l) => re.test(l.sql));

test('dispositivos: un login desde la app (okhttp) crea el dispositivo como Android/móvil', async () => {
  const r = await login({ 'User-Agent': 'okhttp/4.12.0', 'X-Device-Fingerprint': 'abc-123-def-456-ghi' });
  assert.equal(r.status, 200);
  const ins = sql(/INSERT INTO dispositivos/);
  assert.ok(ins, 'debe insertar en dispositivos');
  const [userId, huella, nombre, tipo, so, nav] = ins.params;
  assert.equal(userId, 7);
  assert.equal(huella, sha('abc-123-def-456-ghi'));
  assert.equal(nombre, 'React Native (Android) en Android');
  assert.equal(tipo, 'mobile');
  assert.equal(so, 'Android');
  assert.equal(nav, 'React Native (Android)');
  assert.match(ins.sql, /DATE_SUB\(UTC_TIMESTAMP\(\), INTERVAL 6 HOUR\)/);
  const aud = llamadas.filter((l) => /INSERT INTO audit_logs/.test(l.sql)).map((l) => l.params[3]);
  assert.deepEqual(aud, ['login', 'dispositivo_nuevo']);
});

test('dispositivos: sin X-Device-Fingerprint no hay login (Postman o scripts sin la app)', async () => {
  const r = await login({ 'User-Agent': 'PostmanRuntime/7.43.0' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'HUELLA_REQUERIDA');
  assert.equal(sql(/INSERT INTO dispositivos/), undefined);
});

test('dispositivos: un dispositivo ya conocido solo actualiza último acceso y contador', async () => {
  existente = { id: 31 };
  const r = await login({ 'User-Agent': 'okhttp/4.12.0', 'X-Device-Fingerprint': 'abc-123-def-456-ghi' });
  assert.equal(r.status, 200);
  assert.equal(sql(/INSERT INTO dispositivos/), undefined);
  const up = sql(/UPDATE dispositivos/);
  assert.ok(up);
  assert.match(up.sql, /total_accesos = total_accesos \+ 1/);
  assert.equal(up.params.at(-1), 31);
  const aud = llamadas.filter((l) => /INSERT INTO audit_logs/.test(l.sql)).map((l) => l.params[3]);
  assert.deepEqual(aud, ['login']);
});

test('dispositivos: si falla el registro, el login igual responde 200 con token', async () => {
  fallaDispositivos = new Error('tabla no existe');
  const r = await login({ 'User-Agent': 'okhttp/4.12.0', 'X-Device-Fingerprint': 'abc-123-def-456-ghi' });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).token);
});

test('dispositivos: un navegador de escritorio se clasifica como Chrome en Windows', async () => {
  await login({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36', 'X-Device-Fingerprint': 'abc-123-def-456-ghi' });
  const p = sql(/INSERT INTO dispositivos/).params;
  assert.deepEqual([p[2], p[3]], ['Google Chrome en Windows 10/11', 'desktop']);
});

test('dispositivos: un dispositivo bloqueado en la web no puede iniciar sesión (403) y queda en la bitácora', async () => {
  bloqueado = true;
  const r = await login({ 'User-Agent': 'okhttp/4.12.0', 'X-Device-Fingerprint': 'abc-123-def-456-ghi' });
  assert.equal(r.status, 403);
  const json = await r.json();
  assert.equal(json.code, 'DISPOSITIVO_BLOQUEADO');
  assert.equal(json.token, undefined);
  const q = sql(/SELECT activo FROM dispositivos/);
  assert.deepEqual(q.params, [7, sha('abc-123-def-456-ghi')]);
  const aud = llamadas.filter((l) => /INSERT INTO audit_logs/.test(l.sql)).map((l) => l.params[3]);
  assert.deepEqual(aud, ['dispositivo_bloqueado']);
  assert.equal(sql(/UPDATE dispositivos|INSERT INTO dispositivos/), undefined, 'no se actualiza el dispositivo bloqueado');
});
