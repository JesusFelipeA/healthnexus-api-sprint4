// CP-35: el límite global de peticiones por IP responde 429 al excederse.
process.env.JWT_SECRET = 'secreto-de-pruebas';
process.env.RATE_LIMIT_MAX = '5';

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');

test('CP-35: la sexta petición del mismo origen en un minuto responde 429 con mensaje claro', async () => {
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/health`;
  const estados = [];
  for (let i = 0; i < 7; i++) estados.push((await fetch(url)).status);
  const r = await fetch(url);
  const json = await r.json();
  server.close();
  assert.deepEqual(estados.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.equal(estados[5], 429);
  assert.equal(json.error, 'Demasiadas peticiones. Espera un momento.');
});
