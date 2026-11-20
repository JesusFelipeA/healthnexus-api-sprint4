// Prueba de carga con k6: simula el turno de enfermería tal como lo hace la app móvil.
// k6 no abre la app; reproduce las mismas peticiones HTTP que manda el teléfono a la API.
//
// Uso (PowerShell):
//   k6 run -e BASE=http://localhost:3000/api -e CORREO=qa.enfermeria@healthnexus.test -e CLAVE="..." carga\carga-turno-enfermeria.js
// Opcionales: -e USUARIOS=20 (enfermeras simultáneas) -e DURACION=1m
//
// NO la corras contra producción: la API limita a RATE_LIMIT_MAX peticiones por minuto por IP (120 por defecto)
// y todas las peticiones de k6 salen de tu IP. Úsala en local o QA con RATE_LIMIT_MAX alto.
import http from 'k6/http';
import { check, group, sleep, fail } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://localhost:3000/api';
const USUARIOS = Number(__ENV.USUARIOS || 20);
const DURACION = __ENV.DURACION || '1m';

// Métricas propias para ver cada pantalla por separado en el resumen
const tPacientes = new Trend('pantalla_pacientes_ms', true);
const tSignos = new Trend('pantalla_signos_ms', true);
const tGuardar = new Trend('guardar_signos_ms', true);
const duplicados = new Counter('registros_duplicados');

export const options = {
  scenarios: {
    turno: {
      executor: 'ramping-vus',
      stages: [
        { duration: '20s', target: USUARIOS }, // entran al turno
        { duration: DURACION, target: USUARIOS }, // trabajan
        { duration: '10s', target: 0 }, // salen
      ],
    },
  },
  // Criterios de aceptación: si alguno falla, k6 termina con código 99 (sirve para el CI)
  thresholds: {
    http_req_failed: ['rate<0.01'], // menos de 1 % de errores
    http_req_duration: ['p(95)<800'], // 95 % de las peticiones en menos de 800 ms
    checks: ['rate>0.99'],
    registros_duplicados: ['count==0'], // ningún reintento debe crear otra fila
  },
};

// Igual que la app (okhttp), pero con "k6" al final: así las trazas de la prueba se separan de las reales (cliente=k6)
const CLIENTE = 'okhttp/4.12.0 k6';

// Encabezados que manda la app: token, huella del teléfono (16 a 255 caracteres) y cliente okhttp de Android
function encabezados(token, vu) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Device-Fingerprint': `k6-telefono-${String(vu).padStart(4, '0')}`,
    'User-Agent': CLIENTE,
  };
}

// Una sola vez: inicia sesión como enfermería (el login limita 5 intentos fallidos por cuenta)
export function setup() {
  const r = http.post(`${BASE}/auth/login`, JSON.stringify({ email: __ENV.CORREO, password: __ENV.CLAVE }), {
    headers: { 'Content-Type': 'application/json', 'X-Device-Fingerprint': 'k6-telefono-setup-0001', 'User-Agent': CLIENTE },
  });
  if (r.status !== 200 || !r.json('token')) fail(`No se pudo iniciar sesión (${r.status}): ${r.body}`);
  const pac = http.get(`${BASE}/patients?limit=50`, { headers: encabezados(r.json('token'), 0) });
  const lista = Array.isArray(pac.json()) ? pac.json() : pac.json('data') || [];
  if (!lista.length) fail('La cuenta no ve pacientes: asígnale alguno antes de la prueba');
  return { token: r.json('token'), pacientes: lista.map((p) => p.id) };
}

