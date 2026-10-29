// Cuentas, pagos y recibos (HU-73, HU-75). Solo lectura y solo para el administrador:
// `roles()` sin argumentos deja pasar únicamente a 'administrador'.
const router = require('express').Router();
const pool = require('../db');
const { ah, HttpError, auth, roles, audit, paginar, idValido } = require('../middleware');
const { generarRecibo, dinero } = require('../recibo');

const ESTADOS = ['abierta', 'cerrada', 'cancelada'];
const NOMBRE_PACIENTE = "TRIM(CONCAT_WS(' ', p.nombre, p.apellido_paterno, p.apellido_materno))";

const formatoCuenta = (c) => ({
  id: c.id, folio: c.folio, estado: c.estado,
  subtotal: dinero(c.subtotal), descuento: dinero(c.descuento_global), motivoDescuento: c.motivo_descuento || null,
  total: dinero(c.total), pagado: dinero(c.pagado), saldo: dinero(c.saldo),
  cerradaEn: c.cerrada_en || null, notas: c.notas || null, creada: c.created_at || null,
});

// GET /api/cuentas?q=&estado=abierta&con_saldo=1&paciente_id=&page=1&limit=20
router.get('/cuentas', auth, roles(), ah(async (req, res) => {
  const where = []; const params = [];
  if (req.query.estado !== undefined && req.query.estado !== '') {
    if (!ESTADOS.includes(req.query.estado)) throw new HttpError(400, 'Estado inválido: use abierta, cerrada o cancelada');
    where.push('c.estado = ?'); params.push(req.query.estado);
  }
  if (req.query.paciente_id !== undefined && req.query.paciente_id !== '') {
    const pid = idValido(req.query.paciente_id);
    if (!pid) throw new HttpError(400, 'paciente_id inválido');
    where.push('c.paciente_id = ?'); params.push(pid);
  }
  if (req.query.con_saldo === '1') where.push('c.saldo > 0');
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) {
    where.push(`(c.folio LIKE ? OR ${NOMBRE_PACIENTE} LIKE ? OR p.curp LIKE ?)`);
    const like = `%${q}%`; params.push(like, like, like);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { limit, page, offset } = paginar(req, { def: 20, max: 100 });
  const [[res0]] = await pool.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(c.saldo), 0) AS saldo_pendiente
     FROM cuentas c JOIN pacientes p ON p.id = c.paciente_id ${w}`, params);
  const [rows] = await pool.query(
    `SELECT c.*, ${NOMBRE_PACIENTE} AS paciente, p.curp
     FROM cuentas c JOIN pacientes p ON p.id = c.paciente_id ${w}
     ORDER BY c.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  res.json({
    total: res0.total, page, limit, saldoPendiente: dinero(res0.saldo_pendiente),
    data: rows.map((c) => ({ ...formatoCuenta(c), paciente: c.paciente, curp: c.curp || null })),
  });
}));

