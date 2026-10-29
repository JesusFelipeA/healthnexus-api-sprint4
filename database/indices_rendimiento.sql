-- Plan de pruebas CP-38: respuestas de la API en menos de 3 segundos, también con muchos registros.
-- Se puede ejecutar más de una vez: cada índice solo se crea si todavía no existe.
--   mysql -u root -p healthnexusdb < database/indices_rendimiento.sql
-- El esquema pertenece a las migraciones de Laravel: si el equipo web prefiere, estos mismos índices
-- pueden pasar a una migración "add_performance_indexes" en el repositorio de la plataforma.

SET @sql := IF((SELECT COUNT(*) FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admisiones' AND INDEX_NAME = 'hn_admisiones_paciente_estado_idx') = 0,
  'ALTER TABLE admisiones ADD INDEX hn_admisiones_paciente_estado_idx (paciente_id, estado)',
  'SELECT ''hn_admisiones_paciente_estado_idx ya existe'' AS aviso');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF((SELECT COUNT(*) FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pacientes' AND INDEX_NAME = 'hn_pacientes_activo_idx') = 0,
  'ALTER TABLE pacientes ADD INDEX hn_pacientes_activo_idx (activo, id)',
  'SELECT ''hn_pacientes_activo_idx ya existe'' AS aviso');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF((SELECT COUNT(*) FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lotes' AND INDEX_NAME = 'hn_lotes_med_activo_cad_idx') = 0,
  'ALTER TABLE lotes ADD INDEX hn_lotes_med_activo_cad_idx (medicamento_id, activo, fecha_caducidad)',
  'SELECT ''hn_lotes_med_activo_cad_idx ya existe'' AS aviso');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF((SELECT COUNT(*) FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'movimientos_inventario' AND INDEX_NAME = 'hn_movimientos_creado_idx') = 0,
  'ALTER TABLE movimientos_inventario ADD INDEX hn_movimientos_creado_idx (created_at)',
  'SELECT ''hn_movimientos_creado_idx ya existe'' AS aviso');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF((SELECT COUNT(*) FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND INDEX_NAME = 'hn_audit_creado_idx') = 0,
  'ALTER TABLE audit_logs ADD INDEX hn_audit_creado_idx (created_at)',
  'SELECT ''hn_audit_creado_idx ya existe'' AS aviso');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF((SELECT COUNT(*) FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cama_paciente' AND INDEX_NAME = 'hn_cama_paciente_activa_idx') = 0,
  'ALTER TABLE cama_paciente ADD INDEX hn_cama_paciente_activa_idx (paciente_id, activa)',
  'SELECT ''hn_cama_paciente_activa_idx ya existe'' AS aviso');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
