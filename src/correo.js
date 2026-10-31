// Envío de correos de la API (por ahora: el código para recuperar la contraseña).
// Se configura con variables de entorno:
//   SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (0 = STARTTLS en 587, 1 = TLS directo en 465),
//   SMTP_USER, SMTP_PASS, MAIL_FROM ("HealthNexus <no-responder@tu-dominio>")
// Sin SMTP_HOST:
//   - en desarrollo y pruebas el código se imprime en la consola de la API (para probar sin servidor de correo);
//   - en producción NO se imprime nunca: el correo simplemente no sale y se avisa al arrancar (src/entorno.js).
const nodemailer = require('nodemailer');

let transporte = null;
let enviarPersonalizado = null; // solo para pruebas: _usarEnvio(fn)

function configurado(env = process.env) {
  return Boolean(env.SMTP_HOST);
}

function obtenerTransporte() {
  if (transporte) return transporte;
  const puerto = Number(process.env.SMTP_PORT || 587);
  transporte = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: puerto,
    secure: String(process.env.SMTP_SECURE || (puerto === 465 ? '1' : '0')) === '1',
    requireTLS: puerto === 587,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  return transporte;
}

// Escapa el nombre del usuario antes de meterlo al HTML del correo
const html = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function mensajeCodigo({ nombre, codigo, minutos }) {
  const saludo = nombre ? `Hola, ${nombre}:` : 'Hola:';
  const text = [
    saludo,
    '',
    `Tu código para crear una contraseña nueva en HealthNexus es: ${codigo}`,
    `Vence en ${minutos} minutos y solo sirve una vez.`,
    '',
    'Si no lo pediste tú, ignora este correo: tu contraseña no cambia. Si recibes varios sin haberlos pedido, avisa a Sistemas.',
    '',
    'Nunca te pediremos este código por teléfono ni por chat.',
  ].join('\n');
  const htmlBody = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#111A3A">
    <p style="font-size:15px">${html(saludo)}</p>
    <p style="font-size:15px">Tu código para crear una contraseña nueva en <strong>HealthNexus</strong> es:</p>
    <p style="font-size:32px;font-weight:700;letter-spacing:8px;background:#EFEBFF;color:#3B1FA8;border-radius:12px;padding:16px;text-align:center;margin:16px 0">${html(codigo)}</p>
    <p style="font-size:14px;color:#4B5672">Vence en ${Number(minutos)} minutos y solo sirve una vez.</p>
    <p style="font-size:13px;color:#4B5672">Si no lo pediste tú, ignora este correo: tu contraseña no cambia.
      Nunca te pediremos este código por teléfono ni por chat.</p>
  </div>`;
  return { subject: `${codigo} es tu código de HealthNexus`, text, html: htmlBody };
}

// Envía el código. Nunca lanza: devuelve true/false y deja el motivo en la consola (sin el código).
async function enviarCodigoRecuperacion({ para, nombre, codigo, minutos = 15 }) {
  const msg = mensajeCodigo({ nombre, codigo, minutos });
  try {
    if (enviarPersonalizado) {
      await enviarPersonalizado({ to: para, ...msg });
      return true;
    }
    if (!configurado()) {
      if (process.env.NODE_ENV === 'production') {
        console.error('Recuperación de contraseña: falta SMTP_HOST, el correo no se envió.');
        return false;
      }
      console.log(`[correo de desarrollo] Código de recuperación para ${para}: ${codigo} (vence en ${minutos} min)`);
      return true;
    }
    await obtenerTransporte().sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: para, ...msg });
    return true;
  } catch (e) {
    console.error('No se pudo enviar el correo de recuperación:', e.message);
    return false;
  }
}

module.exports = {
  enviarCodigoRecuperacion,
  configurado,
  mensajeCodigo,
  _usarEnvio: (fn) => { enviarPersonalizado = fn; },
};
