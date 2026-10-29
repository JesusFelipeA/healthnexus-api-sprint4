// Revisión de las variables de entorno al arrancar.
//  - En cualquier ambiente: JWT_SECRET es obligatorio.
//  - En producción (NODE_ENV=production, lo pone la imagen de Docker): la API NO arranca con un
//    JWT_SECRET corto o de ejemplo, ni sin contraseña de base de datos. Lo demás son avisos.
// Nunca imprime valores, solo nombres de variables.
//   Revisar sin arrancar:  node src/entorno.js   (dentro del contenedor: docker compose ... run --rm api node src/entorno.js)

const EJEMPLO = /cambia|cambiame|ejemplo|desarrollo|development|secreto-de-pruebas|changeme|example/i;

function revisarEntorno(env = process.env) {
  const errores = [];
  const avisos = [];
  const prod = env.NODE_ENV === 'production';
  const jwt = String(env.JWT_SECRET || '');

  if (!jwt) errores.push('Falta JWT_SECRET.');
  else if (prod && jwt.length < 32) errores.push('JWT_SECRET es demasiado corto para producción (mínimo 32 caracteres). Genera uno con: openssl rand -hex 32');
  else if (prod && EJEMPLO.test(jwt)) errores.push('JWT_SECRET tiene un valor de ejemplo o de desarrollo. Genera uno con: openssl rand -hex 32');

  if (prod) {
    for (const v of ['DB_HOST', 'DB_NAME', 'DB_USER']) if (!env[v]) errores.push(`Falta ${v}.`);
    if (!env.DB_PASS) errores.push('Falta DB_PASS: en producción la base debe tener contraseña.');
    else if (EJEMPLO.test(env.DB_PASS)) errores.push('DB_PASS tiene un valor de ejemplo.');
    if (['root', 'admin'].includes(String(env.DB_USER || '').toLowerCase())) {
      avisos.push(`DB_USER es "${env.DB_USER}": usa un usuario solo para la API (database/usuario-api.sql).`);
    }
    if (String(env.TRUST_PROXY || '0') === '0') avisos.push('TRUST_PROXY=0 detrás de Nginx: todos los usuarios compartirán la IP del proxy. Usa TRUST_PROXY=1.');
    if (!env.FIREBASE_CREDENTIALS_FILE && !env.FIREBASE_CREDENTIALS_BASE64) avisos.push('Sin FIREBASE_CREDENTIALS_FILE ni FIREBASE_CREDENTIALS_BASE64: las notificaciones push están desactivadas.');
    if (!env.CORS_ORIGINS) avisos.push('CORS_ORIGINS está vacío: ningún navegador podrá llamar a la API (la app móvil no se ve afectada).');
  }
  return { errores, avisos, ambiente: prod ? 'producción' : (env.NODE_ENV || 'desarrollo') };
}

module.exports = { revisarEntorno };

if (require.main === module) {
  require('dotenv').config();
  const { errores, avisos, ambiente } = revisarEntorno();
  console.log(`Ambiente: ${ambiente}`);
  avisos.forEach((a) => console.log(`  ⚠ ${a}`));
  errores.forEach((e) => console.log(`  ✖ ${e}`));
  console.log(errores.length ? `${errores.length} problema(s): la API no arrancaría.` : '  ✔ Variables listas.');
  process.exit(errores.length ? 1 : 0);
}
