# Política de seguridad

La API de HealthNexus maneja información clínica (pacientes, signos vitales, medicación, recetas, traslados y cuentas) y es el punto de entrada de la app móvil. Por eso tomamos en serio cualquier reporte de seguridad.

## Versiones con soporte

| Versión | Soporte |
|---|---|
| 1.0.x (`main`, desplegada en `healthnexus.duckdns.org`) | ✅ Sí |
| Versiones anteriores | ❌ No |

## Cómo reportar una vulnerabilidad

**No abras un issue público.** Usa cualquiera de estos canales privados:

1. **GitHub (preferido):** en la pestaña **Security** del repositorio, elige **Report a vulnerability**.
2. **Correo:** al222310418@gmail.com, con el asunto `[SEGURIDAD] HealthNexus API`.

Incluye, si puedes:

- El endpoint afectado (método y ruta) y el rol con el que lo probaste.
- Pasos para reproducirlo: una petición de ejemplo con `curl` o Postman, **sin tokens reales**.
- El impacto posible (por ejemplo, saltarse un rol, ver datos de otro paciente o evadir el límite de intentos).
- **Sin datos reales de pacientes.**

## Reglas para probar

- Prueba en tu propio entorno con Docker (`docker compose up`) y los usuarios de `scripts/crear-usuarios-qa.js`.
- **No hagas pruebas de carga, fuerza bruta ni escaneos automáticos contra producción** (`healthnexus.duckdns.org`).
- No accedas, modifiques ni borres datos que no sean tuyos.

## Qué puedes esperar

| Etapa | Plazo |
|---|---|
| Acuse de recibo | 72 horas |
| Evaluación inicial y severidad | 7 días |
| Corrección de fallas críticas o altas | Lo antes posible, normalmente en menos de 30 días |

Te avisaremos cuando la corrección esté desplegada y, si quieres, te daremos crédito.

## Alcance

**Sí entra:**
- Autenticación: login, PIN del médico, huella de dispositivo, JWT y recuperación de contraseña.
- Autorización por rol en cualquier endpoint de `/api`.
- Inyección SQL, exposición de datos, límites de peticiones y cabeceras de seguridad.
- El `Dockerfile`, los archivos de Compose, los workflows de CI y los scripts de `scripts/` y `deploy/`.

**No entra (repórtalo en su propio repositorio):**
- La app móvil: [healthnexus-m-docker](https://github.com/JesusFelipeA/healthnexus-m-docker).
- La web Laravel.
- Denegación de servicio por volumen, ingeniería social o spam.

## Medidas que ya tiene la API

- Contraseñas con bcrypt (las mismas que en la web), JWT con un secreto distinto por ambiente y PIN adicional para médicos.
- Límites de peticiones (`express-rate-limit`) y cabeceras de seguridad (`helmet`).
- Los 403 por rol se registran en `audit_logs` como `acceso_denegado`.
- En producción la API **no arranca** con un `JWT_SECRET` débil o sin `DB_PASS` (`src/entorno.js`).
- Los secretos de producción se guardan cifrados en AWS SSM Parameter Store y nunca entran a Git.
- El contenedor de producción corre sin privilegios, con el sistema de archivos en solo lectura y sin acceso a la clave de `root` de MySQL.
- El CI ejecuta `npm audit` en cada PR.
