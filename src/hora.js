// Hora local de México para las columnas DATETIME que la aplicación web (Laravel) filtra y muestra por fecha.
// Laravel trabaja con la zona America/Mexico_City y guarda la hora local tal cual; MySQL (y NOW()) va en UTC.
// Sin este ajuste, un registro hecho de noche desde la app móvil cae en "mañana" y no aparece en la web.
// México no usa horario de verano desde 2022: siempre UTC-6.
const AHORA_MX = 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL 6 HOUR)';

module.exports = { AHORA_MX };
