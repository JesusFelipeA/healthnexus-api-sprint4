// La telemetría no debe sacar datos de pacientes del servidor
const test = require('node:test');
const assert = require('node:assert');
const { limpiarSpan, sinQuery, sinTextosCitados, familiaCliente, ACTIVA } = require('../src/telemetria');

test('telemetría: apagada si no hay OTEL_EXPORTER_OTLP_ENDPOINT', () => {
  assert.strictEqual(ACTIVA, false);
});

test('telemetría: quita la query string', () => {
  assert.strictEqual(sinQuery('/api/patients?q=Juan%20Castillo&limit=20'), '/api/patients');
  assert.strictEqual(sinQuery('/api/health'), '/api/health');
  assert.strictEqual(sinQuery(undefined), undefined);
});

test('telemetría: cambia por ? los textos entre comillas', () => {
  assert.strictEqual(sinTextosCitados("Duplicate entry 'CATJ850103HDGSRN13' for key 'curp'"), 'Duplicate entry ? for key ?');
  assert.strictEqual(sinTextosCitados('WHERE nombre = "Juan"'), 'WHERE nombre = ?');
  assert.strictEqual(sinTextosCitados(`apellido = "O'Brien"`), 'apellido = ?');
});

test('telemetría: limpia una traza HTTP con ruta y búsqueda de paciente', () => {
  const span = limpiarSpan({
    attributes: {
      'http.route': '/api/patients/:id(\\d+)',
      'http.target': '/api/patients/15?q=Castillo',
      'url.path': '/api/patients/15',
      'url.query': 'q=Castillo',
      'url.full': 'http://api/api/patients/15?q=Castillo',
      'http.url': 'http://api/api/patients/15?q=Castillo',
      'user_agent.original': 'okhttp/4.12.0',
      'http.user_agent.original': 'okhttp/4.12.0',
      'enduser.id': '7',
      'http.response.status_code': 200,
    },
    events: [],
  });
  const a = span.attributes;
  assert.strictEqual(a['http.target'], '/api/patients/:id(\\d+)');
  assert.strictEqual(a['url.path'], '/api/patients/:id(\\d+)');
  for (const k of ['url.query', 'url.full', 'http.url', 'user_agent.original', 'http.user_agent.original', 'enduser.id']) {
    assert.ok(!(k in a), `${k} no debe salir`);
  }
  assert.strictEqual(a['http.response.status_code'], 200);
  assert.ok(!JSON.stringify(span).includes('Castillo'));
});

test('telemetría: limpia SQL, errores y estado', () => {
  const span = limpiarSpan({
    attributes: { 'db.statement': "SELECT * FROM pacientes WHERE curp = 'CATJ850103HDGSRN13'", 'db.query.text': "x = 'Ana'" },
    events: [{ name: 'exception', attributes: {
      'exception.message': "Duplicate entry 'Ana López' for key 'nombre'",
      'exception.stacktrace': `Error: 'Ana López'\n${Array.from({ length: 20 }, (_, i) => `    at f${i}`).join('\n')}`,
    } }],
    status: { code: 2, message: "No existe 'Ana López'" },
  });
  assert.strictEqual(span.attributes['db.statement'], 'SELECT * FROM pacientes WHERE curp = ?');
  assert.strictEqual(span.attributes['db.query.text'], 'x = ?');
  assert.strictEqual(span.events[0].attributes['exception.message'], 'Duplicate entry ? for key ?');
  assert.strictEqual(span.events[0].attributes['exception.stacktrace'].split('\n').length, 8);
  assert.strictEqual(span.status.message, 'No existe ?');
  assert.ok(!JSON.stringify(span).includes('López'));
});

test('telemetría: familia del cliente sin guardar el user-agent', () => {
  assert.strictEqual(familiaCliente('okhttp/4.12.0'), 'app-android');
  assert.strictEqual(familiaCliente('okhttp/4.12.0 k6/1.3'), 'k6');
  assert.strictEqual(familiaCliente('Grafana k6/1.3.0'), 'k6');
  assert.strictEqual(familiaCliente('Mozilla/5.0 (Linux; Android 14)'), 'web');
  assert.strictEqual(familiaCliente('curl/8.5'), 'otro');
  assert.strictEqual(familiaCliente(undefined), 'otro');
});
