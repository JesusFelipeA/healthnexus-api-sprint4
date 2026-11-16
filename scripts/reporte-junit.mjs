// Reporter JUnit para node:test.
// El reporter "junit" que trae Node pone todas las pruebas con classname="test";
// este agrupa un <testsuite> por archivo (api, pin, recetas, ...), que es como lo
// muestran Jenkins, GitHub Actions y los visores de JUnit.
//
// Uso: node --test --test-reporter=./scripts/reporte-junit.mjs \
//        --test-reporter-destination=reports/junit-api.xml test/*.test.js
import path from 'node:path';

const xml = (s) =>
  String(s ?? '')
    // Caracteres de control que XML 1.0 no admite (colores ANSI, etc.).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const suiteDe = (file) => (file ? path.basename(file).replace(/\.test\.[cm]?js$/, '') : 'pruebas');

export default async function* reporteJunit(source) {
  const suites = new Map();
  const casoEn = (file) => {
    const nombre = suiteDe(file);
    if (!suites.has(nombre)) suites.set(nombre, { nombre, file, casos: [] });
    return suites.get(nombre);
  };

  for await (const { type, data } of source) {
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    // Solo las pruebas sueltas (nivel 0); si un archivo usa describe(), sus pruebas
    // internas se reportan con el nombre del bloque como prefijo.
    if (data.details?.type === 'suite') continue;
    const segundos = (data.details?.duration_ms ?? 0) / 1000;
    const caso = { nombre: data.name, segundos, skip: data.skip ?? data.todo };
    if (type === 'test:fail') {
      const err = data.details?.error;
      const causa = err?.cause ?? err;
      caso.fallo = {
        mensaje: causa?.message ?? String(causa ?? 'Falló'),
        detalle: causa?.stack ?? String(causa ?? ''),
      };
    }
    casoEn(data.file).casos.push(caso);
  }

  let total = 0;
  let fallos = 0;
  let omitidas = 0;
  let tiempo = 0;
  const bloques = [];
  for (const s of [...suites.values()].sort((a, b) => a.nombre.localeCompare(b.nombre))) {
    const f = s.casos.filter((c) => c.fallo).length;
    const o = s.casos.filter((c) => c.skip).length;
    const t = s.casos.reduce((n, c) => n + c.segundos, 0);
    total += s.casos.length;
    fallos += f;
    omitidas += o;
    tiempo += t;
    const casos = s.casos
      .map((c) => {
        const abre = `    <testcase classname="api.${xml(s.nombre)}" name="${xml(c.nombre)}" time="${c.segundos.toFixed(3)}"`;
        if (c.fallo) {
          return `${abre}>\n      <failure message="${xml(c.fallo.mensaje)}">${xml(c.fallo.detalle)}</failure>\n    </testcase>`;
        }
        if (c.skip) return `${abre}>\n      <skipped/>\n    </testcase>`;
        return `${abre}/>`;
      })
      .join('\n');
    bloques.push(
      `  <testsuite name="${xml(s.nombre)}" file="${xml(s.file ? path.relative(process.cwd(), s.file) : '')}" tests="${s.casos.length}" failures="${f}" errors="0" skipped="${o}" time="${t.toFixed(3)}">\n${casos}\n  </testsuite>`,
    );
  }

  yield '<?xml version="1.0" encoding="UTF-8"?>\n';
  yield `<testsuites name="HealthNexus API" tests="${total}" failures="${fallos}" errors="0" skipped="${omitidas}" time="${tiempo.toFixed(3)}">\n`;
  yield `${bloques.join('\n')}\n`;
  yield '</testsuites>\n';
}