// GET /api/cuentas/:id  → cargos, pagos (incluye cancelados, marcados) y saldo
router.get('/cuentas/:id(\\d+)', auth, roles(), ah(async (req, res) => {
  const id = idValido(req.params.id);
  const [[c]] = await pool.query(
    `SELECT c.*, p.id AS pac_id, ${NOMBRE_PACIENTE} AS paciente, p.curp
     FROM cuentas c JOIN pacientes p ON p.id = c.paciente_id WHERE c.id = ?`, [id]);
  if (!c) throw new HttpError(404, 'Cuenta no encontrada');
  const [items] = await pool.query(
    `SELECT id, concepto, cantidad, precio_unitario, descuento, motivo_descuento, importe, notas, created_at
     FROM cuenta_items WHERE cuenta_id = ? ORDER BY id`, [id]);
  const [pagos] = await pool.query(
    `SELECT g.id, g.folio, g.monto, g.metodo, g.referencia, g.estado, g.motivo_cancelacion, g.cancelado_en, g.pagado_en, g.notas,
            u.name AS cobrado_por
     FROM pagos g LEFT JOIN users u ON u.id = g.user_id WHERE g.cuenta_id = ? ORDER BY g.pagado_en DESC, g.id DESC`, [id]);

  const cargos = items.map((i) => ({
    id: i.id, concepto: i.concepto, cantidad: i.cantidad, precioUnitario: dinero(i.precio_unitario),
    descuento: dinero(i.descuento), motivoDescuento: i.motivo_descuento || null, importe: dinero(i.importe), notas: i.notas || null,
  }));
  const listaPagos = pagos.map((g) => ({
    id: g.id, folio: g.folio, monto: dinero(g.monto), metodo: g.metodo, referencia: g.referencia || null,
    estado: g.estado, cancelado: g.estado === 'cancelado', motivoCancelacion: g.motivo_cancelacion || null,
    canceladoEn: g.cancelado_en || null, pagadoEn: g.pagado_en, cobradoPor: g.cobrado_por || null, notas: g.notas || null,
  }));

  // Revisión de consistencia: los pagos cancelados no cuentan y el saldo debe cuadrar con los cargos.
  const pagadoCalculado = dinero(listaPagos.filter((g) => !g.cancelado).reduce((s, g) => s + g.monto, 0));
  const saldoCalculado = dinero(Math.max(dinero(c.total) - pagadoCalculado, 0));
  // HU-73: cada consulta del estado de cuenta queda en la bitácora (sin montos ni datos del paciente)
  await audit(req, { evento: 'consulta_sensible', modulo: 'cuentas', descripcion: `Consulta del estado de cuenta ${c.folio}`, tipo: 'App\\Models\\Cuenta', id: c.id });
  res.json({
    ...formatoCuenta(c),
    paciente: { id: c.pac_id, nombre: c.paciente, curp: c.curp || null },
    cargos, pagos: listaPagos,
    verificacion: { pagadoCalculado, saldoCalculado, coincide: pagadoCalculado === dinero(c.pagado) && saldoCalculado === dinero(c.saldo) },
  });
}));

// GET /api/pagos/:id/recibo  → PDF (application/pdf). Queda registrado en auditoría.
router.get('/pagos/:id(\\d+)/recibo', auth, roles(), ah(async (req, res) => {
  const id = idValido(req.params.id);
  const [[g]] = await pool.query(
    `SELECT g.*, u.name AS cobrado_por,
            (SELECT name FROM users WHERE id = g.cancelado_por) AS cancelado_por_nombre
     FROM pagos g LEFT JOIN users u ON u.id = g.user_id WHERE g.id = ?`, [id]);
  if (!g) throw new HttpError(404, 'Pago no encontrado');
  const [[c]] = await pool.query('SELECT * FROM cuentas WHERE id = ?', [g.cuenta_id]);
  if (!c) throw new HttpError(404, 'Cuenta no encontrada');
  const [[p]] = await pool.query(
    `SELECT ${NOMBRE_PACIENTE} AS nombre, p.curp FROM pacientes p WHERE p.id = ?`, [c.paciente_id]);

  const pdf = await generarRecibo({ pago: g, cuenta: c, paciente: p || { nombre: '—' }, cobradoPor: g.cobrado_por, canceladoPor: g.cancelado_por_nombre });
  await audit(req, {
    evento: 'recibo_descargado', modulo: 'cuentas', descripcion: `Recibo ${g.folio} (${c.folio}) descargado`,
    tipo: 'pago', id: g.id, sensible: 1,
  });
  const nombre = String(g.folio).replace(/[^A-Za-z0-9_-]/g, '');
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Length': pdf.length,
    'Content-Disposition': `attachment; filename="recibo-${nombre}.pdf"`,
    'Cache-Control': 'no-store',
  });
  res.send(pdf);
}));

module.exports = router;
