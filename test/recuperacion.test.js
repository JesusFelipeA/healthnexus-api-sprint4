// Recuperación de contraseña con código por correo (src/routes/recuperacion.js) y cierre de sesiones (middleware auth).
// La base de datos es un simulador en memoria que entiende solo las consultas de este flujo.
process.env.JWT_SECRET = 'secreto-de-pruebas';
process.env.RATE_LIMIT_MAX = '1000';
process.env.NODE_ENV = 'test';
process.env.TRUST_PROXY = '1'; // cada prueba usa su propia IP (X-Forwarded-For) para no compartir los límites

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// ---------- Base de datos simulada ----------
const db = { users: [], codigos: [], revocadas: new Map(), audit: [], llamadas: [] };
let sigCodigo = 1;
const ahoraSeg = () => Math.floor(Date.now() / 1000);

const usuarioPorId = (id) => db.users.find((u) => u.id === Number(id));
const filaUsuario = (u, revocacion) => (u ? [{ id: u.id, name: u.name, email: u.email, activo: u.activo, rol: u.rol,
  ...(revocacion ? { desde_epoch: db.revocadas.get(u.id) || null } : {}) }] : []);

const pool = {
  query: async (sql, p = []) => {
    db.llamadas.push({ sql, params: p });
    if (/INSERT INTO audit_logs/.test(sql)) { db.audit.push({ evento: p[3], user_id: p[0], descripcion: p[5], severidad: p[11], sensible: p[12] }); return [{ insertId: db.audit.length }]; }
    if (/FROM users u[\s\S]*WHERE u\.email = \?/.test(sql)) return [filaUsuario(db.users.find((u) => u.email === p[0]))];
    if (/FROM users u[\s\S]*WHERE u\.id = \?/.test(sql)) return [filaUsuario(usuarioPorId(p[0]), /sesiones_revocadas/.test(sql))];
    if (/^UPDATE recuperacion_clave SET usado_en = UTC_TIMESTAMP\(\) WHERE user_id = \? AND usado_en IS NULL$/.test(sql.trim())) {
      db.codigos.filter((c) => c.user_id === p[0] && !c.usado).forEach((c) => { c.usado = Date.now(); });
      return [{ affectedRows: 1 }];
    }
    if (/INSERT INTO recuperacion_clave/.test(sql)) {
      db.codigos.push({ id: sigCodigo++, user_id: p[0], codigo_hash: p[1], intentos: 0, expira: Date.now() + 15 * 60 * 1000, usado: null, ip: p[2] });
      return [{ insertId: sigCodigo - 1 }];
    }
    if (/SELECT id, codigo_hash, intentos FROM recuperacion_clave/.test(sql)) {
      const v = db.codigos.filter((c) => c.user_id === p[0] && !c.usado && c.expira > Date.now()).sort((a, b) => b.id - a.id)[0];
      return [v ? [{ id: v.id, codigo_hash: v.codigo_hash, intentos: v.intentos }] : []];
    }
    if (/UPDATE recuperacion_clave SET intentos = \?/.test(sql)) {
      const c = db.codigos.find((x) => x.id === p[2]);
      c.intentos = p[0];
      if (p[1] >= 5) c.usado = Date.now();
      return [{ affectedRows: 1 }];
    }
    if (/UPDATE recuperacion_clave SET usado_en = UTC_TIMESTAMP\(\) WHERE id = \? AND user_id = \? AND usado_en IS NULL/.test(sql)) {
      const c = db.codigos.find((x) => x.id === p[0] && x.user_id === p[1] && !x.usado);
      if (c) c.usado = Date.now();
      return [{ affectedRows: c ? 1 : 0 }];
    }
    if (/UPDATE users SET password = \?/.test(sql)) {
      const u = usuarioPorId(p[1]);
      u.password = p[0];
      u.remember_token = null;
      return [{ affectedRows: 1 }];
    }
    if (/INSERT INTO sesiones_revocadas/.test(sql)) { db.revocadas.set(p[0], p[1]); return [{ affectedRows: 1 }]; }
    return [{ affectedRows: 1 }];
  },
};
require.cache[require.resolve(path.join(__dirname, '../src/db.js'))] = { id: 'db', filename: 'db', loaded: true, exports: pool };

// ---------- Correo simulado: guarda lo que se "envía" ----------
const correo = require('../src/correo');
const enviados = [];
correo._usarEnvio(async (m) => { enviados.push(m); });
const codigoDe = (email) => {
  const m = [...enviados].reverse().find((x) => x.to === email);
  return m && (m.text.match(/\b(\d{6})\b/) || [])[1];
};

