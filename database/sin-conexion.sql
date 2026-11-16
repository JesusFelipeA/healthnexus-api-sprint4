-- Modo sin conexión (fase 1: signos vitales). Columnas para sincronizar sin duplicar.
-- Equivale a la migración de Laravel 2026_11_13_000000_add_sincronizacion_to_signos_vitales_table.php:
-- si esa migración ya se corrió, este script no hace nada. Se puede ejecutar más de una vez.
--   EC2/RDS:        mysql -h <host> -u admin -p healthnexusdb < database/sin-conexion.sql
--   Docker local:   se aplica solo al crear la base (06-sin-conexion.sql en docker-compose.yml)
--   client_uuid   identificador que genera el teléfono o el navegador; si el mismo registro llega dos veces, no se duplica
--   capturado_en  hora real de la toma (hora local de México, como el resto de las columnas que lee Laravel)
--   sin_conexion  1 si se capturó sin conexión y se envió después
SET @hay := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signos_vitales' AND COLUMN_NAME = 'client_uuid');
SET @sql := IF(@hay = 0,
  'ALTER TABLE signos_vitales
     ADD COLUMN client_uuid CHAR(36) NULL AFTER user_id,
     ADD COLUMN capturado_en DATETIME NULL AFTER notas,
     ADD COLUMN sin_conexion TINYINT(1) NOT NULL DEFAULT 0 AFTER capturado_en,
     ADD UNIQUE INDEX signos_vitales_client_uuid_unique (client_uuid)',
  'SELECT ''signos_vitales ya tiene las columnas de sincronización'' AS aviso');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
