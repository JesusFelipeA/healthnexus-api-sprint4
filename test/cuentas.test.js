// Pruebas de cuentas, pagos y recibos (HU-73 y HU-75) con el pool de MySQL simulado.
//   Ejecutar:  npm test
process.env.JWT_SECRET = 'secreto-de-pruebas';
process.env.RATE_LIMIT_MAX = '1000';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const path = require('node:path');

const llamadas = [];
let usuarios = {};
let respuestas = [];
const pool = {
  query: async (sql, params = []) => {
    llamadas.push({ sql, params });
    if (/FROM users u/.test(sql)) {
      const u = usuarios[params[0]];
      return [u ? [{ id: Number(params[0]), name: `Usuario ${params[0]}`, activo: u.activo, rol: u.rol }] : []];
    }
    if (/INSERT INTO audit_logs/.test(sql)) return [{ insertId: 1 }];
    for (const r of respuestas) if (r.si.test(sql)) return r.devuelve;
    return [[]];
  },
};
require.cache[require.resolve(path.join(__dirname, '../src/db.js'))] = { id: 'db', filename: 'db', loaded: true, exports: pool };
const app = require('../src/app');

let server, base;
test.before(async () => { await new Promise((ok) => { server = app.listen(0, ok); }); base = `http://127.0.0.1:${server.address().port}/api`; });
test.after(() => server.close());
test.beforeEach(() => {
  llamadas.length = 0; respuestas = [];
  usuarios = { 1: { rol: 'medico', activo: 1 }, 2: { rol: 'enfermeria', activo: 1 }, 3: { rol: 'farmacia', activo: 1 }, 4: { rol: 'administrador', activo: 1 } };
});

const token = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function pedir(ruta, id) {
  const r = await fetch(base + ruta, { headers: id ? { Authorization: `Bearer ${token(id)}` } : {} });
  const tipo = r.headers.get('content-type') || '';
  if (tipo.includes('application/json')) return { status: r.status, tipo, json: await r.json(), headers: r.headers };
  return { status: r.status, tipo, buf: Buffer.from(await r.arrayBuffer()), headers: r.headers };
}

const cuenta = { id: 7, paciente_id: 3, folio: 'CTA-20261020-001', estado: 'abierta', subtotal: '1500.00', descuento_global: '100.00', motivo_descuento: 'Convenio',
  total: '1400.00', pagado: '500.00', saldo: '900.00', cerrada_en: null, notas: null, created_at: '2026-10-20 15:00:00', pac_id: 3, paciente: 'Ana Pérez López', curp: 'PELA900101MMCRPN01' };
const pagoOk = { id: 1, folio: 'PAG-20261020-001', monto: '500.00', metodo: 'efectivo', referencia: null, estado: 'aplicado', motivo_cancelacion: null, cancelado_en: null, pagado_en: '2026-10-20 16:00:00', notas: null, cobrado_por: 'Caja' };
const pagoCancelado = { ...pagoOk, id: 2, folio: 'PAG-20261020-002', monto: '200.00', estado: 'cancelado', motivo_cancelacion: 'Error de captura', cancelado_en: '2026-10-20 17:00:00' };

test('HU-73: solo el administrador entra a cuentas; los demás roles y sin token son rechazados', async () => {
  assert.equal((await pedir('/cuentas')).status, 401);
  for (const id of [1, 2, 3]) assert.equal((await pedir('/cuentas', id)).status, 403, `rol ${usuarios[id].rol}`);
  assert.equal((await pedir('/cuentas/7', 1)).status, 403);
  assert.equal((await pedir('/pagos/1/recibo', 2)).status, 403);
  respuestas = [{ si: /COUNT\(\*\) AS total/, devuelve: [[{ total: 0, saldo_pendiente: '0.00' }]] }];
  assert.equal((await pedir('/cuentas', 4)).status, 200);
});

test('HU-73: la lista devuelve montos numéricos, total y saldo pendiente', async () => {
  respuestas = [
    { si: /COUNT\(\*\) AS total/, devuelve: [[{ total: 1, saldo_pendiente: '900.00' }]] },
    { si: /FROM cuentas c JOIN pacientes p ON p.id = c.paciente_id\s+(WHERE.*)?ORDER BY/s, devuelve: [[cuenta]] },
  ];
  const r = await pedir('/cuentas?estado=abierta&q=Ana', 4);
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 1);
  assert.equal(r.json.saldoPendiente, 900);
  assert.equal(r.json.data[0].paciente, 'Ana Pérez López');
  assert.equal(r.json.data[0].total, 1400);
  assert.equal(typeof r.json.data[0].saldo, 'number');
  const consulta = llamadas.find((c) => /ORDER BY c.id DESC/.test(c.sql));
  assert.ok(consulta.params.includes('abierta') && consulta.params.includes('%Ana%'), 'filtros enviados como parámetros');
});