const app = require('../src/app');
const { revisarClave, generarCodigo } = require('../src/routes/recuperacion');

let server, base, ipSig = 1;
test.before(async () => { await new Promise((ok) => { server = app.listen(0, ok); }); base = `http://127.0.0.1:${server.address().port}/api`; });
test.after(() => server.close());

const nuevaIp = () => `10.0.0.${ipSig++}`;
const pedir = async (metodo, ruta, body, { ip = nuevaIp(), token } = {}) => {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': ip };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(base + ruta, { method: metodo, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
};
const post = (ruta, body, op) => pedir('POST', ruta, body, op);

let sigUsuario = 500;
function crearUsuario(extra = {}) {
  const id = sigUsuario++;
  const u = { id, name: `Usuario ${id}`, email: `u${id}@hospital.mx`, password: bcrypt.hashSync('Vieja1234', 4).replace('$2a$', '$2y$'),
    activo: 1, rol: 'enfermeria', remember_token: 'recordar', ...extra };
  db.users.push(u);
  return u;
}

// Pide el código y lo verifica: devuelve el resetToken
async function obtenerResetToken(u) {
  const ip = nuevaIp();
  assert.equal((await post('/auth/recuperar', { email: u.email }, { ip })).status, 202);
  const r = await post('/auth/recuperar/verificar', { email: u.email, codigo: codigoDe(u.email) }, { ip });
  assert.equal(r.status, 200);
  return r.json.resetToken;
}

// ---------- Paso 1: pedir el código ----------

test('recuperar: un correo que no existe responde 202 igual que uno real y no envía nada', async () => {
  const antes = enviados.length;
  const r = await post('/auth/recuperar', { email: 'nadie@hospital.mx' });
  assert.equal(r.status, 202);
  assert.match(r.json.mensaje, /Si el correo pertenece a una cuenta activa/);
  assert.equal(enviados.length, antes);
  assert.equal(db.codigos.length, 0);
});

test('recuperar: la respuesta es idéntica exista o no la cuenta (no se pueden adivinar correos)', async () => {
  const u = crearUsuario();
  const a = await post('/auth/recuperar', { email: u.email });
  const b = await post('/auth/recuperar', { email: 'no-existe@hospital.mx' });
  assert.equal(a.status, b.status);
  assert.deepEqual(a.json, b.json);
});

test('recuperar: una cuenta desactivada no recibe código', async () => {
  const u = crearUsuario({ activo: 0 });
  const r = await post('/auth/recuperar', { email: u.email });
  assert.equal(r.status, 202);
  assert.equal(codigoDe(u.email), undefined);
});

test('recuperar: correo con formato inválido responde 400', async () => {
  for (const email of ['', 'sin-arroba', 'a@b', 'con espacio@h.mx']) {
    const r = await post('/auth/recuperar', { email });
    assert.equal(r.status, 400, email);
  }
});

test('recuperar: envía un código de 6 dígitos, guarda solo su hash bcrypt y lo deja en la bitácora', async () => {
  const u = crearUsuario({ email: 'Ana.Lopez@hospital.mx'.toLowerCase() });
  const r = await post('/auth/recuperar', { email: '  ANA.LOPEZ@hospital.mx ' }); // se normaliza
  assert.equal(r.status, 202);
  assert.equal(r.json.minutos, 15);
  const codigo = codigoDe(u.email);
  assert.match(codigo, /^\d{6}$/);
  const fila = db.codigos.find((c) => c.user_id === u.id);
  assert.ok(fila.codigo_hash.startsWith('$2'));
  assert.notEqual(fila.codigo_hash, codigo);
  assert.ok(bcrypt.compareSync(codigo, fila.codigo_hash));
  // El código no aparece en ninguna consulta ni en la bitácora
  assert.equal(db.llamadas.some((l) => JSON.stringify(l.params).includes(codigo)), false);
  assert.ok(db.audit.some((a) => a.evento === 'recuperacion_solicitada' && a.user_id === u.id));
  const m = enviados.find((x) => x.to === u.email);
  assert.match(m.subject, new RegExp(codigo));
  assert.match(m.text, /Vence en 15 minutos/);
});

