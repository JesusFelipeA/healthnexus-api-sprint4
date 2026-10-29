// Pruebas de la API sin base de datos real: se sustituye el pool de MySQL por un simulado.
// Cubren los casos del plan de pruebas CP-29, CP-32, CP-33, CP-34, CP-35 y CP-30 (validaciones).
//   Ejecutar:  npm test
process.env.JWT_SECRET = 'secreto-de-pruebas';
process.env.RATE_LIMIT_MAX = '1000';         // el límite global se prueba aparte (test/limite-global.test.js)
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const path = require('node:path');

// ---- pool simulado ---------------------------------------------------------
const llamadas = [];
let usuarios = {};                 // id -> { rol, activo }
let respuestas = [];               // [{ si: /regex/, devuelve: [...] }]
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
  getConnection: async () => ({ beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, query: pool.query }),
};
require.cache[require.resolve(path.join(__dirname, '../src/db.js'))] = { id: 'db', filename: 'db', loaded: true, exports: pool };
const app = require('../src/app');

// ---- servidor de pruebas ---------------------------------------------------
let server, base;
test.before(async () => {
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server.close());
test.beforeEach(() => { llamadas.length = 0; respuestas = []; usuarios = { 1: { rol: 'medico', activo: 1 }, 2: { rol: 'enfermeria', activo: 1 }, 3: { rol: 'farmacia', activo: 1 }, 4: { rol: 'administrador', activo: 1 }, 5: { rol: 'enfermeria', activo: 1 } }; });

const token = (id, opts = {}) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h', ...opts });
async function pedir(metodo, ruta, { id, tk, body, crudo } = {}) {
  const t = tk || (id ? token(id) : null);
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'X-Device-Fingerprint': 'prueba-dispositivo-0001', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    body: crudo !== undefined ? crudo : body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, json };
}

// ---- CP-33 / CP-34: acceso por rol y token --------------------------------------
test('CP-33: sin token responde 401', async () => {
  const r = await pedir('GET', '/patients');
  assert.equal(r.status, 401);
});

test('CP-33: con un rol no permitido responde 403 y con uno permitido entrega datos', async () => {
  const noPermitido = await pedir('GET', '/patients', { id: 3 });           // farmacia
  assert.equal(noPermitido.status, 403);
  respuestas = [{ si: /FROM pacientes p/, devuelve: [[{ id: 9, name: 'Ana Prueba', age: 30 }]] }];
  const permitido = await pedir('GET', '/patients', { id: 1 });             // médico
  assert.equal(permitido.status, 200);
  assert.deepEqual(permitido.json, [{ id: 9, name: 'Ana Prueba', age: 30 }]);
});

test('CP-34: token alterado, vencido o de cuenta desactivada responden 401', async () => {
  const bueno = token(1);
  const alterado = bueno.slice(0, -3) + (bueno.endsWith('abc') ? 'xyz' : 'abc');
  assert.equal((await pedir('GET', '/patients', { tk: alterado })).status, 401);
  assert.equal((await pedir('GET', '/patients', { tk: token(1, { expiresIn: -10 }) })).status, 401);
  assert.equal((await pedir('GET', '/patients', { tk: jwt.sign({ id: 1 }, 'otra-clave') })).status, 401);
  usuarios[1].activo = 0;
  assert.equal((await pedir('GET', '/patients', { id: 1 })).status, 401);
});

// ---- CP-29: triage solo para el médico ------------------------------------------
test('CP-29: enfermería y farmacia no pueden cambiar el triage; el médico sí llega al manejador', async () => {
  assert.equal((await pedir('PATCH', '/patients/5/triage', { id: 2, body: { triageLevel: 'rojo' } })).status, 403);
  assert.equal((await pedir('PATCH', '/patients/5/triage', { id: 3, body: { triageLevel: 'rojo' } })).status, 403);
  const medico = await pedir('PATCH', '/patients/5/triage', { id: 1, body: { triageLevel: 'azul-marino' } });
  assert.equal(medico.status, 400);                         // pasó la autorización y falló la validación
  assert.match(medico.json.error, /triageLevel inválido/);
});

test('CP-29: enfermería sigue pudiendo consultar la lista de triage', async () => {
  respuestas = [{ si: /FROM pacientes p/, devuelve: [[{ id: 5, name: 'Luis', triageLevel: 'rojo' }]] }];
  const r = await pedir('GET', '/triage', { id: 2 });
  assert.equal(r.status, 200);
});

