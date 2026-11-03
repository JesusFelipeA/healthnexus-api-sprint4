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

// Hora local (México centro por defecto; se cambia con MAIL_TZ) a la que vence el código, ej. "15:52".
// Si el sistema no tiene datos de zonas horarias, se omite la hora y queda solo "en N minutos".
function horaVencimiento(ahora, minutos, zona = process.env.MAIL_TZ || 'America/Mexico_City') {
  try {
    const vence = new Date(ahora.getTime() + minutos * 60000);
    return new Intl.DateTimeFormat('es-MX', { timeZone: zona, hour: '2-digit', minute: '2-digit', hour12: false }).format(vence);
  } catch {
    return null;
  }
}

// Correo con el código. Se arma con tablas y estilos en línea porque así lo muestran bien Gmail, Outlook y
// los clientes del celular (no leen <style> ni flexbox). Lleva también versión de solo texto.
function mensajeCodigo({ nombre, codigo, minutos, ahora = new Date() }) {
  const min = Number(minutos);
  const saludo = nombre ? `Hola, ${nombre}:` : 'Hola:';
  const hora = horaVencimiento(ahora, min);
  const vence = hora ? `Vence en ${min} minutos (a las ${hora}, hora del centro de México) y solo sirve una vez.`
    : `Vence en ${min} minutos y solo sirve una vez.`;

  const text = [
    saludo,
    '',
    'Recibimos una solicitud para crear una contraseña nueva en tu cuenta de HealthNexus.',
    '',
    `Tu código es: ${codigo}`,
    '',
    vence,
    '',
    'Cómo usarlo:',
    '  1. Vuelve a la app HealthNexus, en la pantalla "Revisa tu correo".',
    '  2. Escribe el código de 6 dígitos.',
    '  3. Crea tu contraseña nueva.',
    '',
    '¿No fuiste tú? Ignora este correo: tu contraseña no cambia. Si recibes varios sin haberlos pedido, avisa al área de Sistemas.',
    'Nunca te pediremos este código por teléfono, chat ni correo.',
    '',
    '— HealthNexus · Tecnología que cuida vidas',
    'Este es un correo automático; no lo respondas.',
  ].join('\n');

  const fuente = 'Arial,Helvetica,sans-serif';
  const paso = (n, t) => `<tr>
              <td width="34" valign="top" style="padding:0 0 10px"><div style="width:26px;height:26px;border-radius:13px;background:#EFEBFF;color:#3B1FA8;font:700 13px/26px ${fuente};text-align:center">${n}</div></td>
              <td valign="top" style="padding:3px 0 10px;font:14px/20px ${fuente};color:#2A3352">${t}</td>
            </tr>`;
  const htmlBody = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Tu código de HealthNexus</title>
</head>
<body style="margin:0;padding:0;background:#F5F6FA">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#F5F6FA">Vence en ${min} minutos. No lo compartas con nadie.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F6FA">
    <tr><td align="center" style="padding:28px 12px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#FFFFFF;border:1px solid #E4E7EF;border-radius:16px">
        <tr><td style="background:#1B2160;border-radius:16px 16px 0 0;padding:22px 28px">
          <div style="font:800 24px ${fuente};letter-spacing:-0.5px;color:#FFFFFF">Health<span style="color:#B6A8FF">Nexus</span></div>
          <div style="font:13px ${fuente};color:#DCE1EF;margin-top:4px">Recuperación de contraseña</div>
        </td></tr>
        <tr><td style="padding:28px 28px 8px">
          <p style="margin:0 0 12px;font:15px/22px ${fuente};color:#111A3A">${html(saludo)}</p>
          <p style="margin:0 0 20px;font:15px/22px ${fuente};color:#111A3A">Recibimos una solicitud para crear una contraseña nueva en tu cuenta. Escribe este código en la app:</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td align="center" style="background:#EFEBFF;border:1px solid #D9D1FF;border-radius:12px;padding:18px 8px">
              <div style="font:700 36px 'Courier New',Courier,monospace;letter-spacing:10px;padding-left:10px;color:#3B1FA8">${html(codigo)}</div>
              <div style="font:12px ${fuente};color:#4B5672;margin-top:6px">Código de verificación</div>
            </td></tr>
          </table>
          <p style="margin:16px 0 22px;font:14px/20px ${fuente};color:#4B5672">${hora
    ? `Vence a las <strong style="color:#111A3A">${html(hora)}</strong> (hora del centro de México), en ${min} minutos, y solo sirve una vez.`
    : `Vence en <strong style="color:#111A3A">${min} minutos</strong> y solo sirve una vez.`}</p>
          <p style="margin:0 0 10px;font:700 14px ${fuente};color:#111A3A">Cómo usarlo</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            ${paso(1, 'Vuelve a la app HealthNexus, en la pantalla <strong>Revisa tu correo</strong>.')}
            ${paso(2, 'Escribe el código de 6 dígitos.')}
            ${paso(3, 'Crea tu contraseña nueva.')}
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 20px">
            <tr><td style="background:#FDECEC;border:1px solid #F3C4C4;border-radius:12px;padding:14px 16px;font:13px/19px ${fuente};color:#7A1515">
              <strong style="color:#A61B1B">¿No fuiste tú?</strong> Ignora este correo: tu contraseña no cambia. Si recibes varios sin haberlos pedido, avisa al área de Sistemas.<br>
              Nunca te pediremos este código por teléfono, chat ni correo.
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="border-top:1px solid #E4E7EF;padding:16px 28px 20px;font:12px/18px ${fuente};color:#5E6782">
          <strong style="color:#2A3352">HealthNexus</strong> · Tecnología que cuida vidas<br>
          Este es un correo automático; no lo respondas.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
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