test('recuperar: pedir otro código invalida el anterior', async () => {
  const u = crearUsuario();
  const ip = nuevaIp();
  await post('/auth/recuperar', { email: u.email }, { ip });
  const primero = codigoDe(u.email);
  await post('/auth/recuperar', { email: u.email }, { ip });
  const segundo = codigoDe(u.email);
  assert.equal(db.codigos.filter((c) => c.user_id === u.id && !c.usado).length, 1);
  if (primero !== segundo) {
    const r = await post('/auth/recuperar/verificar', { email: u.email, codigo: primero }, { ip });
    assert.equal(r.status, 400);
  }
  const ok = await post('/auth/recuperar/verificar', { email: u.email, codigo: segundo }, { ip });
  assert.equal(ok.status, 200);
});

test('recuperar: más de 3 solicitudes por correo en una hora responde 429 (aunque cambie la IP)', async () => {
  const u = crearUsuario();
  for (let i = 0; i < 3; i++) assert.equal((await post('/auth/recuperar', { email: u.email })).status, 202);
  const r = await post('/auth/recuperar', { email: u.email });
  assert.equal(r.status, 429);
  assert.match(r.json.error, /varios códigos/);
});

test('recuperar: más de 10 solicitudes desde una IP en 15 minutos responde 429', async () => {
  const ip = nuevaIp();
  for (let i = 0; i < 10; i++) assert.equal((await post('/auth/recuperar', { email: `barrido${i}@hospital.mx` }, { ip })).status, 202);
  const r = await post('/auth/recuperar', { email: 'barrido-final@hospital.mx' }, { ip });
  assert.equal(r.status, 429);
});

// ---------- Paso 2: verificar el código ----------

test('verificar: con el código correcto entrega un resetToken de 10 minutos que no es token de acceso', async () => {
  const u = crearUsuario();
  const resetToken = await obtenerResetToken(u);
  const d = jwt.decode(resetToken);
  assert.equal(d.etapa, 'reset');
  assert.equal(d.id, u.id);
  assert.ok(d.exp - d.iat <= 600);
  // No sirve como Bearer en las rutas protegidas
  const r = await pedir('GET', '/auth/me', null, { token: resetToken });
  assert.equal(r.status, 401);
});

test('verificar: un código incorrecto responde 400 con mensaje genérico y suma un intento', async () => {
  const u = crearUsuario();
  const ip = nuevaIp();
  await post('/auth/recuperar', { email: u.email }, { ip });
  const malo = codigoDe(u.email) === '000000' ? '111111' : '000000';
  const r = await post('/auth/recuperar/verificar', { email: u.email, codigo: malo }, { ip });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'CODIGO_INVALIDO');
  assert.equal(db.codigos.find((c) => c.user_id === u.id && !c.usado).intentos, 1);
  assert.ok(db.audit.some((a) => a.evento === 'recuperacion_codigo_fallido' && a.user_id === u.id));
});

test('verificar: un correo sin código responde lo mismo que un código incorrecto', async () => {
  const r = await post('/auth/recuperar/verificar', { email: 'nadie@hospital.mx', codigo: '123456' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'CODIGO_INVALIDO');
});

test('verificar: el código debe ser de exactamente 6 dígitos', async () => {
  for (const codigo of ['12345', '1234567', 'abcdef', '']) {
    const r = await post('/auth/recuperar/verificar', { email: 'x@hospital.mx', codigo });
    assert.equal(r.status, 400, codigo);
  }
});

test('verificar: al 5.º error el código se invalida y ni el correcto sirve después', async () => {
  const u = crearUsuario();
  const ip = nuevaIp();
  await post('/auth/recuperar', { email: u.email }, { ip });
  const bueno = codigoDe(u.email);
  const malo = bueno === '999999' ? '888888' : '999999';
  let r;
  for (let i = 0; i < 5; i++) r = await post('/auth/recuperar/verificar', { email: u.email, codigo: malo }, { ip });
  assert.equal(r.json.code, 'CODIGO_BLOQUEADO');
  assert.ok(db.audit.some((a) => a.evento === 'recuperacion_bloqueada' && a.user_id === u.id));
  const despues = await post('/auth/recuperar/verificar', { email: u.email, codigo: bueno }, { ip });
  assert.equal(despues.status, 400);
});

test('verificar: un código vencido (más de 15 minutos) ya no sirve', async () => {
  const u = crearUsuario();
  const ip = nuevaIp();
  await post('/auth/recuperar', { email: u.email }, { ip });
  db.codigos.find((c) => c.user_id === u.id && !c.usado).expira = Date.now() - 1000;
  const r = await post('/auth/recuperar/verificar', { email: u.email, codigo: codigoDe(u.email) }, { ip });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'CODIGO_INVALIDO');
});

