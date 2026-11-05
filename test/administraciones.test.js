// T-35.2 · La administración de medicamentos desde la app descuenta el inventario (como la web).
//   Ejecutar:  npm test
process.env.JWT_SECRET = 'secreto-de-pruebas';
process.env.RATE_LIMIT_MAX = '1000';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const path = require('node:path');

// ---- pool simulado con transacciones -------------------------------------------
const llamadas = [];
let usuarios = {};
let datos = {};
let tx = {};
let siguienteId = 100;
const usuario = { 1: 'medico', 2: 'enfermeria', 3: 'farmacia', 4: 'administrador' };

async function consulta(sql, params = []) {
  llamadas.push({ sql, params });
  if (/FROM users u/.test(sql)) {
    const u = usuarios[params[0]];
    return [u ? [{ id: Number(params[0]), name: `Usuario ${params[0]}`, activo: 1, rol: u }] : []];
  }
  if (/FROM pacientes WHERE id = \?/.test(sql)) return [datos.paciente ? [{ id: params[0] }] : []];
  if (/FROM cama_paciente/.test(sql)) return [datos.cama ? [{ cama_id: datos.cama }] : []];
  if (/FROM medicamentos WHERE id = \?/.test(sql)) return [datos.med ? [{ ...datos.med }] : []];
  if (/FROM lotes/.test(sql)) return [datos.lotes.map((l) => ({ ...l }))];
  if (/^\s*INSERT/.test(sql)) return [{ insertId: siguienteId++ }];
  if (/^\s*UPDATE/.test(sql)) return [{ affectedRows: 1 }];
  return [[]];
}
const pool = {
  query: consulta,
  getConnection: async () => ({
    beginTransaction: async () => { tx.inicio = (tx.inicio || 0) + 1; },
    commit: async () => { tx.commit = (tx.commit || 0) + 1; },
    rollback: async () => { tx.rollback = (tx.rollback || 0) + 1; },
    release: () => { tx.release = (tx.release || 0) + 1; },
    query: consulta,
  }),
};
require.cache[require.resolve(path.join(__dirname, '../src/db.js'))] = { id: 'db', filename: 'db', loaded: true, exports: pool };
const app = require('../src/app');

let server, base;
test.before(async () => { await new Promise((ok) => { server = app.listen(0, ok); }); base = `http://127.0.0.1:${server.address().port}/api`; });
test.after(() => server.close());
test.beforeEach(() => {
  llamadas.length = 0; tx = {}; siguienteId = 100; usuarios = { ...usuario };
  datos = {
    paciente: true, cama: 7,
    med: { id: 12, nombre: 'Paracetamol', concentracion: '500 mg', via_administracion: 'Oral', stock_actual: 13, controlado: 0, psicotropico: 0 },
    lotes: [{ id: 1, cantidad_disponible: 3 }, { id: 2, cantidad_disponible: 10 }],
  };
});

