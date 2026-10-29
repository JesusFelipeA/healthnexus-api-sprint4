// Genera el recibo de pago en PDF (pdfkit, sin navegador). Devuelve un Buffer.
// El diseño replica el recibo de la aplicación web (Laravel): encabezado centrado con folio y estado,
// aviso de cancelación, datos del pago, monto recibido, resumen de la cuenta, firmas y pie de página.
const PDFDocument = require('pdfkit');

const dinero = (v) => Math.round((Number(v) || 0) * 100) / 100;
// Igual que number_format($x, 2) de PHP: $1,234.50
const mxn = (v) => '$' + dinero(v).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ZONA = 'America/Mexico_City';
const aDate = (valor) => new Date(String(valor).replace(' ', 'T') + 'Z');

// Las fechas de MySQL llegan como 'YYYY-MM-DD HH:MM:SS' en UTC: se muestran en hora de México.
function fechaMx(valor) {
  if (!valor) return '—';
  const d = aDate(valor);
  if (Number.isNaN(d.getTime())) return String(valor);
  return d.toLocaleString('es-MX', { timeZone: ZONA, dateStyle: 'medium', timeStyle: 'short' });
}

// dd/mm/aaaa HH:mm (como el recibo web)
function fechaCorta(valor) {
  if (!valor) return '—';
  const d = valor instanceof Date ? valor : aDate(valor);
  if (Number.isNaN(d.getTime())) return String(valor);
  return d.toLocaleString('es-MX', {
    timeZone: ZONA, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).replace(/,\s*/, ' ');
}

const METODOS = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', otro: 'Otro' };
const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '—');

const C = {
  tinta: '#1e293b', gris: '#666666', linea: '#e2e8f0', pie: '#94a3b8',
  okFondo: '#d1fae5', okTexto: '#065f46', malFondo: '#fee2e2', malTexto: '#991b1b', rojo: '#dc2626', verde: '#059669',
};

