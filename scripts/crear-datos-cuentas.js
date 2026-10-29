// Carga cuentas, cargos y pagos de PRUEBA (HU-76) para desarrollar la app sin tocar datos reales.
// Usa los primeros pacientes que existan y crea 4 escenarios; se puede ejecutar varias veces (no duplica).
//   docker compose exec api node scripts/crear-datos-cuentas.js
// Protegido: se niega a correr con NODE_ENV=production (para forzarlo: FORZAR=1, solo si sabes lo que haces).
require('dotenv').config();
const pool = require('../src/db');

if (process.env.NODE_ENV === 'production' && process.env.FORZAR !== '1') {
  console.error('Este script carga datos de prueba y no debe correr en producción.'); process.exit(1);
}

const r2 = (n) => Math.round(n * 100) / 100;
// [folio, estado, cargos [concepto, cantidad, precio], descuento global, pagos [folio, monto, metodo, referencia, estado]]
const ESCENARIOS = [
  ['CTA-QA-001', 'abierta', [['Consulta general', 1, 650], ['Laboratorio: biometría hemática', 1, 280]], 0, []],
  ['CTA-QA-002', 'abierta', [['Consulta de especialidad', 1, 900], ['Rayos X de tórax', 1, 750]], 0,
    [['PAG-QA-001', 800, 'efectivo', null, 'aplicado']]],
  ['CTA-QA-003', 'cerrada', [['Hospitalización (2 días)', 2, 1800], ['Medicamentos', 1, 420.5]], 200,
    [['PAG-QA-002', 2000, 'tarjeta', '**** 4242', 'aplicado'], ['PAG-QA-003', 1820.5, 'transferencia', 'SPEI-889021', 'aplicado']]],
  ['CTA-QA-004', 'abierta', [['Urgencias', 1, 1200], ['Curación y suturas', 1, 350]], 100,
    [['PAG-QA-004', 500, 'efectivo', null, 'cancelado'], ['PAG-QA-005', 600, 'tarjeta', '**** 1111', 'aplicado']]],
];

(async () => {
  const [pacientes] = await pool.query('SELECT id FROM pacientes WHERE activo = 1 ORDER BY id LIMIT ?', [ESCENARIOS.length]);
  if (!pacientes.length) { console.log('No hay pacientes; registra al menos uno y vuelve a correr el script.'); await pool.end(); return; }
  const [[adm]] = await pool.query(
    `SELECT u.id FROM users u JOIN model_has_roles mr ON mr.model_id = u.id JOIN roles r ON r.id = mr.role_id
     WHERE r.name = 'administrador' ORDER BY u.id LIMIT 1`);
  const cobrador = adm ? adm.id : null;

  for (let i = 0; i < ESCENARIOS.length; i++) {
    const [folio, estado, cargos, descuento, pagos] = ESCENARIOS[i];
    const pac = pacientes[i % pacientes.length].id;
    const [[ya]] = await pool.query('SELECT id FROM cuentas WHERE folio = ?', [folio]);
    if (ya) { console.log(`Ya existía ${folio}`); continue; }

    const subtotal = r2(cargos.reduce((s, [, c, p]) => s + c * p, 0));
    const total = r2(subtotal - descuento);
    const pagado = r2(pagos.filter((p) => p[4] === 'aplicado').reduce((s, p) => s + p[1], 0));
    const saldo = r2(Math.max(total - pagado, 0));

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [c] = await conn.query(
        `INSERT INTO cuentas (paciente_id, folio, estado, subtotal, descuento_global, motivo_descuento, total, pagado, saldo, cerrada_en, notas, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
        [pac, folio, estado, subtotal, descuento, descuento ? 'Descuento de prueba' : null, total, pagado, saldo, estado === 'cerrada' ? new Date() : null, 'Datos de prueba (QA)']);
      for (const [concepto, cantidad, precio] of cargos) {
        await conn.query(
          `INSERT INTO cuenta_items (cuenta_id, concepto, cantidad, precio_unitario, descuento, importe, created_at, updated_at)
           VALUES (?,?,?,?,0,?,NOW(),NOW())`, [c.insertId, concepto, cantidad, precio, r2(cantidad * precio)]);
      }
      for (const [pf, monto, metodo, ref, est] of pagos) {
        await conn.query(
          `INSERT INTO pagos (cuenta_id, user_id, folio, monto, metodo, referencia, estado, motivo_cancelacion, cancelado_en, cancelado_por, pagado_en, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,NOW(),NOW(),NOW())`,
          [c.insertId, cobrador, pf, monto, metodo, ref, est, est === 'cancelado' ? 'Error de captura (prueba)' : null,
            est === 'cancelado' ? new Date() : null, est === 'cancelado' ? cobrador : null]);
      }
      await conn.commit();
      console.log(`Creada ${folio} (${estado}) total $${total} pagado $${pagado} saldo $${saldo}`);
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
  console.log('Listo. Entra con un usuario administrador para ver las cuentas.');
  await pool.end();
})().catch((e) => { console.error('Error:', e.message); process.exit(1); });
