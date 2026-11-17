## Descripción
<!-- Qué cambia y por qué. -->

Cierra #

## Tipo de cambio
- [ ] `feat`: endpoint o función nueva
- [ ] `fix`: corrección de error
- [ ] `perf`: rendimiento (índices, consultas)
- [ ] `refactor`: reestructuración sin cambiar el comportamiento
- [ ] `test`: pruebas
- [ ] `docs`: documentación
- [ ] `chore`: dependencias, Docker, CI o configuración

## Endpoints afectados
<!-- Por ejemplo: POST /api/recetas, GET /api/patients/:id -->

## Impacto
- [ ] Cambia la base de datos (script nuevo en `database/`)
- [ ] Agrega o cambia variables de entorno (actualicé las plantillas `.env.*.example`)
- [ ] Cambia respuestas o códigos de error que usa la app móvil
- [ ] Cambia permisos por rol
- [ ] Requiere un paso manual al desplegar

## Cómo probarlo
1.
2.

## Lista de verificación
- [ ] Mi rama parte de `development` y el PR va hacia `development`.
- [ ] `npm test` pasa y agregué o actualicé pruebas en `test/`.
- [ ] Documenté las rutas nuevas o cambiadas en `src/openapi.js`.
- [ ] Actualicé la colección de Postman, si aplica.
- [ ] Las consultas SQL usan parámetros (`?`), sin concatenar valores.
- [ ] No subí `.env` reales, secretos, credenciales ni volcados con datos reales.
- [ ] Actualicé el `README.md` si hacía falta.
