require('dotenv').config();
const app = require('./app');
const pool = require('./db');

const { revisarEntorno } = require('./entorno');

// La API no arranca con secretos faltantes o de ejemplo en producción (ver src/entorno.js)
const { errores, avisos } = revisarEntorno();
avisos.forEach((a) => console.warn(`AVISO: ${a}`));
if (errores.length) {
  errores.forEach((e) => console.error(`ERROR: ${e}`));
  process.exit(1);
}

const port = Number(process.env.PORT || 3000);
pool.query('SELECT 1')
  .then(() => app.listen(port, () => console.log(`HealthNexus API en http://localhost:${port}`)))
  .catch((e) => { console.error('No se pudo conectar a MySQL:', e.message); process.exit(1); });
