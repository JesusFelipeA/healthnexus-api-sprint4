// Documentación de la API (Swagger UI en /api/docs): que esté completa, sea válida y se pueda usar.
process.env.JWT_SECRET = 'secreto-de-pruebas';
process.env.NODE_ENV = 'test';
process.env.CORS_ORIGINS = 'https://healthnexus-web.duckdns.org';

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const docs = require('../src/docs');
const spec = require('../src/openapi');

const METODOS = ['get', 'post', 'put', 'patch', 'delete'];

// Recorre el router de Express 4 y devuelve "GET /api/patients/{id}" por cada ruta registrada.
function rutasDeExpress() {
  const salida = new Set();
  const prefijo = (capa) => (capa.regexp.fast_slash ? '' : capa.regexp.source
    .replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/i, '').replace(/\\\//g, '/'));
  const ruta = (p) => p.replace(/:(\w+)(\([^)]*\))?/g, '{$1}');
  function recorrer(stack, base) {
    for (const capa of stack) {
      if (capa.route) {
        for (const m of Object.keys(capa.route.methods)) salida.add(`${m.toUpperCase()} ${ruta(base + capa.route.path).replace(/\/$/, '') || '/'}`);
      } else if (capa.name === 'router' && capa.handle.stack) {
        recorrer(capa.handle.stack, base + prefijo(capa));
      }
    }
  }
  recorrer(app._router.stack, '');
  return salida;
}
function rutasDeSpec() {
  const salida = new Set();
  for (const [p, ops] of Object.entries(spec.paths)) for (const m of Object.keys(ops)) if (METODOS.includes(m)) salida.add(`${m.toUpperCase()} ${p}`);
  return salida;
}
const propias = (r) => !r.includes('/api/docs');

let server, base;
test.before(async () => {
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('docs: todas las rutas de la API están documentadas en OpenAPI', () => {
  const express = [...rutasDeExpress()].filter(propias);
  const documentadas = rutasDeSpec();
  assert.ok(express.length >= 40, `se esperaban más de 40 rutas y hay ${express.length}`);
  const faltan = express.filter((r) => !documentadas.has(r));
  assert.deepEqual(faltan, [], `Rutas sin documentar en src/openapi.js: ${faltan.join(', ')}`);
});

test('docs: OpenAPI no documenta rutas que ya no existen', () => {
  const express = rutasDeExpress();
  const sobran = [...rutasDeSpec()].filter((r) => !express.has(r));
  assert.deepEqual(sobran, [], `Rutas documentadas que no existen: ${sobran.join(', ')}`);
});

test('docs: cada operación tiene resumen, etiqueta conocida y respuestas; las referencias existen', () => {
  const etiquetas = new Set(spec.tags.map((t) => t.name));
  const texto = JSON.stringify(spec);
  for (const r of texto.match(/#\/components\/(schemas|responses)\/\w+/g)) {
    const [, tipo, nombre] = r.match(/components\/(\w+)\/(\w+)/);
    assert.ok(spec.components[tipo][nombre], `referencia rota: ${r}`);
  }
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const [m, o] of Object.entries(ops)) {
      assert.ok(o.summary, `${m} ${p} sin resumen`);
      assert.ok(o.tags.every((t) => etiquetas.has(t)), `${m} ${p} con etiqueta desconocida`);
      assert.ok(Object.keys(o.responses).some((c) => c.startsWith('2')), `${m} ${p} sin respuesta 2xx`);
      for (const prm of (p.match(/\{(\w+)\}/g) || [])) {
        assert.ok((o.parameters || []).some((x) => x.in === 'path' && `{${x.name}}` === prm), `${m} ${p} no declara ${prm}`);
      }
      for (const sec of o.security || []) for (const k of Object.keys(sec)) assert.ok(spec.components.securitySchemes[k], `esquema de seguridad ${k} no existe`);
    }
  }
});

test('docs: rutas protegidas piden token y las públicas no', () => {
  const publicas = ['/api/health', '/api/auth/login', '/api/auth/pin', '/api/auth/recuperar', '/api/auth/recuperar/verificar', '/api/auth/recuperar/restablecer'];
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const o of Object.values(ops)) {
      const conToken = (o.security || []).some((s) => 'bearerAuth' in s);
      assert.equal(conToken, !publicas.includes(p), `${p}: seguridad incorrecta`);
      if (conToken) assert.ok(o.responses[401], `${p} debe documentar 401`);
    }
  }
});

test('docs: Swagger UI y la especificación se sirven en /api/docs', async () => {
  const html = await fetch(`${base}/api/docs/`);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /HealthNexus API · Documentación/);
  const r = await fetch(`${base}/api/docs/openapi.json`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.openapi, '3.0.3');
  assert.equal(j.info.title, 'HealthNexus API');
});

test('docs: se puede desactivar con API_DOCS=0', () => {
  assert.equal(docs.habilitada({}), true);
  assert.equal(docs.habilitada({ API_DOCS: '1' }), true);
  assert.equal(docs.habilitada({ API_DOCS: '0' }), false);
});

test('CORS: se aceptan el propio servidor (Swagger UI) y los orígenes configurados; otros no', async () => {
  const pedir = (origin) => fetch(`${base}/api/docs/openapi.json`, { headers: { Origin: origin } });
  const propio = await pedir(base);
  assert.equal(propio.status, 200);
  assert.equal(propio.headers.get('access-control-allow-origin'), base);
  const web = await pedir('https://healthnexus-web.duckdns.org');
  assert.equal(web.headers.get('access-control-allow-origin'), 'https://healthnexus-web.duckdns.org');
  // DEF-12: un origen ajeno recibe 403 con código fijo (antes 500 con la traza en el log)
  const otro = await pedir('https://sitio-malicioso.example');
  assert.equal(otro.status, 403);
  assert.equal(otro.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await otro.json(), { error: 'Origen no permitido', code: 'ORIGEN_NO_PERMITIDO' });
});