test('CP-29: el cambio de triage queda en la bitácora con el nivel anterior y el nuevo', async () => {
  respuestas = [
    { si: /FROM pacientes WHERE id/, devuelve: [[{ id: 5 }]] },
    { si: /FROM admisiones WHERE paciente_id/, devuelve: [[{ id: 11, triage: 'verde' }]] },
  ];
  const r = await pedir('PATCH', '/patients/5/triage', { id: 1, body: { triageLevel: 'rojo' } });
  assert.equal(r.status, 200);
  const audit = llamadas.find((c) => /INSERT INTO audit_logs/.test(c.sql));
  assert.ok(audit, 'debe escribir en audit_logs');
  assert.ok(audit.params.includes('triage_cambiado'));
  assert.ok(audit.params.some((p) => typeof p === 'string' && p.includes('"triage":"verde"')));   // antes
  assert.ok(audit.params.some((p) => typeof p === 'string' && p.includes('"triage":"rojo"')));    // después
});

// ---- CP-32: botón de emergencia -------------------------------------------------
test('CP-32: solo médico y enfermería activan la emergencia; farmacia recibe 403', async () => {
  assert.equal((await pedir('POST', '/emergencias', { id: 3, body: {} })).status, 403);
  respuestas = [{ si: /INSERT INTO alertas/, devuelve: [{ insertId: 77 }] }];
  const r = await pedir('POST', '/emergencias', { id: 2, body: { mensaje: 'Código azul', ubicacion: { lat: 19.28, lng: -99.65 } } });
  assert.equal(r.status, 201);
  assert.equal(r.json.id, 77);
});

test('CP-32: la emergencia queda en la bitácora con el usuario y la ubicación', async () => {
  respuestas = [{ si: /INSERT INTO alertas/, devuelve: [{ insertId: 78 }] }];
  await pedir('POST', '/emergencias', { id: 1, body: { ubicacion: { lat: 19.1, lng: -99.2 } } });
  const audit = llamadas.find((c) => /INSERT INTO audit_logs/.test(c.sql));
  assert.ok(audit.params.includes('emergencia'));
  assert.ok(audit.params.includes(1));                       // user_id del médico
});

test('CP-32: una ubicación inválida se rechaza con 400', async () => {
  assert.equal((await pedir('POST', '/emergencias', { id: 4, body: { ubicacion: { lat: 999, lng: 0 } } })).status, 400);
  assert.equal((await pedir('POST', '/emergencias', { id: 4, body: { ubicacion: 'aquí' } })).status, 400);
});

test('CP-32: más de 3 activaciones por minuto del mismo usuario responden 429', async () => {
  respuestas = [{ si: /INSERT INTO alertas/, devuelve: [{ insertId: 90 }] }];
  const estados = [];
  for (let i = 0; i < 5; i++) estados.push((await pedir('POST', '/emergencias', { id: 5, body: {} })).status);
  assert.deepEqual(estados.slice(0, 3), [201, 201, 201]);
  assert.equal(estados[3], 429);
});

// ---- Emergencias activas (Dashboard) ---------------------------------------------
test('emergencia: va dirigida a todo el personal (user_id NULL) y guarda quién la activó', async () => {
  respuestas = [{ si: /INSERT INTO alertas/, devuelve: [{ insertId: 91 }] }];
  await pedir('POST', '/emergencias', { id: 2, body: {} });
  const ins = llamadas.find((c) => /INSERT INTO alertas/.test(c.sql));
  assert.match(ins.sql, /'activa', NULL/);
  assert.ok(ins.params.includes('App\\Models\\User'));
  assert.ok(ins.params.includes(2));
  assert.equal(JSON.parse(ins.params[1]).activadaPorId, 2);
});

