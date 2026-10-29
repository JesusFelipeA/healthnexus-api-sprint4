-- Notificaciones push: token de Firebase Cloud Messaging por dispositivo.
-- Se puede ejecutar más de una vez: si las columnas ya existen (por ejemplo, porque se corrió
-- la migración de Laravel 2026_10_28_000000_add_fcm_token_to_dispositivos_table.php) no hace nada.
--   RDS:            mysql -h <RDS> -u admin -p healthnexusdb < database/push.sql
--   Docker local:   se aplica solo al crear la base (04-push.sql en docker-compose.yml)
SET @hay := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dispositivos' AND COLUMN_NAME = 'fcm_token');
SET @sql := IF(@hay = 0,
  'ALTER TABLE dispositivos
     ADD COLUMN fcm_token VARCHAR(512) NULL AFTER huella,
     ADD COLUMN fcm_actualizado DATETIME NULL AFTER fcm_token,
     ADD INDEX dispositivos_fcm_token_index (fcm_token(191))',
  'SELECT ''fcm_token ya existe'' AS aviso');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
