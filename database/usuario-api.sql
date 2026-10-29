-- Usuario de MySQL solo para la API (privilegio mínimo). Ejecútalo UNA vez con el usuario admin de RDS:
--   mysql -h <endpoint-rds> -u admin -p < database/usuario-api.sql
-- Antes, cambia CAMBIAME por una contraseña generada con:  openssl rand -hex 24
-- La API solo lee, inserta y actualiza: no borra filas ni cambia la estructura de las tablas.
CREATE USER IF NOT EXISTS 'hn_api'@'%' IDENTIFIED BY 'CAMBIAME';
GRANT SELECT, INSERT, UPDATE ON healthnexusdb.* TO 'hn_api'@'%';
-- La bitácora es de solo inserción: la API nunca debe modificar registros de auditoría.
-- (MySQL no permite quitar UPDATE de una sola tabla tras un GRANT a nivel base; si lo necesitas,
--  otorga los permisos tabla por tabla en lugar de healthnexusdb.*.)
FLUSH PRIVILEGES;
-- Comprobar:  SHOW GRANTS FOR 'hn_api'@'%';
