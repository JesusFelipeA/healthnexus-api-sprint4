// DEF-11: /api/health revisa la base de datos y los errores de conexión responden 503 (no 500).
process.env.JWT_SECRET = 'secreto-de-pruebas';
process.env.RATE_LIMIT_MAX = '1000';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');

// Pool simulado: `modo` decide si la base responde, falla o se queda colgada
let modo = 'ok';
const errorConexion = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), { code: 'ECONNREFUSED' });
const pool = {
  query: async (sql) => {
    if (modo === 'caida') throw errorConexion();
    if (modo === 'colgada') return new Promise(() => {});
    if (/FROM users u/.test(sql)) return [[{ id: 3, name: 'Farmacia', activo: 1, rol: 'farmacia' }]];
    if (/INSERT INTO audit_logs/.test(sql)) return [{ insertId: 1 }];
    return [[{ totalMedicamentos: 1 }]];
  },
};
require.cache[require.resolve(path.join(__dirname, '../src/db.js'))] = { id: 'db', filename: 'db', loaded: true, exports: pool };
const app = require('../src/app');

let server, base;
const token = jwt.sign({ id: 3, nombre: 'Farmacia', rol: 'farmacia' }, 'secreto-de-pruebas');
test.before(async () => { await new Promise((ok) => { server = app.listen(0, ok); }); base = `http://127.0.0.1:${server.address().port}/api`; });
test.after(() => server.close());
test.beforeEach(() => { modo = 'ok'; });

test('salud: con la base de datos arriba responde 200 { ok: true, db: "ok" }', async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, db: 'ok' });
});

test('salud: con la base de datos caída responde 503 para que Docker y el monitoreo lo detecten', async () => {
  modo = 'caida';
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.db, 'sin_conexion');
});

test('salud: si la base no contesta en 2 s responde 503 sin quedarse esperando', async () => {
  modo = 'colgada';
  const t0 = Date.now();
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 503);
  assert.ok(Date.now() - t0 < 3000);
});

test('sin conexión a la base, una ruta normal responde 503 SERVICIO_NO_DISPONIBLE sin traza en el log', async () => {
  modo = 'caida';
  const lineas = [];
  const original = console.error;
  console.error = (...a) => lineas.push(a.map(String).join(' '));
  try {
    const r = await fetch(`${base}/farmacia/resumen`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: 'El servicio no está disponible en este momento. Intenta más tarde.', code: 'SERVICIO_NO_DISPONIBLE' });
  } finally { console.error = original; }
  assert.equal(lineas.length, 1);
  assert.match(lineas[0], /Base de datos no disponible \(ECONNREFUSED\) en GET \/api\/farmacia\/resumen/);
  assert.doesNotMatch(lineas[0], /\n\s+at /);
});

test('cuando la base vuelve, la API responde sin reiniciarse', async () => {
  modo = 'caida';
  assert.equal((await fetch(`${base}/health`)).status, 503);
  modo = 'ok';
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/farmacia/resumen`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
});
