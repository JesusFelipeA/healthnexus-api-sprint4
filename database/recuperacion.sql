-- Recuperación de contraseña desde la app (código de 6 dígitos por correo) y cierre de sesiones.
-- Se puede ejecutar más de una vez (CREATE TABLE IF NOT EXISTS).
--   RDS:            mysql -h <RDS> -u admin -p healthnexusdb < database/recuperacion.sql
--   Docker local:   se aplica solo al crear la base (05-recuperacion.sql en docker-compose.yml)
-- La API nunca borra filas aquí (el usuario hn_api no tiene DELETE): los códigos se invalidan con usado_en.

-- Un código por solicitud. Solo se guarda el HASH (bcrypt) del código, nunca el código.
CREATE TABLE IF NOT EXISTS recuperacion_clave (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  codigo_hash VARCHAR(255)    NOT NULL,
  intentos    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expira_en   DATETIME        NOT NULL COMMENT 'UTC',
  usado_en    DATETIME        NULL     COMMENT 'UTC; también se llena al invalidar el código',
  ip          VARCHAR(45)     NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY recuperacion_clave_user_vigente (user_id, usado_en, expira_en),
  CONSTRAINT recuperacion_clave_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tokens de la app emitidos ANTES de desde_epoch dejan de servir (cambio de contraseña = cerrar sesiones).
CREATE TABLE IF NOT EXISTS sesiones_revocadas (
  user_id     BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  desde_epoch BIGINT UNSIGNED NOT NULL COMMENT 'segundos Unix; se compara con el iat del JWT',
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT sesiones_revocadas_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
