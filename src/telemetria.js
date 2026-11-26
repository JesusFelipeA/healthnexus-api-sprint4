// Observabilidad con OpenTelemetry: trazas y métricas de la API hacia un colector (Grafana Alloy).
//
// Se carga ANTES que el resto de la API para poder instrumentar http, express y mysql2:
//   node --require ./src/telemetria.js src/server.js
// Sin OTEL_EXPORTER_OTLP_ENDPOINT no hace nada (pruebas, desarrollo, servidores sin Alloy).
//
// Privacidad: la API maneja datos de pacientes. Antes de salir del servidor se quitan:
//   - la query string de las URLs (?q=nombre, ?pacienteId=…) y los ids de la ruta (/patients/15 → /patients/:id),
//   - los valores de las consultas SQL (quedan como ?),
//   - los textos entre comillas de los mensajes de error (pueden traer un nombre o una CURP).
// Nunca se capturan encabezados (Authorization, huella del dispositivo) ni cuerpos.

const ACTIVA = !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT && process.env.OTEL_SDK_DISABLED !== 'true';

// Rutas que no aportan y solo hacen ruido (chequeo de Docker cada 30 s, archivos de Swagger)
const RUTAS_IGNORADAS = [/^\/api\/health\b/, /^\/api\/docs\//];

/** Quita la query string de cualquier URL o ruta: '/api/patients?q=Ana' → '/api/patients' */
function sinQuery(valor) {
  return typeof valor === 'string' ? valor.split('?')[0] : valor;
}

/** Cambia por '?' lo que va entre comillas: "Duplicate entry 'Ana López'" → "Duplicate entry ?" */
function sinTextosCitados(valor) {
  return typeof valor === 'string' ? valor.replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, '?') : valor;
}

const ATRIBUTOS_URL = ['http.target', 'url.path', 'http.route'];
const ATRIBUTOS_FUERA = ['url.query', 'http.url', 'url.full', 'http.user_agent.original', 'user_agent.original', 'enduser.id'];

/** Limpia una traza ya terminada. Se exporta para las pruebas. */
function limpiarSpan(span) {
  const a = span.attributes || {};
  for (const k of ATRIBUTOS_URL) if (k in a) a[k] = sinQuery(a[k]);
  // Con la plantilla de la ruta ya no hace falta la ruta real, que trae el id del paciente
  if (a['http.route']) for (const k of ['http.target', 'url.path']) if (k in a) a[k] = a['http.route'];
  for (const k of ATRIBUTOS_FUERA) delete a[k];
  if ('db.statement' in a) a['db.statement'] = sinTextosCitados(a['db.statement']);
  if ('db.query.text' in a) a['db.query.text'] = sinTextosCitados(a['db.query.text']);
  for (const ev of span.events || []) {
    const ea = ev.attributes || {};
    if ('exception.message' in ea) ea['exception.message'] = sinTextosCitados(ea['exception.message']);
    if ('exception.stacktrace' in ea) ea['exception.stacktrace'] = sinTextosCitados(String(ea['exception.stacktrace']).split('\n').slice(0, 8).join('\n'));
  }
  if (span.status && span.status.message) span.status.message = sinTextosCitados(span.status.message);
  return span;
}

/** 'okhttp/4.12.0' → 'app-android'; navegadores → 'web'; k6 (aunque diga okhttp) → 'k6'; lo demás → 'otro' */
function familiaCliente(userAgent = '') {
  const ua = String(userAgent).toLowerCase();
  if (ua.includes('k6')) return 'k6'; // va primero: la prueba de carga se presenta como okhttp + k6
  if (ua.startsWith('okhttp')) return 'app-android';
  if (ua.includes('mozilla')) return 'web';
  return 'otro';
}

function iniciar() {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
  const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
  const { resourceFromAttributes } = require('@opentelemetry/resources');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
  const { MySQL2Instrumentation } = require('@opentelemetry/instrumentation-mysql2');

  // Exportador que limpia cada traza justo antes de mandarla
  const otlp = new OTLPTraceExporter();
  const exportador = {
    export: (spans, listo) => {
      try {
        otlp.export(spans.map(limpiarSpan), listo);
      } catch (e) {
        // Si algo falla al limpiar o exportar, se pierde ese lote, nunca la API
        listo({ code: 1, error: e });
      }
    },
    shutdown: () => otlp.shutdown(),
    forceFlush: () => (otlp.forceFlush ? otlp.forceFlush() : Promise.resolve()),
  };

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME || 'healthnexus-api',
      'service.namespace': 'healthnexus',
      // Versión = commit desplegado (scripts/desplegar.sh lo pasa como TAG); sirve para comparar antes y después de un despliegue
      'service.version': process.env.OTEL_SERVICE_VERSION || require('../package.json').version,
      // Contenedor que respondió (su hostname es el id corto del contenedor, no trae datos de nadie)
      'service.instance.id': require('node:os').hostname(),
      'deployment.environment.name': process.env.OTEL_AMBIENTE || process.env.NODE_ENV || 'development',
    }),
    spanProcessors: [new BatchSpanProcessor({ exporter: exportador })],
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL || 30000),
    }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => RUTAS_IGNORADAS.some((r) => r.test(req.url || '')),
        // La API solo llama hacia fuera a Firebase y al SMTP; no se trazan
        ignoreOutgoingRequestHook: () => true,
        // El cliente sí sirve para separar tráfico (app, web, k6); se guarda solo la familia, no el user-agent
        requestHook: (span, req) => {
          if (req && req.headers) span.setAttribute('cliente', familiaCliente(req.headers['user-agent']));
        },
        redactedQueryParamsServer: [],
      }),
      new ExpressInstrumentation({ ignoreLayersType: ['middleware'] }),
      new MySQL2Instrumentation({ maskStatement: true }),
    ],
  });

  sdk.start();
  const cerrar = () => sdk.shutdown().catch(() => {}).finally(() => process.exit(0));
  process.once('SIGTERM', cerrar);
  process.once('SIGINT', cerrar);
  console.log(`Telemetría activa → ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
}

if (ACTIVA) {
  try {
    iniciar();
  } catch (e) {
    // La telemetría nunca debe tirar la API
    console.warn(`AVISO: telemetría desactivada (${e.message})`);
  }
}

module.exports = { limpiarSpan, sinQuery, sinTextosCitados, familiaCliente, ACTIVA };
