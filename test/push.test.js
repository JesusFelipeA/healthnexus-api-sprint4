// Notificaciones push: registro del token FCM por dispositivo y avisos de emergencia y triage nivel I.
process.env.JWT_SECRET = 'secreto-de-pruebas';
process.env.RATE_LIMIT_MAX = '1000';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const HUELLA = 'prueba-dispositivo-push-0001';
const HUELLA_SHA = crypto.createHash('sha256').update(HUELLA).digest('hex');
const TOKEN_FCM = 'fcm-token-de-prueba:APA91bH' + 'x'.repeat(60);

const llamadas = [];
let usuarios = {};
let afectadas = 1;
let tokensDestino = [];
const pool = {
  query: async (sql, params = []) => {
    llamadas.push({ sql, params });
    if (/FROM users u/.test(sql)) return [[usuarios[params[0]]].filter(Boolean)];
    if (/fcm_token AS token/.test(sql)) return [tokensDestino.map((token) => ({ token }))];
    if (/SET fcm_token = \?/.test(sql)) return [{ affectedRows: afectadas }];
    if (/FROM pacientes/.test(sql)) return [[{ id: 7 }]];
    if (/FROM admisiones/.test(sql)) return [[{ id: 3, triage: 'amarillo' }]];
    if (/INSERT INTO alertas/.test(sql)) return [{ insertId: 55 }];
    return [{ affectedRows: 1, insertId: 1 }];
  },
};
pool.getConnection = async () => ({ ...pool, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} });
require.cache[require.resolve(path.join(__dirname, '../src/db.js'))] = { id: 'db', filename: 'db', loaded: true, exports: pool };
const push = require('../src/push');
const app = require('../src/app');

let enviados = [];
let respuestaFcm = null;
const fcmFalso = { sendEachForMulticast: async (m) => { enviados.push(m); return respuestaFcm || { successCount: m.tokens.length, failureCount: 0, responses: m.tokens.map(() => ({ success: true })) }; } };

let server, base;
test.before(async () => { await new Promise((ok) => { server = app.listen(0, ok); }); base = `http://127.0.0.1:${server.address().port}/api`; });
test.after(() => server.close());
test.beforeEach(() => {
  llamadas.length = 0; enviados = []; respuestaFcm = null; afectadas = 1; tokensDestino = ['tok-medico-1', 'tok-enfermeria-2'];
  usuarios = { 1: { id: 1, name: 'Enf. Prueba', activo: 1, rol: 'enfermeria' }, 2: { id: 2, name: 'Dr. Prueba', activo: 1, rol: 'medico' } };
  push._usarMessaging(fcmFalso);
});

const firmar = (id) => jwt.sign({ id }, process.env.JWT_SECRET);
const pedir = async (metodo, ruta, { id = 1, body, huella = HUELLA } = {}) => {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${firmar(id)}` };
  if (huella) headers['X-Device-Fingerprint'] = huella;
  const r = await fetch(base + ruta, { method: metodo, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
};
const espera = () => new Promise((ok) => setTimeout(ok, 20)); // los avisos se envían sin bloquear la respuesta

test('token: sin sesión responde 401', async () => {
  const r = await fetch(`${base}/notificaciones/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN_FCM }) });
  assert.equal(r.status, 401);
});

test('token: sin huella de dispositivo responde 400', async () => {
  const r = await pedir('POST', '/notificaciones/token', { body: { token: TOKEN_FCM }, huella: null });
  assert.equal(r.status, 400);
});

test('token: un valor inválido responde 400 y no toca la base', async () => {
  const r = await pedir('POST', '/notificaciones/token', { body: { token: 'corto' } });
  assert.equal(r.status, 400);
  assert.equal(llamadas.some((l) => /fcm_token/.test(l.sql)), false);
});

