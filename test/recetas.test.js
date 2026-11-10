// Dispensación de recetas desde consulta_medicamento (como DispensacionController de la web).
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
let datos = {};
let tx = {};
let siguienteId = 100;
const usuarios = { 1: 'medico', 2: 'enfermeria', 3: 'farmacia', 4: 'administrador' };

async function consulta(sql, params = []) {
  llamadas.push({ sql, params });
  if (/FROM users u/.test(sql)) {
    const u = usuarios[params[0]];
    return [u ? [{ id: Number(params[0]), name: `Usuario ${params[0]}`, activo: 1, rol: u }] : []];
  }
  if (/FROM consultas WHERE id = \? FOR UPDATE/.test(sql)) return [datos.consulta ? [{ ...datos.consulta }] : []];
  if (/SELECT medicamento_id FROM consulta_medicamento/.test(sql)) return [datos.renglones.map((m) => ({ medicamento_id: m }))];
  if (/FROM medicamentos WHERE id = \? FOR UPDATE/.test(sql)) return [datos.meds[params[0]] ? [{ ...datos.meds[params[0]] }] : []];
  if (/FROM lotes\s+WHERE medicamento_id = \?/.test(sql)) return [(datos.lotes[params[0]] || []).map((l) => ({ ...l }))];
  if (/FROM movimientos_inventario\s+WHERE referencia_tipo = 'consulta'/.test(sql)) return [datos.saldos];
  if (/AS pendientes/.test(sql)) return [[{ pendientes: 4, dispensadasHoy: 2, dispensadasMes: 9 }]];
  if (/SELECT COUNT\(\*\) AS total FROM consultas c/.test(sql)) return [[{ total: 1 }]];
  if (/FROM consultas c[\s\S]*LIMIT \? OFFSET \?/.test(sql)) {
    return [[{ id: 77, pacienteId: 501, paciente: 'Ana López', curp: null, medico: 'Dr. Ruiz', fecha: '2026-11-10 09:00:00', medicamentos: 2, recetaLibre: 0, dispensada: 0, dispensadaEn: null, dispensadaPor: null }]];
  }
  if (/FROM consultas c[\s\S]*WHERE c\.id = \?/.test(sql)) return [datos.detalle ? [{ ...datos.detalle }] : []];
  if (/FROM consulta_medicamento cm JOIN medicamentos/.test(sql)) return [datos.detalleMeds];
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
test.before(async () => { await new Promise((ok) => { server = app.listen(0, ok); }); base = `http://127.0.0.1:${server.address().port}/api/farmacia/recetas`; });
test.after(() => server.close());
test.beforeEach(() => {
  llamadas.length = 0; tx = {}; siguienteId = 100;
  datos = {
    consulta: { id: 77, paciente_id: 501, estado: 'finalizada', dispensada: 0, receta_libre: null },
    renglones: [12, 30],
    meds: {
      12: { id: 12, nombre: 'Paracetamol', stock_actual: 13, controlado: 0, psicotropico: 0 },
      30: { id: 30, nombre: 'Amoxicilina', stock_actual: 5, controlado: 0, psicotropico: 0 },
    },
    lotes: { 12: [{ id: 1, cantidad_disponible: 1 }, { id: 2, cantidad_disponible: 12 }], 30: [{ id: 9, cantidad_disponible: 5 }] },
    saldos: [],
    detalle: { id: 77, pacienteId: 501, paciente: 'Ana López', curp: null, medico: 'Dr. Ruiz', estado: 'finalizada', diagnostico: 'Faringitis', fecha: '2026-11-10 09:00:00', recetaLibre: null, dispensada: 0, dispensadaEn: null, dispensadaPor: null, notasDispensacion: null },
    detalleMeds: [{ medicamentoId: 12, nombre: 'Paracetamol', presentacion: 'Tabletas', concentracion: '500 mg', dosis: '500 mg', via: 'Oral', frecuencia: 'Cada 8 horas', duracion: '5 días', indicaciones: null, controlado: 0, psicotropico: 0, disponible: '13' }],
  };
});

const tk = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function pedir(ruta, { metodo = 'GET', body, id = 3 } = {}) {
  const r = await fetch(`${base}${ruta}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'X-Device-Fingerprint': 'prueba-dispositivo-0001', Authorization: `Bearer ${tk(id)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const dispensar = (body, id) => pedir('/77/dispensar', { metodo: 'POST', body, id });
const sqls = (re) => llamadas.filter((l) => re.test(l.sql));

test('dispensar: descuenta 1 unidad de cada medicamento por FEFO y marca la receta como dispensada', async () => {
  const r = await dispensar({ notas: 'Entregado al familiar', unidades: { 12: 2 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.dispensada, true);
  const [para, amox] = r.json.medicamentos;
  assert.deepEqual([para.unidades, para.stockAnterior, para.stockNuevo], [2, 13, 11]);
  assert.deepEqual(para.movimientos.map((m) => [m.loteId, m.cantidad]), [[1, 1], [2, 1]], 'primero agota el lote que caduca antes');
  assert.deepEqual([amox.unidades, amox.stockNuevo], [1, 4]);

  const mv = sqls(/INSERT INTO movimientos_inventario/);
  assert.equal(mv.length, 3);
  assert.match(mv[0].sql, /'salida'.*'consulta'.*'Dispensación de receta'/s);
  assert.deepEqual(mv[0].params, [12, 1, 3, -1, 13, 12, 77], 'cantidad negativa y referencia a la consulta, como la web');
  assert.deepEqual(sqls(/UPDATE medicamentos SET stock_actual = stock_actual - \?/).map((l) => l.params), [[2, 12], [1, 30]]);
  const marca = sqls(/UPDATE consultas SET dispensada = 1/)[0];
  assert.deepEqual(marca.params, [3, 'Entregado al familiar', 77]);
  assert.match(marca.sql, /dispensada_en = DATE_SUB\(UTC_TIMESTAMP\(\), INTERVAL 6 HOUR\)/, 'hora local de México, como Laravel');
  const aud = sqls(/INSERT INTO audit_logs/).at(-1);
  assert.equal(aud.params[3], 'dispensada');
  assert.equal(aud.params[4], 'dispensaciones');
  assert.deepEqual([tx.commit, tx.rollback, tx.release], [1, undefined, 1]);
});

test('dispensar: bloquea la consulta, los medicamentos y sus lotes en orden de id', async () => {
  datos.renglones = [30, 12, 12];
  await dispensar({});
  const bloqueos = sqls(/FOR UPDATE/).map((l) => (/FROM consultas/.test(l.sql) ? 'consulta' : /FROM medicamentos/.test(l.sql) ? `med ${l.params[0]}` : `lotes ${l.params[0]}`));
  assert.deepEqual(bloqueos, ['consulta', 'med 12', 'lotes 12', 'med 30', 'lotes 30'], 'un medicamento repetido se descuenta una sola vez');
  assert.ok(sqls(/FROM lotes/).every((l) => /fecha_caducidad >= DATE\(/.test(l.sql) && /ORDER BY fecha_caducidad ASC/.test(l.sql)), 'solo lotes vigentes, FEFO');
});

test('dispensar: si falta stock de cualquier medicamento no se descuenta nada (409 SIN_STOCK)', async () => {
  datos.lotes[30] = [];
  const r = await dispensar({ unidades: { 12: 20 } });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'SIN_STOCK');
  assert.match(r.json.error, /Paracetamol \(disponible: 13, se necesitan: 20\); Amoxicilina \(disponible: 0/);
  assert.equal(sqls(/^\s*UPDATE/).length, 0);
  assert.equal(sqls(/INSERT INTO movimientos_inventario/).length, 0);
  assert.deepEqual([tx.commit, tx.rollback, tx.release], [undefined, 1, 1]);
});

test('dispensar: una receta ya dispensada no se vuelve a descontar (409 YA_DISPENSADA)', async () => {
  datos.consulta.dispensada = 1;
  const r = await dispensar({});
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'YA_DISPENSADA');
  assert.equal(sqls(/FROM lotes/).length, 0);
});

test('dispensar: consulta sin receta (409 SIN_RECETA), en borrador (409) o inexistente (404)', async () => {
  datos.renglones = [];
  let r = await dispensar({});
  assert.equal(r.json.code, 'SIN_RECETA');
  datos.consulta.estado = 'borrador';
  r = await dispensar({});
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'CONSULTA_NO_FINALIZADA');
  datos.consulta = null;
  r = await dispensar({});
  assert.equal(r.status, 404);
});

test('dispensar: una receta solo en texto libre se marca sin tocar el inventario', async () => {
  datos.renglones = [];
  datos.consulta.receta_libre = 'Reposo y abundantes líquidos';
  const r = await dispensar({});
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.medicamentos, []);
  assert.equal(sqls(/INSERT INTO movimientos_inventario/).length, 0);
  assert.equal(sqls(/UPDATE consultas SET dispensada = 1/).length, 1);
});

test('dispensar: valida unidades y notas', async () => {
  for (const [body, msg] of [
    [{ unidades: { 99: 1 } }, /no está en la receta/],
    [{ unidades: { 12: 0 } }, /entero de 1 a 100/],
    [{ unidades: { 12: 1.5 } }, /entero de 1 a 100/],
    [{ unidades: [1] }, /debe ser un objeto/],
    [{ notas: 'x'.repeat(501) }, /500 caracteres/],
  ]) {
    const r = await dispensar(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.json.error, msg);
  }
  assert.equal((await pedir('/abc/dispensar', { metodo: 'POST', body: {} })).status, 400);
});

test('solo farmacia (y el administrador) dispensa; médico y enfermería reciben 403', async () => {
  assert.equal((await dispensar({}, 1)).status, 403);
  assert.equal((await dispensar({}, 2)).status, 403);
  assert.equal((await pedir('', { id: 2 })).status, 403);
  assert.equal((await dispensar({}, 4)).status, 200);
});

test('revertir: solo el administrador; devuelve a cada lote su saldo y repone el stock', async () => {
  datos.consulta.dispensada = 1;
  assert.equal((await pedir('/77/revertir', { metodo: 'POST', id: 3 })).status, 403);
  datos.saldos = [{ medicamento_id: 12, lote_id: 1, pendiente: '1' }, { medicamento_id: 12, lote_id: 2, pendiente: '1' }, { medicamento_id: 30, lote_id: 9, pendiente: '1' }];
  const r = await pedir('/77/revertir', { metodo: 'POST', id: 4 });
  assert.equal(r.status, 200);
  assert.equal(r.json.dispensada, false);
  assert.deepEqual(r.json.devueltos.map((d) => [d.medicamentoId, d.unidades, d.stockNuevo]), [[12, 2, 15], [30, 1, 6]]);
  assert.match(sqls(/FROM movimientos_inventario/)[0].sql, /-SUM\(cantidad\)[\s\S]*HAVING pendiente > 0/, 'usa el saldo: no devuelve dos veces');
  assert.deepEqual(sqls(/UPDATE lotes SET cantidad_disponible = cantidad_disponible \+ \?/).map((l) => l.params), [[1, 1], [1, 2], [1, 9]]);
  assert.deepEqual(sqls(/UPDATE medicamentos SET stock_actual = stock_actual \+ \?/).map((l) => l.params), [[2, 12], [1, 30]]);
  const mv = sqls(/INSERT INTO movimientos_inventario/);
  assert.equal(mv.length, 3);
  assert.match(mv[0].sql, /'entrada'/);
  assert.equal(mv[0].params.at(-1), 'Reversión de dispensación (Receta #77)');
  assert.equal(sqls(/UPDATE consultas SET dispensada = 0/).length, 1);
  assert.equal(tx.commit, 1);
});

test('revertir: una receta no dispensada responde 409 NO_DISPENSADA', async () => {
  const r = await pedir('/77/revertir', { metodo: 'POST', id: 4 });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'NO_DISPENSADA');
});

test('lista: filtra por estado y paciente, y convierte los indicadores a booleanos', async () => {
  const r = await pedir('?estado=pendientes&q=ana');
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 1);
  assert.deepEqual([r.json.data[0].recetaLibre, r.json.data[0].dispensada, r.json.data[0].medicamentos], [false, false, 2]);
  const sql = sqls(/LIMIT \? OFFSET \?/)[0];
  assert.match(sql.sql, /c\.estado = 'finalizada'[\s\S]*c\.dispensada = 0/);
  assert.deepEqual(sql.params.slice(0, 2), ['%ana%', '%ana%']);
  assert.equal((await pedir('?estado=otra')).status, 400);
});

test('detalle y resumen', async () => {
  let r = await pedir('/77');
  assert.equal(r.status, 200);
  assert.equal(r.json.medicamentos[0].disponible, 13);
  assert.equal(r.json.medicamentos[0].controlado, false);
  assert.equal(r.json.estado, undefined);
  datos.detalle.estado = 'borrador';
  assert.equal((await pedir('/77')).status, 404);
  r = await pedir('/resumen');
  assert.deepEqual(r.json, { pendientes: 4, dispensadasHoy: 2, dispensadasMes: 9 });
});