function generarRecibo({ pago, cuenta, paciente, cobradoPor, canceladoPor }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Recibo ${pago.folio}`, Author: 'HealthNexus' } });
    const partes = [];
    doc.on('data', (c) => partes.push(c));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);

    const x0 = 40;
    const W = doc.page.width - 80;
    const cancelado = pago.estado === 'cancelado';
    const registrador = cobradoPor || '—';
    let y = 40;

    const texto = (t, x, yy, opts = {}) => doc.text(String(t), x, yy, { lineBreak: false, ...opts });

    // ============ ENCABEZADO ============
    doc.font('Helvetica-Bold').fontSize(20).fillColor(C.tinta);
    texto('HealthNexus', x0, y, { width: W, align: 'center', lineBreak: false });
    y += 28;
    doc.font('Helvetica').fontSize(10).fillColor(C.gris);
    texto('Recibo de pago', x0, y, { width: W, align: 'center' });
    y += 16;
    doc.font('Courier-Bold').fontSize(13).fillColor(C.tinta);
    texto(pago.folio, x0, y, { width: W, align: 'center' });
    y += 22;

    // Etiqueta de estado
    const etiqueta = cancelado ? 'CANCELADO' : 'APLICADO';
    doc.font('Helvetica-Bold').fontSize(8);
    const wBadge = doc.widthOfString(etiqueta, { characterSpacing: 0.5 }) + 24;
    const xBadge = x0 + (W - wBadge) / 2;
    doc.roundedRect(xBadge, y, wBadge, 16, 8).fill(cancelado ? C.malFondo : C.okFondo);
    doc.fillColor(cancelado ? C.malTexto : C.okTexto);
    texto(etiqueta, xBadge, y + 4.5, { width: wBadge, align: 'center', characterSpacing: 0.5 });
    y += 28;
    doc.moveTo(x0, y).lineTo(x0 + W, y).lineWidth(2).strokeColor(C.tinta).stroke();
    y += 20;

    // ============ AVISO SI ESTÁ CANCELADO ============
    if (cancelado) {
      const lineas = [];
      if (pago.cancelado_en) {
        lineas.push(`Cancelado el ${fechaCorta(pago.cancelado_en)}${canceladoPor ? ` por ${canceladoPor}` : ''}`);
      }
      doc.font('Helvetica').fontSize(8.5);
      const hMotivo = pago.motivo_cancelacion
        ? doc.heightOfString(`Motivo: ${pago.motivo_cancelacion}`, { width: W - 40 }) : 0;
      const alto = 18 + 16 + (lineas.length ? 14 : 0) + (hMotivo ? hMotivo + 4 : 0) + 6;
      doc.rect(x0, y, W, alto).fill('#fef2f2');
      doc.rect(x0, y, 4, alto).fill(C.rojo);
      let yy = y + 12;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(C.malTexto);
      texto('*** ESTE PAGO HA SIDO CANCELADO ***', x0, yy, { width: W, align: 'center', characterSpacing: 1 });
      yy += 18;
      doc.font('Helvetica').fontSize(8.5);
      for (const l of lineas) { texto(l, x0, yy, { width: W, align: 'center' }); yy += 14; }
      if (pago.motivo_cancelacion) {
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(C.malTexto);
        doc.text(`Motivo: ${pago.motivo_cancelacion}`, x0 + 20, yy, { width: W - 40, align: 'center' });
      }
      y += alto + 20;
    }

    // ============ SECCIÓN ============
    const seccion = (titulo) => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(C.tinta);
      texto(titulo.toUpperCase(), x0, y, { characterSpacing: 0.5 });
      y += 14;
      doc.moveTo(x0, y).lineTo(x0 + W, y).lineWidth(0.8).strokeColor(C.linea).stroke();
      y += 8;
    };

    // ============ INFORMACIÓN DEL PAGO ============
    seccion('Información del pago');
    const fila = (etiq, valor) => {
      const wEt = W * 0.35;
      doc.font('Helvetica-Bold').fontSize(9.5);
      const h = Math.max(14, doc.heightOfString(String(valor ?? '—'), { width: W - wEt - 16 }) + 4);
      doc.font('Helvetica').fillColor(C.gris);
      texto(etiq, x0 + 8, y, { width: wEt - 8 });
      doc.font('Helvetica-Bold').fillColor(C.tinta);
      doc.text(String(valor ?? '—'), x0 + 8 + wEt, y, { width: W - wEt - 16 });
      y += h;
    };
    fila('Paciente:', paciente.nombre);
    fila('Cuenta:', cuenta.folio);
    fila('Fecha del pago:', fechaCorta(pago.pagado_en));
    fila('Método:', METODOS[pago.metodo] || cap(pago.metodo));
    if (pago.referencia) fila('Referencia:', pago.referencia);
    fila('Registrado por:', registrador);
    y += 14;

    // ============ MONTO RECIBIDO ============
    doc.roundedRect(x0 + 1, y + 1, W - 2, 76, 6).lineWidth(2).fillAndStroke('#f0fdf4', '#10b981');
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.okTexto);
    texto('MONTO RECIBIDO', x0, y + 14, { width: W, align: 'center', characterSpacing: 1 });
    doc.fontSize(30);
    texto(mxn(pago.monto), x0, y + 32, { width: W, align: 'center' });
    y += 76 + 26;

    // ============ RESUMEN DE LA CUENTA ============
    seccion('Resumen de la cuenta');
    const saldo = dinero(cuenta.saldo);
    const filasCuenta = [
      ['Total de la cuenta:', mxn(cuenta.total), C.tinta],
      ['Total pagado (incluyendo este pago):', mxn(cuenta.pagado), C.verde],
      ['Saldo pendiente:', mxn(saldo), saldo > 0 ? C.rojo : C.verde],
      ['Estado de la cuenta:', cap(cuenta.estado), C.tinta],
    ];
    const altoCuenta = filasCuenta.length * 17 + 24;
    doc.rect(x0, y, W, altoCuenta).fill('#f8fafc');
    doc.rect(x0, y, 4, altoCuenta).fill(C.tinta);
    let yc = y + 12;
    for (const [et, val, color] of filasCuenta) {
      doc.font('Helvetica').fontSize(9.5).fillColor('#333333');
      texto(et, x0 + 18, yc, { width: W * 0.6 });
      doc.font('Helvetica-Bold').fillColor(color);
      texto(val, x0 + 18, yc, { width: W - 36, align: 'right' });
      yc += 17;
    }
    y += altoCuenta + 10;

    // ============ FIRMAS (solo pagos aplicados) ============
    if (!cancelado) {
      y += 50;
      const col = W / 2;
      [['Firma del paciente', paciente.nombre], ['Recibió', registrador]].forEach(([et, nombre], i) => {
        const xc = x0 + i * col + 20;
        const wc = col - 40;
        doc.moveTo(xc, y).lineTo(xc + wc, y).lineWidth(0.8).strokeColor(C.pie).stroke();
        doc.font('Helvetica').fontSize(8.5).fillColor(C.gris);
        texto(et, xc, y + 6, { width: wc, align: 'center' });
        doc.text(String(nombre ?? '—'), xc, y + 18, { width: wc, align: 'center' });
      });
      y += 54;
    }

    // ============ PIE ============
    y += 30;
    doc.moveTo(x0, y).lineTo(x0 + W, y).lineWidth(0.8).strokeColor(C.linea).stroke();
    y += 10;
    const ahora = fechaCorta(new Date()).replace(' ', ' a las ');
    doc.font('Helvetica').fontSize(8).fillColor(C.pie);
    texto(`Documento generado el ${ahora}.`, x0, y, { width: W, align: 'center' });
    y += 12;
    texto('Este recibo es un comprobante interno de HealthNexus. Conserve este documento para cualquier aclaración.',
      x0, y, { width: W, align: 'center' });
    doc.end();
  });
}

module.exports = { generarRecibo, dinero, fechaMx, fechaCorta };
