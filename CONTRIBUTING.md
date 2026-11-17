# Cómo contribuir a HealthNexus API

Gracias por ayudar. Esta guía explica cómo preparar tu entorno, cómo trabajar con ramas y qué debe cumplir un pull request para aceptarse.

## Antes de empezar

- Lee el [Código de conducta](CODE_OF_CONDUCT.md).
- Revisa los [issues abiertos](../../issues) para no duplicar trabajo. Si vas a hacer un cambio grande (un endpoint nuevo, un cambio en la base o en la autenticación), abre primero un issue.
- **Nunca** subas archivos `.env` reales (`.env`, `.env.docker`, `.env.qa`, `.env.prod`, `.env.rds`), secretos, volcados SQL con datos reales, credenciales de Firebase o de AWS. En Git solo van las plantillas `.env.*.example`.
- Para reportar una vulnerabilidad **no abras un issue público**: sigue la [Política de seguridad](SECURITY.md).

## Preparar el entorno

La forma recomendada es con Docker, porque no necesitas instalar Node ni MySQL:

```bash
git clone https://github.com/JesusFelipeA/healthnexus-api-sprint4.git
cd healthnexus-api-sprint4
cp .env.docker.example .env.docker      # en Windows: copy
# coloca el esquema inicial en database/initdb/01-laravel.sql (ver README)
docker compose up --build -d
curl http://localhost:3000/api/health   # debe responder {"ok":true}
docker compose exec api node scripts/crear-usuarios-qa.js
```

Si prefieres no usar Docker: Node.js 18 o superior y MySQL con `healthnexusdb`. Copia `.env.example` a `.env`, ejecuta `npm install` y luego `npm run dev`. Los detalles están en el [README](README.md).

## Ramas

| Rama | Uso |
|---|---|
| `main` | Lo que está desplegado en producción. No se hace push directo. |
| `development` | Integración. Aquí llegan los PR. |
| `feature/<descripcion-corta>` | Funciones nuevas, por ejemplo `feature/endpoint-recetas` |
| `fix/<descripcion-corta>` | Corrección de errores, por ejemplo `fix/pin-medico-401` |
| `docs/<descripcion-corta>` | Solo documentación |

Crea tu rama a partir de `development` y abre el PR hacia `development`. Las dos ramas protegidas exigen un PR y que el CI pase.

## Commits

Usamos [Conventional Commits](https://www.conventionalcommits.org/es/), en español y en modo imperativo:

```
feat: agrega GET /recetas/:id
fix: valida huella de dispositivo en /auth/pin
perf: agrega índice a signos_vitales por paciente
test: cubre 403 por rol en farmacia
docs: documenta /cuentas en OpenAPI
chore: actualiza express-rate-limit
```

## Reglas del código

- **Cada ruta nueva se documenta en `src/openapi.js`.** `test/openapi.test.js` falla si una ruta de Express no está documentada o si se documenta una que no existe.
- Toda ruta protegida valida el rol con el middleware de `src/middleware.js`. Los permisos deben coincidir con la tabla `permissions` de la web.
- Las consultas a MySQL usan parámetros (`?`) de `mysql2`; **nunca** concatenes valores en el SQL.
- Los cambios en la base van como script nuevo en `database/` y se mencionan en el README. No edites las tablas de Laravel a mano: la web también las usa.
- Las variables de entorno nuevas se agregan a **todas** las plantillas `.env.*.example` y, si son obligatorias en producción, a la revisión de `src/entorno.js`.
- Los mensajes de error para el cliente van en español y con un `code` estable (por ejemplo `DISPOSITIVO_BLOQUEADO`), porque la app móvil los usa.
- Si cambias una ruta, actualiza también la colección de Postman en `postman/`.

## Pruebas

```bash
npm test                          # no necesita base de datos
npm run test:junit                # además genera reports/junit-api.xml
docker compose exec api npm test  # lo mismo, en Docker
```

- Toda función nueva o corrección debe llevar su prueba en `test/`.
- El CI también ejecuta `npm audit --omit=dev --audit-level=high`. Si agregas una dependencia, asegúrate de que no tenga vulnerabilidades altas.
- Si el cambio afecta a la app móvil (respuestas, códigos de error), avisa en el PR para actualizar [healthnexus-m-docker](https://github.com/JesusFelipeA/healthnexus-m-docker).

## Pull requests

1. Actualiza tu rama con `development` antes de abrir el PR.
2. Llena la plantilla del PR: qué cambia, qué endpoints toca y cómo probarlo.
3. El CI (pruebas, auditoría e imagen de Docker) debe pasar en verde.
4. Se necesita al menos una aprobación de otro integrante antes de hacer merge.

## Despliegue

Solo los mantenedores despliegan en producción (EC2 + Nginx + RDS). El proceso está en la sección *Producción o staging* del [README](README.md). Las migraciones en RDS las aplica el responsable de despliegues.