// ---------- Paso 3: contraseña nueva ----------

test('restablecer: rechaza contraseñas que no cumplen la política y el resetToken sigue sirviendo', async () => {
  const u = crearUsuario();
  const resetToken = await obtenerResetToken(u);
  for (const nueva of ['Corta1', 'sinmayuscula1', 'SinNumeroAqui', 'A1' + 'x'.repeat(80)]) {
    const r = await post('/auth/recuperar/restablecer', { resetToken, nueva });
    assert.equal(r.status, 400, nueva);
    assert.equal(r.json.code, 'CLAVE_DEBIL');
  }
  const ok = await post('/auth/recuperar/restablecer', { resetToken, nueva: 'Hospital2026' });
  assert.equal(ok.status, 200);
});

test('restablecer: guarda la contraseña en formato Laravel ($2y$, costo 12), borra remember_token y audita', async () => {
  const u = crearUsuario();
  const resetToken = await obtenerResetToken(u);
  const r = await post('/auth/recuperar/restablecer', { resetToken, nueva: 'NuevaClave2026' });
  assert.equal(r.status, 200);
  assert.ok(u.password.startsWith('$2y$12$'));
  assert.ok(bcrypt.compareSync('NuevaClave2026', u.password));
  assert.equal(bcrypt.compareSync('Vieja1234', u.password), false);
  assert.equal(u.remember_token, null);
  const a = db.audit.find((x) => x.evento === 'clave_restablecida' && x.user_id === u.id);
  assert.ok(a);
  assert.equal(a.sensible, 1);
  assert.equal(db.llamadas.some((l) => JSON.stringify(l.params).includes('NuevaClave2026')), false, 'la contraseña en claro nunca llega a la base');
});

test('restablecer: el resetToken solo sirve una vez', async () => {
  const u = crearUsuario();
  const resetToken = await obtenerResetToken(u);
  assert.equal((await post('/auth/recuperar/restablecer', { resetToken, nueva: 'Primera2026' })).status, 200);
  const r = await post('/auth/recuperar/restablecer', { resetToken, nueva: 'Segunda2026' });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'RESET_EXPIRADO');
  assert.ok(bcrypt.compareSync('Primera2026', u.password));
});

test('restablecer: rechaza tokens falsos, vencidos o de otro tipo', async () => {
  const u = crearUsuario();
  const casos = [
    'no-es-un-token',
    jwt.sign({ id: u.id, rid: 1, etapa: 'reset' }, 'otra-clave'),
    jwt.sign({ id: u.id, rid: 1, etapa: 'reset' }, 'secreto-de-pruebas|reset', { expiresIn: -10 }),
    jwt.sign({ id: u.id, nombre: 'x', rol: 'enfermeria' }, 'secreto-de-pruebas'), // token de acceso
    jwt.sign({ id: u.id, etapa: 'pin' }, 'secreto-de-pruebas|pin'), // pinToken
  ];
  for (const resetToken of casos) {
    const r = await post('/auth/recuperar/restablecer', { resetToken, nueva: 'Valida2026' });
    assert.equal(r.status, 401, resetToken);
  }
});

test('restablecer: si desactivan la cuenta entre el código y la contraseña nueva, no se cambia', async () => {
  const u = crearUsuario();
  const resetToken = await obtenerResetToken(u);
  const antes = u.password;
  u.activo = 0;
  const r = await post('/auth/recuperar/restablecer', { resetToken, nueva: 'Valida2026' });
  assert.equal(r.status, 401);
  assert.equal(u.password, antes);
});

// ---------- Cierre de sesiones ----------

test('sesiones: tras restablecer, los tokens de la app emitidos antes responden 401 SESION_REVOCADA y los nuevos sí sirven', async () => {
  const u = crearUsuario();
  const viejo = jwt.sign({ id: u.id, nombre: u.name, rol: u.rol, iat: ahoraSeg() - 120 }, 'secreto-de-pruebas');
  assert.equal((await pedir('GET', '/auth/me', null, { token: viejo })).status, 200);

  const resetToken = await obtenerResetToken(u);
  assert.equal((await post('/auth/recuperar/restablecer', { resetToken, nueva: 'Cerrar2026' })).status, 200);

  const r = await pedir('GET', '/auth/me', null, { token: viejo });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'SESION_REVOCADA');

  const nuevo = jwt.sign({ id: u.id, nombre: u.name, rol: u.rol, iat: ahoraSeg() + 1 }, 'secreto-de-pruebas');
  assert.equal((await pedir('GET', '/auth/me', null, { token: nuevo })).status, 200);
});