test('HU-73: filtros inválidos responden 400 y la búsqueda no se concatena al SQL', async () => {
  assert.equal((await pedir('/cuentas?estado=borrada', 4)).status, 400);
  assert.equal((await pedir('/cuentas?paciente_id=abc', 4)).status, 400);
  await pedir("/cuentas?q=' OR 1=1 --", 4);
  assert.ok(llamadas.every((c) => !c.sql.includes('OR 1=1')));
});

test('HU-73: el detalle trae cargos, pagos con los cancelados marcados y el saldo cuadra', async () => {
  respuestas = [
    { si: /FROM cuentas c JOIN pacientes p ON p.id = c.paciente_id WHERE c.id = \?/, devuelve: [[cuenta]] },
    { si: /FROM cuenta_items/, devuelve: [[{ id: 1, concepto: 'Consulta general', cantidad: 2, precio_unitario: '750.00', descuento: '0.00', motivo_descuento: null, importe: '1500.00', notas: null }]] },
    { si: /FROM pagos g LEFT JOIN users u ON u.id = g.user_id WHERE g.cuenta_id/, devuelve: [[pagoCancelado, pagoOk]] },
  ];
  const r = await pedir('/cuentas/7', 4);
  assert.equal(r.status, 200);
  assert.equal(r.json.cargos.length, 1);
  assert.equal(r.json.cargos[0].importe, 1500);
  assert.equal(r.json.pagos.length, 2);
  assert.equal(r.json.pagos[0].cancelado, true);
  assert.equal(r.json.pagos[0].motivoCancelacion, 'Error de captura');
  assert.equal(r.json.verificacion.pagadoCalculado, 500);       // el cancelado (200) no cuenta
  assert.equal(r.json.verificacion.saldoCalculado, 900);
  assert.equal(r.json.verificacion.coincide, true);
  const aud = llamadas.find((l) => /INSERT INTO audit_logs/.test(l.sql));
  assert.equal(aud.params[3], 'consulta_sensible');               // cada consulta queda en la bitácora
  assert.doesNotMatch(aud.params[5], /\$|\d+\.\d{2}/);               // sin montos en la descripción
});

test('HU-73: si el saldo guardado no cuadra con los pagos, la verificación lo señala', async () => {
  respuestas = [
    { si: /FROM cuentas c JOIN pacientes p ON p.id = c.paciente_id WHERE c.id = \?/, devuelve: [[{ ...cuenta, pagado: '700.00', saldo: '700.00' }]] },
    { si: /FROM pagos g LEFT JOIN users/, devuelve: [[pagoOk]] },
  ];
  const r = await pedir('/cuentas/7', 4);
  assert.equal(r.json.verificacion.coincide, false);
});

test('HU-73: cuenta inexistente responde 404 y un id no numérico no llega a la base', async () => {
  assert.equal((await pedir('/cuentas/999', 4)).status, 404);
  llamadas.length = 0;
  assert.equal((await pedir('/cuentas/abc', 4)).status, 404);
  assert.equal(llamadas.filter((c) => /FROM cuentas/.test(c.sql)).length, 0);
});

test('HU-75: el recibo es un PDF válido, se descarga como adjunto y queda auditado', async () => {
  respuestas = [
    { si: /FROM pagos g LEFT JOIN users u ON u.id = g.user_id WHERE g.id/, devuelve: [[pagoOk]] },
    { si: /FROM cuentas WHERE id/, devuelve: [[cuenta]] },
    { si: /FROM pacientes p WHERE p.id/, devuelve: [[{ nombre: 'Ana Pérez López', curp: 'PELA900101MMCRPN01' }]] },
  ];
  const r = await pedir('/pagos/1/recibo', 4);
  assert.equal(r.status, 200);
  assert.match(r.tipo, /application\/pdf/);
  assert.equal(r.buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(r.buf.length > 800);
  assert.equal(Number(r.headers.get('content-length')), r.buf.length);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="recibo-PAG-20261020-001\.pdf"/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const a = llamadas.find((c) => /INSERT INTO audit_logs/.test(c.sql));
  assert.ok(a && a.params.includes('recibo_descargado'));
});

test('HU-75: el recibo de un pago cancelado se genera igual y pago inexistente responde 404', async () => {
  respuestas = [
    { si: /FROM pagos g LEFT JOIN users u ON u.id = g.user_id WHERE g.id/, devuelve: [[pagoCancelado]] },
    { si: /FROM cuentas WHERE id/, devuelve: [[cuenta]] },
    { si: /FROM pacientes p WHERE p.id/, devuelve: [[{ nombre: 'Ana Pérez López', curp: null }]] },
  ];
  assert.equal((await pedir('/pagos/2/recibo', 4)).status, 200);
  respuestas = [];
  assert.equal((await pedir('/pagos/99/recibo', 4)).status, 404);
});