const tk = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function administrar(body, id = 2) {
  const r = await fetch(`${base}/enfermeria/administraciones`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Fingerprint': 'prueba-dispositivo-0001', Authorization: `Bearer ${tk(id)}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const sqls = (re) => llamadas.filter((l) => re.test(l.sql));
const BASE = { pacienteId: 501, medicamentoId: 12, dosis: '500 mg' };

test('T-35.2: descuenta 1 unidad del lote que caduca primero, registra la salida, la nota y la administración', async () => {
  const r = await administrar(BASE);
  assert.equal(r.status, 201);
  assert.equal(r.json.unidades, 1);
  assert.equal(r.json.stockAnterior, 13);
  assert.equal(r.json.stockNuevo, 12);
  assert.deepEqual(r.json.movimientos.map((m) => [m.loteId, m.cantidad]), [[1, 1]]);

  const lote = sqls(/UPDATE lotes SET cantidad_disponible = cantidad_disponible - \?/);
  assert.deepEqual(lote.map((l) => l.params), [[1, 1]]);
  const mv = sqls(/INSERT INTO movimientos_inventario/)[0];
  assert.match(mv.sql, /'salida'/);
  assert.equal(mv.params[3], -1, 'la salida se guarda en negativo, como la web');
  assert.deepEqual([mv.params[4], mv.params[5]], [13, 12], 'stock anterior y nuevo');
  assert.match(mv.sql, /'nota_enfermeria'/);
  assert.deepEqual(sqls(/UPDATE medicamentos SET stock_actual = stock_actual - \?/).map((l) => l.params), [[1, 12]]);

  const nota = sqls(/INSERT INTO seguimientos/)[0];
  assert.match(nota.sql, /'nota_enfermeria'/);
  assert.equal(nota.params[2], 7, 'la nota queda en la cama del paciente');
  assert.equal(nota.params[3], 'Se administró Paracetamol (500 mg). Dosis: 500 mg. Vía: Oral.');
  const adm = sqls(/INSERT INTO administraciones_medicamento/)[0];
  assert.equal(adm.params[3], r.json.notaId, 'la administración apunta a su nota');
  assert.equal(adm.params[5], 'Oral', 'sin vía usa la del medicamento');
  assert.deepEqual([tx.inicio, tx.commit, tx.rollback, tx.release], [1, 1, undefined, 1]);
});

test('T-35.2: varias unidades se toman de varios lotes en orden de caducidad (FEFO)', async () => {
  const r = await administrar({ ...BASE, unidades: 5, via: 'IV' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.movimientos.map((m) => [m.loteId, m.cantidad]), [[1, 3], [2, 2]]);
  assert.equal(r.json.stockNuevo, 8);
  const mv = sqls(/INSERT INTO movimientos_inventario/);
  assert.deepEqual(mv.map((m) => [m.params[3], m.params[4], m.params[5]]), [[-3, 13, 10], [-2, 10, 8]]);
  assert.deepEqual(sqls(/UPDATE medicamentos SET stock_actual/).map((l) => l.params), [[5, 12]]);
});

test('T-35.2: bloquea el medicamento y sus lotes vigentes (FOR UPDATE) para que dos administraciones no dejen stock negativo', async () => {
  await administrar(BASE);
  assert.match(sqls(/FROM medicamentos WHERE id = \?/)[0].sql, /FOR UPDATE/);
  const lotes = sqls(/FROM lotes/)[0].sql;
  assert.match(lotes, /FOR UPDATE/);
  assert.match(lotes, /cantidad_disponible > 0/);
  assert.match(lotes, /fecha_caducidad >= DATE\(/, 'no usa lotes caducados');
  assert.match(lotes, /ORDER BY fecha_caducidad ASC/);
});

test('T-35.2: sin stock suficiente responde 409 SIN_STOCK y no cambia nada', async () => {
  const r = await administrar({ ...BASE, unidades: 14 });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { error: 'Sin stock suficiente de Paracetamol. Disponible: 13', code: 'SIN_STOCK' });
  assert.equal(sqls(/^\s*(INSERT INTO (seguimientos|movimientos|administraciones)|UPDATE)/).length, 0);
  assert.deepEqual([tx.commit, tx.rollback, tx.release], [undefined, 1, 1]);
});

test('T-35.2: solo lotes caducados o vacíos cuentan como sin stock', async () => {
  datos.lotes = [];
  const r = await administrar(BASE);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'SIN_STOCK');
});

test('T-35.2: paciente sin cama activa responde 409 NO_HOSPITALIZADO; el administrador queda exento, como en la web', async () => {
  datos.cama = null;
  const enf = await administrar(BASE);
  assert.equal(enf.status, 409);
  assert.deepEqual(enf.json, { error: 'El paciente no está hospitalizado', code: 'NO_HOSPITALIZADO' });
  assert.equal(sqls(/UPDATE lotes/).length, 0);

  llamadas.length = 0;
  const admin = await administrar(BASE, 4);
  assert.equal(admin.status, 201);
  assert.equal(sqls(/INSERT INTO seguimientos/)[0].params[2], null, 'nota sin cama');
});

test('T-35.2: paciente o medicamento inexistente responden 404 sin tocar el inventario', async () => {
  datos.paciente = false;
  assert.equal((await administrar(BASE)).status, 404);
  datos.paciente = true; datos.med = null;
  const r = await administrar(BASE);
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'Medicamento no encontrado');
  assert.equal(sqls(/UPDATE lotes/).length, 0);
});

test('T-35.1/T-35.2: datos inválidos responden 400 antes de abrir la transacción', async () => {
  const casos = [
    [{ ...BASE, pacienteId: 'abc' }, /pacienteId y medicamentoId/],
    [{ ...BASE, medicamentoId: -1 }, /pacienteId y medicamentoId/],
    [{ ...BASE, dosis: '   ' }, /La dosis es obligatoria/],
    [{ ...BASE, dosis: 'x'.repeat(51) }, /50 caracteres/],
    [{ ...BASE, unidades: 0 }, /unidades/],
    [{ ...BASE, unidades: 21 }, /unidades/],
    [{ ...BASE, unidades: 1.5 }, /unidades/],
    [{ ...BASE, observaciones: 'x'.repeat(1001) }, /1000 caracteres/],
  ];
  for (const [body, msg] of casos) {
    const r = await administrar(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(r.json.error, msg);
  }
  assert.equal(tx.inicio, undefined, 'no se abrió ninguna transacción');
});

test('T-35.2: médico y farmacia no pueden registrar administraciones (403)', async () => {
  assert.equal((await administrar(BASE, 1)).status, 403);
  assert.equal((await administrar(BASE, 3)).status, 403);
  assert.equal(sqls(/UPDATE lotes/).length, 0);
});

test('T-35.2: la bitácora registra el descuento de inventario; controlados o con reacción adversa van como warning', async () => {
  datos.med.controlado = 1;
  await administrar({ ...BASE, reaccionAdversa: true });
  const a = sqls(/INSERT INTO audit_logs/)[0];
  assert.match(a.params[5], /Administración de Paracetamol \(500 mg\) con reacción adversa: -1 u\. de inventario/);
  assert.equal(a.params[11], 'warning');
  assert.equal(a.params[12], 1, 'evento sensible');
});
