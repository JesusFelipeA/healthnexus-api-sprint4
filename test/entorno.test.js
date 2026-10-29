// Revisión de variables de entorno por ambiente (src/entorno.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { revisarEntorno } = require('../src/entorno');

const PROD_OK = {
  NODE_ENV: 'production', JWT_SECRET: 'a3f9c1e07b5d42e8a9c1d3f5b7e9a1c3d5f7b9e1a3c5d7f9b1e3a5c7d9f1b3e5',
  DB_HOST: 'hn.xxxx.us-east-2.rds.amazonaws.com', DB_NAME: 'healthnexusdb', DB_USER: 'hn_api', DB_PASS: 'f0e1d2c3b4a59687',
  TRUST_PROXY: '1', CORS_ORIGINS: 'https://healthnexus.duckdns.org',
  FIREBASE_CREDENTIALS_BASE64: 'e30=',
};

test('entorno: producción con secretos fuertes arranca sin errores ni avisos', () => {
  assert.deepEqual(revisarEntorno(PROD_OK), { errores: [], avisos: [], ambiente: 'producción' });
});

test('entorno: en producción un JWT_SECRET corto o de ejemplo impide arrancar', () => {
  assert.match(revisarEntorno({ ...PROD_OK, JWT_SECRET: 'abc123' }).errores[0], /demasiado corto/);
  assert.match(revisarEntorno({ ...PROD_OK, JWT_SECRET: 'clave_solo_para_desarrollo_cambiala_1234567890' }).errores[0], /ejemplo o de desarrollo/);
  assert.match(revisarEntorno({ ...PROD_OK, JWT_SECRET: '' }).errores[0], /Falta JWT_SECRET/);
});

test('entorno: en producción faltan datos de la base o la contraseña es de ejemplo', () => {
  assert.ok(revisarEntorno({ ...PROD_OK, DB_PASS: '' }).errores.some((e) => /DB_PASS/.test(e)));
  assert.ok(revisarEntorno({ ...PROD_OK, DB_PASS: 'CAMBIAME_contraseña' }).errores.some((e) => /ejemplo/.test(e)));
  assert.ok(revisarEntorno({ ...PROD_OK, DB_HOST: '' }).errores.some((e) => /DB_HOST/.test(e)));
});

test('entorno: usuario admin, TRUST_PROXY=0 y CORS vacío son avisos, no errores', () => {
  const r = revisarEntorno({ ...PROD_OK, DB_USER: 'admin', TRUST_PROXY: '0', CORS_ORIGINS: '' });
  assert.deepEqual(r.errores, []);
  assert.equal(r.avisos.length, 3);
});

test('entorno: sin credenciales de Firebase solo hay un aviso: las notificaciones push quedan desactivadas', () => {
  const r = revisarEntorno({ ...PROD_OK, FIREBASE_CREDENTIALS_BASE64: '' });
  assert.deepEqual(r.errores, []);
  assert.match(r.avisos[0], /notificaciones push/);
});

test('entorno: en desarrollo basta con tener JWT_SECRET (aunque sea de ejemplo)', () => {
  assert.deepEqual(revisarEntorno({ JWT_SECRET: 'clave_solo_para_desarrollo_cambiala' }).errores, []);
  assert.match(revisarEntorno({}).errores[0], /Falta JWT_SECRET/);
});
