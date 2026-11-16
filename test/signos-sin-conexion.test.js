// Modo sin conexión, fase 1: signos vitales capturados sin red y enviados al reconectar.
//   Ejecutar:  npm test
process.env.JWT_SECRET = 'secreto-de-pruebas';
process.env.RATE_LIMIT_MAX = '1000';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const path = require('node:path');

// ---- pool simulado: guarda los signos en memoria con el índice único de client_uuid ----
const llamadas = [];
let filas = [];
let siguienteId = 100;
const usuarios = { 2: 'enfermeria', 5: 'enfermeria', 1: 'medico' };

async function consulta(sql, params = []) {
  llamadas.push({ sql, params });
  if (/FROM users u/.test(sql)) {
    const rol = usuarios[params[0]];
    return [rol ? [{ id: Number(params[0]), name: `Usuario ${params[0]}`, activo: 1, rol }] : []];
  }
  if (/FROM pacientes WHERE id = \? AND activo = 1/.test(sql)) return [Number(params[0]) === 9 ? [{ id: 9 }] : []];
  if (/FROM signos_vitales WHERE client_uuid = \?/.test(sql)) return [filas.filter((f) => f.client_uuid === params[0]).map(({ id, user_id }) => ({ id, user_id }))];
  if (/INSERT INTO signos_vitales/.test(sql)) {
    const [paciente_id, user_id, client_uuid] = params;
    if (client_uuid && filas.some((f) => f.client_uuid === client_uuid)) throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
    const fila = { id: siguienteId++, paciente_id, user_id, client_uuid, capturado_en: params[16], sin_conexion: params[17], sql };
    filas.push(fila);
    return [{ insertId: fila.id }];
  }
  if (/^\s*INSERT/.test(sql)) return [{ insertId: 1 }];
  return [[]];
}
const pool = { query: consulta, getConnection: async () => ({ query: consulta, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} }) };
require.cache[require.resolve(path.join(__dirname, '../src/db.js'))] = { id: 'db', filename: 'db', loaded: true, exports: pool };
const app = require('../src/app');

let server, base;
test.before(async () => { await new Promise((ok) => { server = app.listen(0, ok); }); base = `http://127.0.0.1:${server.address().port}/api`; });
test.after(() => server.close());
test.beforeEach(() => { llamadas.length = 0; filas = []; siguienteId = 100; });

const tk = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function enviar(body, id = 2) {
  const r = await fetch(`${base}/enfermeria/signos`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk(id)}`, 'X-Device-Fingerprint': 'prueba' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const UUID = '3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f';
const haceMin = (m) => new Date(Date.now() - m * 60000).toISOString();
const auditorias = () => llamadas.filter((l) => /INSERT INTO audit_logs/.test(l.sql));

test('un registro en línea (sin clientUuid) se guarda como siempre, con la hora local de México', async () => {
  const r = await enviar({ pacienteId: 9, temperatura: 36.8 });
  assert.equal(r.status, 201);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].client_uuid, null);
  assert.equal(filas[0].capturado_en, null);
  assert.equal(filas[0].sin_conexion, 0);
  assert.match(filas[0].sql, /DATE_SUB\(UTC_TIMESTAMP\(\), INTERVAL 6 HOUR\)/, 'created_at debe ir en hora de México, como lee la web');
});

test('un registro sin conexión guarda su clientUuid y la hora real de la toma', async () => {
  const capturado = new Date(Date.now() - 90 * 60000);
  const r = await enviar({ pacienteId: 9, frecuenciaCardiaca: 88, clientUuid: UUID, capturadoEn: capturado.toISOString() });
  assert.equal(r.status, 201);
  assert.equal(filas[0].client_uuid, UUID);
  assert.equal(filas[0].sin_conexion, 1);
  const esperado = new Date(capturado.getTime() - 6 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  assert.equal(filas[0].capturado_en, esperado, 'capturado_en en hora local de México');
  assert.equal(llamadas.find((l) => /INSERT INTO signos_vitales/.test(l.sql)).params[18], esperado, 'created_at = hora de la toma, para que la web lo ordene bien');
  assert.match(String(auditorias().at(-1).params.join(' ')), /sin conexión/);
});

test('si el mismo registro llega dos veces (reintento) no se duplica y responde el mismo id', async () => {
  const body = { pacienteId: 9, saturacionOxigeno: 95, clientUuid: UUID, capturadoEn: haceMin(10) };
  const a = await enviar(body);
  const b = await enviar(body);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.deepEqual(b.body, { id: a.body.id, duplicado: true });
  assert.equal(filas.length, 1);
});

test('dos envíos simultáneos del mismo registro dejan una sola fila', async () => {
  const body = { pacienteId: 9, temperatura: 37.2, clientUuid: UUID, capturadoEn: haceMin(5) };
  const [a, b] = await Promise.all([enviar(body), enviar(body)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(filas.length, 1);
});

test('un clientUuid que ya usó otra cuenta responde 409 y no se guarda', async () => {
  await enviar({ pacienteId: 9, temperatura: 36.5, clientUuid: UUID, capturadoEn: haceMin(5) }, 2);
  const r = await enviar({ pacienteId: 9, temperatura: 39, clientUuid: UUID, capturadoEn: haceMin(5) }, 5);
  assert.equal(r.status, 409);
  assert.equal(filas.length, 1);
});

test('rechaza clientUuid inválido, fecha sin zona, hora futura y registros de más de 72 horas', async () => {
  const casos = [
    [{ clientUuid: 'abc', capturadoEn: haceMin(5) }, /clientUuid inválido/],
    [{ clientUuid: UUID, capturadoEn: '2026-11-13 10:00:00' }, /ISO 8601/],
    [{ clientUuid: UUID, capturadoEn: new Date(Date.now() + 60 * 60000).toISOString() }, /futuro/],
    [{ clientUuid: UUID, capturadoEn: haceMin(73 * 60) }, /72 horas/],
  ];
  for (const [extra, mensaje] of casos) {
    const r = await enviar({ pacienteId: 9, temperatura: 36.5, ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.match(r.body.error, mensaje);
  }
  assert.equal(filas.length, 0);
});

test('las reglas de siempre se aplican también a los registros sin conexión', async () => {
  assert.equal((await enviar({ pacienteId: 9, clientUuid: UUID, capturadoEn: haceMin(5) })).status, 400, 'sin signos');
  assert.equal((await enviar({ pacienteId: 404, temperatura: 36.5, clientUuid: UUID, capturadoEn: haceMin(5) })).status, 404, 'paciente inexistente');
  assert.equal((await enviar({ pacienteId: 9, temperatura: 36.5, clientUuid: UUID, capturadoEn: haceMin(5) }, 1)).status, 403, 'el médico no registra signos');
  assert.equal(filas.length, 0);
});

test('la consulta devuelve la hora de la toma y marca los registros sin conexión', async () => {
  await fetch(`${base}/enfermeria/signos?pacienteId=9`, { headers: { Authorization: `Bearer ${tk(2)}`, 'X-Device-Fingerprint': 'prueba' } });
  const sql = llamadas.find((l) => /FROM signos_vitales sv/.test(l.sql)).sql;
  assert.match(sql, /COALESCE\(sv\.capturado_en, sv\.created_at\) AS fecha/);
  assert.match(sql, /sv\.sin_conexion AS sinConexion/);
  assert.match(sql, /ORDER BY COALESCE\(sv\.capturado_en, sv\.created_at\) DESC/);
});