export default function (datos) {
  const h = { headers: encabezados(datos.token, __VU) };
  const paciente = datos.pacientes[Math.floor(Math.random() * datos.pacientes.length)];

  group('Abrir Pacientes', () => {
    const r = http.get(`${BASE}/patients?limit=20`, { ...h, tags: { pantalla: 'pacientes' } });
    tPacientes.add(r.timings.duration);
    check(r, { 'pacientes 200': (x) => x.status === 200 });
  });
  sleep(1 + Math.random() * 2); // la enfermera lee la lista

  group('Abrir Signos vitales', () => {
    const r = http.get(`${BASE}/enfermeria/signos?pacienteId=${paciente}&limit=20`, { ...h, tags: { pantalla: 'signos' } });
    tSignos.add(r.timings.duration);
    check(r, { 'signos 200': (x) => x.status === 200 });
  });
  sleep(2 + Math.random() * 3); // captura los valores

  group('Guardar signos (como la cola sin conexión)', () => {
    const toma = {
      pacienteId: paciente,
      temperatura: Number((36 + Math.random() * 1.5).toFixed(1)),
      frecuenciaCardiaca: 60 + Math.floor(Math.random() * 40),
      saturacionOxigeno: 94 + Math.floor(Math.random() * 6),
      presionArterial: '120/80',
      clientUuid: crypto.randomUUID(),
      capturadoEn: new Date(Date.now() - Math.floor(Math.random() * 30) * 60000).toISOString(),
    };
    const r = http.post(`${BASE}/enfermeria/signos`, JSON.stringify(toma), { ...h, tags: { pantalla: 'guardar' } });
    tGuardar.add(r.timings.duration);
    check(r, { 'guardar 201': (x) => x.status === 201 });

    // La app reintenta si se cortó la red antes de recibir la respuesta: debe responder 200 duplicado
    const otra = http.post(`${BASE}/enfermeria/signos`, JSON.stringify(toma), { ...h, tags: { pantalla: 'reintento' } });
    check(otra, { 'reintento 200 duplicado': (x) => x.status === 200 && x.json('duplicado') === true });
    if (otra.status === 201) duplicados.add(1);
  });
  sleep(3 + Math.random() * 5); // siguiente paciente
}

// Al terminar: resumen en consola y reporte JUnit (cada umbral es un caso), como el resto de las pruebas
export function handleSummary(data) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const casos = [];
  for (const [metrica, m] of Object.entries(data.metrics)) {
    for (const [regla, r] of Object.entries(m.thresholds || {})) casos.push({ nombre: `${metrica} ${regla}`, ok: r.ok, valor: JSON.stringify(m.values) });
  }
  const fallas = casos.filter((c) => !c.ok).length;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="HealthNexus carga k6" tests="${casos.length}" failures="${fallas}">\n`
    + `  <testsuite name="turno-enfermeria" tests="${casos.length}" failures="${fallas}">\n`
    + casos.map((c) => `    <testcase classname="carga.turno-enfermeria" name="${esc(c.nombre)}">${c.ok ? '' : `<failure message="umbral no cumplido">${esc(c.valor)}</failure>`}</testcase>`).join('\n')
    + '\n  </testsuite>\n</testsuites>\n';
  const v = (n, k) => (data.metrics[n] ? data.metrics[n].values[k] : undefined);
  const ms = (x) => (x === undefined ? '—' : `${Math.round(x)} ms`);
  const texto = [
    '',
    `Peticiones: ${v('http_reqs', 'count')} (${(v('http_reqs', 'rate') || 0).toFixed(1)}/s) · errores: ${((v('http_req_failed', 'rate') || 0) * 100).toFixed(2)} %`,
    `Latencia total: p50 ${ms(v('http_req_duration', 'med'))} · p95 ${ms(v('http_req_duration', 'p(95)'))} · máx ${ms(v('http_req_duration', 'max'))}`,
    `Pacientes p95 ${ms(v('pantalla_pacientes_ms', 'p(95)'))} · Signos p95 ${ms(v('pantalla_signos_ms', 'p(95)'))} · Guardar p95 ${ms(v('guardar_signos_ms', 'p(95)'))}`,
    `Checks: ${((v('checks', 'rate') || 0) * 100).toFixed(2)} % · registros duplicados: ${v('registros_duplicados', 'count') || 0}`,
    ...casos.map((c) => `${c.ok ? '✓' : '✗'} ${c.nombre}`),
    '',
  ].join('\n');
  return { stdout: texto, 'reports/k6-turno-enfermeria.xml': xml, 'reports/k6-turno-enfermeria.json': JSON.stringify(data, null, 2) };
}