test('emergencias activas: farmacia recibe 403; médico y enfermería ven quién, cuándo y dónde', async () => {
  assert.equal((await pedir('GET', '/emergencias/activas', { id: 3 })).status, 403);
  respuestas = [{ si: /FROM alertas/, devuelve: [[
    { id: 7, mensaje: 'Código azul', estado: 'activa', creada: '2026-10-28 21:00:00', datos: '{"activadaPor":"Enf. Ana","activadaPorId":2,"ubicacion":{"lat":19.28,"lng":-99.65}}' },
    { id: 6, mensaje: 'Código de emergencia activado', estado: 'vista', creada: '2026-10-28 20:00:00', datos: { activadaPor: 'Dr. Luis' } },
  ]] }];
  const r = await pedir('GET', '/emergencias/activas', { id: 2 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json[0], { id: 7, mensaje: 'Código azul', estado: 'activa', creada: '2026-10-28 21:00:00', activadaPor: 'Enf. Ana', activadaPorId: 2, ubicacion: { lat: 19.28, lng: -99.65 } });
  assert.equal(r.json[1].ubicacion, null);
  const sel = llamadas.find((c) => /FROM alertas/.test(c.sql));
  assert.match(sel.sql, /estado IN \('activa','vista'\)/);
  assert.match(sel.sql, /INTERVAL 24 HOUR/);
});

test('atender emergencia: valida el id, responde 404 si ya estaba atendida y deja registro', async () => {
  assert.equal((await pedir('PATCH', '/emergencias/abc/atender', { id: 1 })).status, 400);
  assert.equal((await pedir('PATCH', '/emergencias/7/atender', { id: 3 })).status, 403);
  respuestas = [{ si: /UPDATE alertas/, devuelve: [{ affectedRows: 0 }] }];
  assert.equal((await pedir('PATCH', '/emergencias/7/atender', { id: 1 })).status, 404);
  llamadas.length = 0;
  respuestas = [{ si: /UPDATE alertas/, devuelve: [{ affectedRows: 1 }] }];
  const r = await pedir('PATCH', '/emergencias/7/atender', { id: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { id: 7, estado: 'resuelta' });
  const up = llamadas.find((c) => /UPDATE alertas/.test(c.sql));
  assert.deepEqual(up.params, [1, 7]);
  const audit = llamadas.find((c) => /INSERT INTO audit_logs/.test(c.sql));
  assert.ok(audit.params.includes('emergencia_atendida'));
});

// ---- CP-30: hospitales y derivación externa -----------------------------------
test('CP-30: coordenadas fuera de rango o incompletas responden 400', async () => {
  assert.equal((await pedir('GET', '/hospitals?lat=999&lng=0', { id: 1 })).status, 400);
  assert.equal((await pedir('GET', '/hospitals?lat=19.2', { id: 1 })).status, 400);
  assert.equal((await pedir('GET', '/hospitals?lat=abc&lng=1', { id: 1 })).status, 400);
});

test('CP-30: con ubicación válida lista los hospitales cercanos con radio y límite', async () => {
  respuestas = [{ si: /FROM hospitales/, devuelve: [[{ id: 1, nombre: 'Hospital Cercano', distanciaKm: 2.3 }]] }];
  const r = await pedir('GET', '/hospitals?lat=19.28&lng=-99.65&radioKm=30&limite=5', { id: 1 });
  assert.equal(r.status, 200);
  const q = llamadas.find((c) => /FROM hospitales/.test(c.sql));
  assert.match(q.sql, /HAVING distanciaKm <= \?/);
  assert.deepEqual(q.params.slice(-2), [30, 5]);
});

test('CP-30: la derivación externa valida ids, rechaza una segunda derivación y entrega el folio', async () => {
  assert.equal((await pedir('POST', '/derivaciones/externas', { id: 1, body: { pacienteId: 'abc', hospitalId: 1, motivo: 'Falta UCI' } })).status, 400);
  respuestas = [
    { si: /FROM hospitales WHERE id/, devuelve: [[{ id: 1, nombre: 'Hospital General' }]] },
    { si: /FROM admisiones WHERE paciente_id/, devuelve: [[{ id: 3, estado: 'derivado', folio: 'ADM-1' }]] },
  ];
  assert.equal((await pedir('POST', '/derivaciones/externas', { id: 1, body: { pacienteId: 7, hospitalId: 1, motivo: 'Falta UCI' } })).status, 409);
  respuestas[1] = { si: /FROM admisiones WHERE paciente_id/, devuelve: [[{ id: 3, estado: 'en_espera', folio: 'ADM-1' }]] };
  const ok = await pedir('POST', '/derivaciones/externas', { id: 1, body: { pacienteId: 7, hospitalId: 1, motivo: 'Falta UCI' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.folio, 'ADM-1');
});

test('CP-30: solo el médico deriva a otro hospital', async () => {
  assert.equal((await pedir('POST', '/derivaciones/externas', { id: 2, body: { pacienteId: 7, hospitalId: 1, motivo: 'Falta UCI' } })).status, 403);
});

// ---- CP-35: entradas maliciosas y límites -----------------------------------------
test('CP-35: la inyección SQL en la búsqueda viaja como parámetro, nunca dentro del SQL', async () => {
  const ataque = "' OR 1=1; DROP TABLE pacientes; --";
  respuestas = [{ si: /FROM pacientes p/, devuelve: [[]] }];
  const r = await pedir('GET', `/patients?q=${encodeURIComponent(ataque)}`, { id: 1 });
  assert.equal(r.status, 200);
  const q = llamadas.find((c) => /FROM pacientes p/.test(c.sql));
  assert.ok(!q.sql.includes('DROP TABLE'));
  assert.ok(q.params.some((p) => String(p).includes('DROP TABLE')));
});

test('CP-35: un JSON mal formado responde 400 con mensaje fijo, sin detalles del parser', async () => {
  const r = await pedir('POST', '/auth/login', { crudo: '{"email": "a@b.com", ' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'JSON inválido');
});

test('CP-35: un cuerpo demasiado grande responde 413', async () => {
  const r = await pedir('POST', '/auth/login', { crudo: JSON.stringify({ email: 'x'.repeat(1_200_000) }) });
  assert.equal(r.status, 413);
});

test('CP-35: el login limita los intentos fallidos por cuenta (429)', async () => {
  respuestas = [{ si: /FROM users u/, devuelve: [[]] }];
  const estados = [];
  for (let i = 0; i < 7; i++) estados.push((await pedir('POST', '/auth/login', { body: { email: 'victima@hospital.com', password: 'mala' } })).status);
  assert.deepEqual(estados.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(estados[5], 429);
});

// ---- Triage: motivo y diagnóstico presuntivo se guardan en la admisión (los lee la app web) ----
test('Triage: el nivel, el motivo y el diagnóstico presuntivo se guardan en la admisión existente', async () => {
  respuestas = [
    { si: /FROM pacientes WHERE id/, devuelve: [[{ id: 5 }]] },
    { si: /FROM admisiones WHERE paciente_id/, devuelve: [[{ id: 11, triage: null }]] },
  ];
  const r = await pedir('PATCH', '/patients/5/triage', { id: 1, body: { triageLevel: 'amarillo', motivo: '  Dolor abdominal  ', diagnosticoPresuntivo: 'Apendicitis aguda' } });
  assert.equal(r.status, 200);
  const upd = llamadas.find((c) => /UPDATE admisiones SET triage/.test(c.sql));
  assert.ok(upd && /motivo = COALESCE/.test(upd.sql) && /diagnostico_presuntivo = COALESCE/.test(upd.sql));
  assert.deepEqual(upd.params, ['amarillo', 'Dolor abdominal', 'Apendicitis aguda', 1, 11]);
});

test('Triage: si el paciente no tiene admisión activa se crea con motivo, diagnóstico y el médico que clasifica', async () => {
  respuestas = [
    { si: /FROM pacientes WHERE id/, devuelve: [[{ id: 5 }]] },
    { si: /FROM admisiones WHERE paciente_id/, devuelve: [[]] },
    { si: /INSERT INTO admisiones/, devuelve: [{ insertId: 77 }] },
  ];
  const r = await pedir('PATCH', '/patients/5/triage', { id: 1, body: { triageLevel: 'rojo', motivo: 'Dolor de pecho', diagnosticoPresuntivo: 'Infarto' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.admisionCreada, true);
  const ins = llamadas.find((c) => /INSERT INTO admisiones/.test(c.sql));
  assert.ok(/motivo, diagnostico_presuntivo/.test(ins.sql));
  assert.ok(ins.params.includes('Dolor de pecho') && ins.params.includes('Infarto') && ins.params.includes('rojo'));
  assert.equal(ins.params[2], 1);   // medico_id
});

test('Triage: motivo o diagnóstico demasiado cortos o de tipo inválido responden 400 sin tocar la base', async () => {
  for (const body of [{ triageLevel: 'rojo', motivo: 'ab' }, { triageLevel: 'rojo', diagnosticoPresuntivo: 'x' }, { triageLevel: 'rojo', motivo: 123 }]) {
    llamadas.length = 0;
    const r = await pedir('PATCH', '/patients/5/triage', { id: 1, body });
    assert.equal(r.status, 400);
    assert.equal(llamadas.filter((c) => /admisiones/.test(c.sql)).length, 0);
  }
});

test('Triage: sin motivo ni diagnóstico se conserva lo que ya hubiera (compatibilidad)', async () => {
  respuestas = [
    { si: /FROM pacientes WHERE id/, devuelve: [[{ id: 5 }]] },
    { si: /FROM admisiones WHERE paciente_id/, devuelve: [[{ id: 11, triage: 'verde' }]] },
  ];
  const r = await pedir('PATCH', '/patients/5/triage', { id: 1, body: { triageLevel: 'rojo' } });
  assert.equal(r.status, 200);
  const upd = llamadas.find((c) => /UPDATE admisiones SET triage/.test(c.sql));
  assert.deepEqual(upd.params, ['rojo', null, null, 1, 11]);
});

test('Triage: la lista devuelve motivo (reason) y diagnóstico presuntivo para precargar el formulario', async () => {
  respuestas = [{ si: /FROM pacientes p/, devuelve: [[{ id: 5, name: 'Luis', triageLevel: 'rojo', reason: 'Fiebre', diagnosticoPresuntivo: 'Dengue' }]] }];
  const r = await pedir('GET', '/triage', { id: 2 });
  assert.equal(r.json[0].reason, 'Fiebre');
  const sql = llamadas.find((c) => /FROM pacientes p/.test(c.sql)).sql;
  assert.ok(/a\.motivo AS reason/.test(sql) && /a\.diagnostico_presuntivo AS diagnosticoPresuntivo/.test(sql));
});

test('Hora: el triage guarda la llegada en hora de México (la web filtra por fecha local), no en UTC', async () => {
  respuestas = [
    { si: /FROM pacientes WHERE id/, devuelve: [[{ id: 5 }]] },
    { si: /FROM admisiones WHERE paciente_id/, devuelve: [[]] },
    { si: /INSERT INTO admisiones/, devuelve: [{ insertId: 77 }] },
  ];
  await pedir('PATCH', '/patients/5/triage', { id: 1, body: { triageLevel: 'verde', motivo: 'Revisión', diagnosticoPresuntivo: 'Sin datos' } });
  const ins = llamadas.find((c) => /INSERT INTO admisiones/.test(c.sql));
  assert.match(ins.sql, /DATE_SUB\(UTC_TIMESTAMP\(\), INTERVAL 6 HOUR\)/);
  assert.doesNotMatch(ins.sql, /fecha_hora_llegada[^)]*\)\s*VALUES \(\?,\?,\?,\?,NOW\(\)/);
});

// ---- Sprint 4: HU-38 filtro de triage en /patients y HU-40 paginación --------------
test('HU-38: GET /patients filtra por nivel de triage y rechaza niveles inválidos', async () => {
  const r = await pedir('GET', '/patients?nivel=rojo', { id: 1 });
  assert.equal(r.status, 200);
  const q = llamadas.find((l) => /FROM pacientes p/.test(l.sql));
  assert.match(q.sql, /a\.triage FROM admisiones a/);
  assert.ok(q.params.includes('rojo'));
  assert.equal((await pedir('GET', '/patients?nivel=morado', { id: 1 })).status, 400);
  await pedir('GET', '/patients?nivel=sin', { id: 1 });
  assert.match(llamadas.filter((l) => /FROM pacientes p/.test(l.sql)).at(-1).sql, /IS NULL/);
});

test('HU-40: /seguimiento y /enfermeria/administraciones paginan con page y devuelven X-Total-Count', async () => {
  respuestas = [{ si: /COUNT\(\*\) AS total/, devuelve: [[{ total: 37 }]] }];
  const t = token(2);
  const s = await fetch(`${base}/seguimiento?limit=10&page=2`, { headers: { Authorization: `Bearer ${t}` } });
  assert.equal(s.status, 200);
  assert.equal(s.headers.get('x-total-count'), '37');
  const qs = llamadas.find((l) => /FROM seguimientos s\s+JOIN/.test(l.sql));
  assert.deepEqual(qs.params.slice(-2), [10, 10]);
  const a = await fetch(`${base}/enfermeria/administraciones?limit=5&page=3`, { headers: { Authorization: `Bearer ${t}` } });
  assert.equal(a.status, 200);
  assert.equal(a.headers.get('x-total-count'), '37');
  const qa = llamadas.find((l) => /FROM administraciones_medicamento a\s+JOIN/.test(l.sql));
  assert.deepEqual(qa.params.slice(-2), [5, 10]);
});