test('token: se guarda en el dispositivo del usuario (user_id + huella) y se quita de otras cuentas', async () => {
  const r = await pedir('POST', '/notificaciones/token', { body: { token: TOKEN_FCM } });
  assert.equal(r.status, 200);
  const guardar = llamadas.find((l) => /SET fcm_token = \?, fcm_actualizado/.test(l.sql));
  assert.deepEqual(guardar.params, [TOKEN_FCM, 1, HUELLA_SHA]);
  assert.match(guardar.sql, /activo = 1/, 'un dispositivo bloqueado no recibe notificaciones');
  assert.ok(llamadas.some((l) => /SET fcm_token = NULL WHERE fcm_token = \? AND NOT/.test(l.sql)));
});

test('token: si el dispositivo no existe o está bloqueado responde 404', async () => {
  afectadas = 0;
  const r = await pedir('POST', '/notificaciones/token', { body: { token: TOKEN_FCM } });
  assert.equal(r.status, 404);
});

test('token: DELETE lo borra al cerrar sesión', async () => {
  const r = await pedir('DELETE', '/notificaciones/token');
  assert.equal(r.status, 200);
  const q = llamadas.find((l) => /SET fcm_token = NULL WHERE user_id/.test(l.sql));
  assert.deepEqual(q.params, [1, HUELLA_SHA]);
});

test('emergencia: avisa a médicos y enfermería sin datos sensibles ni al que la activó', async () => {
  const r = await pedir('POST', '/emergencias', { body: { mensaje: 'Paciente Juan Pérez en cama 4', ubicacion: { lat: 19.28, lng: -99.65 } } });
  assert.equal(r.status, 201);
  await espera();
  assert.equal(enviados.length, 1);
  const m = enviados[0];
  assert.deepEqual(m.tokens, ['tok-medico-1', 'tok-enfermeria-2']);
  assert.equal(m.notification.title, 'Código de emergencia activado');
  const texto = JSON.stringify(m);
  assert.ok(!/Juan|Pérez|cama|19\.28|-99\.65/.test(texto), 'la notificación no lleva el mensaje ni la ubicación');
  assert.equal(m.android.priority, 'high');
  assert.equal(m.data.tipo, 'emergencia');
  const q = llamadas.find((l) => /fcm_token AS token/.test(l.sql));
  assert.deepEqual(q.params, [['medico', 'enfermeria'], 1]);
});

test('emergencia: los tokens que FCM rechaza se borran', async () => {
  respuestaFcm = { successCount: 1, failureCount: 1, responses: [{ success: true }, { success: false, error: { code: 'messaging/registration-token-not-registered' } }] };
  await pedir('POST', '/emergencias', { body: {} });
  await espera();
  const q = llamadas.find((l) => /SET fcm_token = NULL WHERE fcm_token IN/.test(l.sql));
  assert.deepEqual(q.params, [['tok-enfermeria-2']]);
});

test('emergencia: sin Firebase configurado se registra igual y no se envía nada', async () => {
  push._usarMessaging(null);
  const r = await pedir('POST', '/emergencias', { body: {} });
  assert.equal(r.status, 201);
  await espera();
  assert.equal(enviados.length, 0);
});

test('triage: nivel rojo avisa a los médicos; otros niveles no', async () => {
  let r = await pedir('PATCH', '/patients/7/triage', { id: 2, body: { triageLevel: 'rojo' } });
  assert.equal(r.status, 200);
  await espera();
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].data.pantalla, 'Triage');
  assert.ok(!/7/.test(enviados[0].notification.body), 'no incluye el id del paciente');

  enviados = [];
  r = await pedir('PATCH', '/patients/7/triage', { id: 2, body: { triageLevel: 'verde' } });
  assert.equal(r.status, 200);
  await espera();
  assert.equal(enviados.length, 0);
});

test('credenciales: se leen en base64 o desde archivo, y sin ellas devuelve null', () => {
  const cred = { project_id: 'healthnexus-prueba' };
  assert.deepEqual(push.leerCredenciales({ FIREBASE_CREDENTIALS_BASE64: Buffer.from(JSON.stringify(cred)).toString('base64') }), cred);
  assert.equal(push.leerCredenciales({}), null);
});