test('sesiones: si aún no existe la tabla sesiones_revocadas la API sigue funcionando', async () => {
  // Módulo nuevo del middleware con una base que no tiene la tabla
  const mwPath = require.resolve('../src/middleware');
  const original = require.cache[mwPath];
  delete require.cache[mwPath];
  const u = crearUsuario();
  const consultas = [];
  const sinTabla = {
    query: async (sql, p) => {
      consultas.push(sql);
      if (/sesiones_revocadas/.test(sql)) { const e = new Error("Table 'sesiones_revocadas' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; }
      return pool.query(sql, p);
    },
  };
  const dbPath = require.resolve(path.join(__dirname, '../src/db.js'));
  const dbOriginal = require.cache[dbPath];
  require.cache[dbPath] = { ...dbOriginal, exports: sinTabla };
  const avisos = [];
  const warn = console.warn;
  console.warn = (m) => avisos.push(m);
  try {
    const { auth } = require('../src/middleware');
    const token = jwt.sign({ id: u.id, nombre: u.name, rol: u.rol }, 'secreto-de-pruebas');
    for (let i = 0; i < 2; i++) {
      let siguiente = false;
      const res = { status: () => ({ json: () => {} }) };
      await auth({ headers: { authorization: `Bearer ${token}` } }, res, () => { siguiente = true; });
      assert.equal(siguiente, true);
    }
    assert.equal(consultas.filter((s) => /sesiones_revocadas/.test(s)).length, 1, 'solo lo intenta una vez');
    assert.equal(avisos.length, 1);
  } finally {
    console.warn = warn;
    require.cache[dbPath] = dbOriginal;
    require.cache[mwPath] = original;
  }
});

// ---------- Reglas y correo ----------

test('política de contraseña: 8+ caracteres, una mayúscula y un número', () => {
  assert.equal(revisarClave('Hospital2026'), null);
  assert.equal(revisarClave('Ñandú2026x'), null);
  assert.match(revisarClave('Ab1'), /8 caracteres/);
  assert.match(revisarClave('hospital2026'), /mayúscula/);
  assert.match(revisarClave('HospitalSin'), /número/);
  assert.match(revisarClave('A1' + 'é'.repeat(40)), /larga/); // 82 bytes
});

test('el código siempre tiene 6 dígitos (incluye ceros a la izquierda)', () => {
  for (let i = 0; i < 2000; i++) assert.match(generarCodigo(), /^\d{6}$/);
});

test('correo: en producción sin SMTP no se envía y el código NUNCA aparece en los logs', async () => {
  correo._usarEnvio(null);
  const env = { ...process.env };
  process.env.NODE_ENV = 'production';
  delete process.env.SMTP_HOST;
  const salida = [];
  const log = console.log, error = console.error;
  console.log = (...a) => salida.push(a.join(' '));
  console.error = (...a) => salida.push(a.join(' '));
  try {
    const ok = await correo.enviarCodigoRecuperacion({ para: 'x@hospital.mx', nombre: 'X', codigo: '482913' });
    assert.equal(ok, false);
    assert.equal(salida.join('\n').includes('482913'), false);
    assert.match(salida.join('\n'), /falta SMTP_HOST/);
  } finally {
    console.log = log; console.error = error;
    process.env.NODE_ENV = env.NODE_ENV;
    correo._usarEnvio(async (m) => { enviados.push(m); });
  }
});

test('correo: en desarrollo sin SMTP el código se imprime en la consola para poder probar', async () => {
  correo._usarEnvio(null);
  const salida = [];
  const log = console.log;
  console.log = (...a) => salida.push(a.join(' '));
  try {
    assert.equal(await correo.enviarCodigoRecuperacion({ para: 'x@hospital.mx', codigo: '000731' }), true);
    assert.match(salida.join('\n'), /000731/);
  } finally {
    console.log = log;
    correo._usarEnvio(async (m) => { enviados.push(m); });
  }
});

test('correo: el nombre del usuario se escapa en el HTML', () => {
  const m = correo.mensajeCodigo({ nombre: '<script>x</script>', codigo: '123456', minutos: 15 });
  assert.equal(m.html.includes('<script>'), false);
  assert.match(m.html, /&lt;script&gt;/);
});
