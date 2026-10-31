# HealthNexus API

API REST en **Node.js + Express + MySQL**, construida sobre tu base `healthnexusdb` (la del dump `Dump20261006.sql`).
Usa los mismos usuarios, roles y contraseñas (bcrypt) que el panel web.

## Puesta en marcha

1. Instala Node.js 18 o superior y ten MySQL con tu base `healthnexusdb` cargada.
2. Aplica los cambios mínimos para hospitales (una sola vez):
   `mysql -u root -p healthnexusdb < database/extra.sql`
3. Copia `.env.example` a `.env` y completa `DB_USER`, `DB_PASS` y `JWT_SECRET`.
4. `npm install`
5. `npm run dev` (o `npm start`). Prueba: http://localhost:3000/api/health
6. Opcional (CP-38, rendimiento): `mysql -u root -p healthnexusdb < database/indices_rendimiento.sql`
7. Pruebas automáticas (no necesitan base de datos): `npm test`

> **En el servidor (Nginx delante de la API):** pon `TRUST_PROXY=1` en el `.env`. Con 0, todos los usuarios llegan con la IP del proxy y comparten los límites de peticiones.

## Ejecución con Docker (desarrollo y producción)

Con Docker no necesitas instalar Node ni MySQL: un comando levanta la API y su base de datos.

| Archivo | Para qué sirve |
|---|---|
| `Dockerfile` | Imagen de la API con tres etapas: `deps`, `dev` (recarga automática) y `prod` (mínima, usuario sin privilegios, `HEALTHCHECK`) |
| `docker-compose.yml` | **Desarrollo:** API (puerto 3000, recarga al guardar) + MySQL 8 (puerto 3307) con el esquema inicial |
| `docker-compose.prod.yml` | **Producción / staging:** API solo en `127.0.0.1:3000` detrás de Nginx, MySQL sin puerto publicado, reinicio automático y límites de seguridad |
| `.env.docker.example` | Plantilla de variables para desarrollo |
| `.env.prod.example` | Plantilla de variables para producción o staging |
| `database/initdb/01-laravel.sql` | Esquema de Laravel que se importa la primera vez (ver el paso 1) |

### Desarrollo
Requisito: Docker Desktop (en Windows, con WSL 2).

1. **Esquema inicial.** La API usa las tablas de Laravel. Genera un volcado de una base que solo tenga las migraciones (sin `extra.sql` aplicado) y guárdalo como `database/initdb/01-laravel.sql`:
   ```
   # Con MySQL en un contenedor llamado mysql-local:
   docker exec mysql-local sh -c "mysqldump -uroot -pTU_CLAVE --routines TU_BASE > /tmp/01-laravel.sql"
   docker cp mysql-local:/tmp/01-laravel.sql database/initdb/01-laravel.sql
   ```
   El archivo del repositorio es solo un marcador vacío; no subas volcados con datos reales.
2. Copia las variables: `copy .env.docker.example .env.docker` (en Linux/macOS: `cp`).
3. Levanta todo: `docker compose up --build -d`
4. Comprueba: `curl.exe http://localhost:3000/api/health` debe responder `{"ok":true}`.

El script `database/extra.sql` y los índices de `database/indices_rendimiento.sql` se importan solos junto con el volcado, solo la primera vez (cuando el volumen está vacío).

Comandos de uso diario:

| Tarea | Comando |
|---|---|
| Ver registros de la API | `docker compose logs -f api` |
| Pruebas automáticas | `docker compose exec api npm test` |
| Crear usuarios de prueba por rol (clave `Qa-Hospital-2026!`; el médico recibe el PIN `2468`) | `docker compose exec api node scripts/crear-usuarios-qa.js` |
| Apagar conservando los datos | `docker compose down` |
| Rehacer la base desde cero | `docker compose down -v` y de nuevo `up` |
| Reconstruir tras cambiar `package.json` o el `Dockerfile` | `docker compose up --build -d` |

La API se reinicia sola al guardar un archivo de `src/`. MySQL queda disponible en `localhost:3307` (usuario `hn_app`, clave `hn_dev_pass`, base `healthnexusdb`) para MySQL Workbench. Estas credenciales son solo de desarrollo.

> En PowerShell usa `curl.exe` (no `curl`) y `Invoke-RestMethod` para probar el login; las comillas del JSON no se pasan bien con `curl.exe -d`.

### Producción o staging (EC2 con Nginx)
1. Instala Docker en el servidor y clona el repositorio.
2. Crea el archivo de variables del ambiente y protégelo:
   ```
   cp .env.prod.example .env.prod      # o .env.qa para staging
   chmod 600 .env.prod
   ```
   Genera cada secreto con `openssl rand -hex 32`. Usa valores distintos en cada ambiente y **nunca subas estos archivos a Git** (el `.gitignore` ya los excluye).
3. Carga la base (la primera vez): levanta solo MySQL e importa tu volcado.
   ```
   alias dc='docker compose -f docker-compose.prod.yml --env-file .env.prod'
   dc up -d db
   dc exec -T db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' < respaldo.sql
   ```
4. Despliega: `dc up -d --build` y comprueba `curl https://TU-DOMINIO/api/health`.
5. Nginx del servidor sigue siendo la entrada HTTPS: `location /api/ { proxy_pass http://127.0.0.1:3000; }` con las cabeceras `X-Forwarded-For` y `X-Forwarded-Proto`. Con Docker `TRUST_PROXY=1` ya viene en la plantilla de producción.
6. Actualizar: `git pull` y `dc up -d --build`. Para volver a una versión anterior: `TAG=1.0.0 dc up -d`.

La API recibe solo las variables que necesita (nunca la clave de `root` de MySQL) y corre con el sistema de archivos en solo lectura y sin privilegios extra.

## Variables y secretos por ambiente

| Ambiente | Archivo (solo en esa máquina) | Compose | Base de datos |
|---|---|---|---|
| Desarrollo | `.env.docker` | `docker-compose.yml` | MySQL en Docker |
| Staging / QA | `.env.qa` | `docker-compose.prod.yml` | MySQL en Docker con datos ficticios |
| Producción | `.env.rds` | `docker-compose.rds.yml` | Amazon RDS |

Reglas: en Git solo van las plantillas `.env.*.example`; cada ambiente tiene sus propios `JWT_SECRET` y `DB_PASS` (generados con `openssl rand -hex 32`, sin `$` porque Compose lo interpreta); los archivos reales llevan `chmod 600`; la API usa un usuario de MySQL propio (`database/usuario-api.sql`), no `admin`.

**Revisión al arrancar.** En producción (`NODE_ENV=production`, lo fija la imagen) la API **no arranca** si `JWT_SECRET` tiene menos de 32 caracteres o un valor de ejemplo, o si falta `DB_PASS`; usuario `admin`, `TRUST_PROXY=0` o `CORS_ORIGINS` vacío solo generan avisos. Revisar sin arrancar:
```
docker compose -f docker-compose.rds.yml --env-file .env.rds run --rm --no-deps api node src/entorno.js
```

**Secretos de producción en AWS SSM Parameter Store** (opcional, recomendado):
1. Una vez, desde una máquina con tus credenciales de IAM: `./scripts/subir-secretos-ssm.sh prod .env.rds` → guarda cada variable cifrada en `/healthnexus/prod/<VARIABLE>`.
2. Al EC2 asígnale un rol de IAM con la política `deploy/iam-healthnexus-ssm.json` (cambia `TU_ID_DE_CUENTA`).
3. En cada despliegue, en el servidor: `./scripts/env-desde-ssm.sh prod .env.rds` y `docker compose -f docker-compose.rds.yml --env-file .env.rds up -d --build`.
4. Para rotar un secreto: cámbialo en SSM (paso 1 con el archivo nuevo), repite el paso 3. Cambiar `JWT_SECRET` cierra todas las sesiones.

## Endpoints (todos bajo `/api`; salvo login, PIN y recuperación de contraseña, requieren `Authorization: Bearer <token>`)

Un 403 por rol queda en `audit_logs` como `acceso_denegado` (con método y ruta, sin la query string).

| Método | Ruta | Roles | Tablas |
|---|---|---|---|
| POST | /auth/login | público | users, roles (médico: responde `{ requierePin, pinToken }` en lugar del token; dispositivo bloqueado en la web: 403 `DISPOSITIVO_BLOQUEADO`) |
| POST | /auth/pin | público (con `pinToken`) | users (`{ pinToken, pin }` → `{ token, user }`; 5 intentos fallidos cada 15 min; `pin_fallido`/`pin_exitoso` en `audit_logs`) |
| GET | /auth/me | todos | users |
| POST | /auth/recuperar | público | users, recuperacion_clave (`{ email }` → 202 siempre, exista o no la cuenta; envía un código de 6 dígitos que vence en 15 min; 3 por correo por hora y 10 por IP cada 15 min) |
| POST | /auth/recuperar/verificar | público | recuperacion_clave (`{ email, codigo }` → `{ resetToken }` de 10 min; al 5.º error el código se invalida) |
| POST | /auth/recuperar/restablecer | público (con `resetToken`) | users, sesiones_revocadas (`{ resetToken, nueva }`; 8+ caracteres, una mayúscula y un número; cierra las sesiones de la app; `clave_restablecida` en `audit_logs`) |
| GET | /stats | médico, enfermería | pacientes, admisiones |
| GET | /patients?q=&nivel=&page=&limit= | médico, enfermería | pacientes, admisiones (datos del paciente y `triageLevel`; `nivel` = rojo…azul o `sin`) |
| GET | /patients/:id | médico, enfermería | pacientes, estados, municipios (ficha completa) |
| POST | /patients | médico, enfermería | pacientes (alta con todos los campos de la tabla) |
| GET | /triage?q=&nivel= | médico, enfermería | pacientes, admisiones (triage actual) |
| PATCH | /patients/:id/triage | médico | admisiones (cambia el triage; crea la admisión si no hay una activa) |
| GET | /catalogos/estados | médico, enfermería | estados |
| GET | /catalogos/municipios?estadoId= | médico, enfermería | municipios |
| GET | /derivaciones/camas | médico, enfermería | camas, servicios (camas disponibles; lo usa la app para elegir destino) |
| GET | /derivaciones/internas | médico, enfermería | cama_paciente, camas, servicios |
| POST | /derivaciones/internas | médico | cama_paciente, camas, seguimientos |
| PATCH | /derivaciones/internas/:id | médico, enfermería | cama_paciente, camas |
| GET | /derivaciones/externas | médico | admisiones, hospitales |
| POST | /derivaciones/externas | médico | admisiones |
| GET | /hospitals?lat=&lng=&radioKm=&limite= | médico, enfermería | hospitales (con ubicación: solo los cercanos, 50 km y 10 por defecto; lat/lng fuera de rango = 400) |
| POST | /hospitals/:id/reservas | médico | hospitales, reservas_hospital |
| GET | /seguimiento?page=&limit= | médico, enfermería | seguimientos, pacientes, camas (total en `X-Total-Count`) |
| GET | /auditoria | administrador | audit_logs |
| GET | /cuentas?q=&estado=abierta\|cerrada\|cancelada&con_saldo=1&paciente_id=&page=&limit= | administrador | cuentas, pacientes (lista paginada con `saldoPendiente`) |
| GET | /cuentas/:id | administrador | cuentas, cuenta_items, pagos (cargos, pagos con cancelados marcados y `verificacion` del saldo; cada consulta queda en `audit_logs` como `consulta_sensible`) |
| GET | /pagos/:id/recibo | administrador | pagos, cuentas, pacientes (PDF `application/pdf`, queda en `audit_logs` como `recibo_descargado`) |
| POST | /emergencias | médico, enfermería | alertas (máx. 3 por minuto por usuario; `ubicacion` opcional `{lat,lng}`; envía push a médicos y enfermería) |
| GET | /emergencias/activas | médico, enfermería | emergencias abiertas (`activa` o `vista`) de las últimas 24 h, con quién la activó, hora y ubicación |
| PATCH | /emergencias/:id/atender | médico, enfermería | marca la emergencia como resuelta (`resuelta_por`, `resuelta_en`) y la registra en la bitácora |
| POST | /notificaciones/token | todos (con `X-Device-Fingerprint`) | dispositivos (`{ token }`: guarda el token FCM del dispositivo; 404 si el dispositivo no existe o está bloqueado) |
| DELETE | /notificaciones/token | todos (con `X-Device-Fingerprint`) | dispositivos (borra el token al cerrar sesión) |
| GET | /farmacia/resumen | farmacia | medicamentos, lotes |
| GET | /farmacia/medicamentos?q=&estado=bajo\|sin_stock | farmacia | medicamentos |
| GET | /farmacia/catalogo?q= | farmacia, enfermería, médico | medicamentos (lista corta, sin precios) |
| GET | /farmacia/existencias?q=&caduca=vencidos\|30 | farmacia, enfermería, médico | lotes, medicamentos |
| GET | /farmacia/movimientos?tipo=&q= | farmacia, enfermería | movimientos_inventario |
| POST | /farmacia/movimientos | farmacia | lotes, medicamentos, movimientos_inventario |
| GET | /farmacia/alertas | farmacia | medicamentos, lotes |
| GET | /enfermeria/signos?pacienteId= | enfermería, médico | signos_vitales |
| POST | /enfermeria/signos | enfermería | signos_vitales |
| GET | /enfermeria/administraciones?pacienteId=&page=&limit= | enfermería, médico | administraciones_medicamento (total en `X-Total-Count`) |
| POST | /enfermeria/administraciones | enfermería | administraciones_medicamento |

El administrador tiene acceso a todo. Cada acción importante se registra en `audit_logs`.

## Notificaciones push (Firebase Cloud Messaging)

La app registra el token de FCM de cada teléfono con `POST /notificaciones/token` y lo borra al cerrar sesión. La API envía avisos en dos casos:

| Evento | Destinatarios | Mensaje |
|---|---|---|
| `POST /emergencias` | médicos y enfermería (menos quien la activó) | "Código de emergencia activado" · prioridad alta |
| `PATCH /patients/:id/triage` a nivel **rojo** | médicos (menos quien clasificó) | "Paciente en nivel I · Reanimación" |

Los mensajes nunca incluyen nombres, ubicación ni datos clínicos, porque se ven en la pantalla bloqueada. Solo reciben avisos los dispositivos activos de usuarios activos; los tokens que FCM rechaza se borran solos.

**Configuración (una vez):**
1. En la consola de Firebase: *Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada*. Guarda el JSON **fuera del repositorio**.
2. Agrega las columnas a la base (el script se puede correr más de una vez):
   - **RDS:** `mysql -h <RDS> -u admin -p healthnexusdb < database/push.sql` (o la migración de Laravel `add_fcm_token_to_dispositivos_table`).
   - **Docker local:** una base nueva ya lo trae (`04-push.sql`). Si tu base ya existía (volumen `db_data`), aplícalo sin borrarla:
     ```powershell
     Get-Content database\push.sql | docker compose exec -T db mysql -uroot -proot_dev_pass healthnexusdb
     ```
3. En el servidor, convierte el JSON a base64 y ponlo en `.env.rds` (o súbelo a SSM con `scripts/subir-secretos-ssm.sh`):
   ```bash
   echo "FIREBASE_CREDENTIALS_BASE64=$(base64 -w0 cuenta-de-servicio.json)" >> .env.rds
   chmod 600 .env.rds && shred -u cuenta-de-servicio.json
   docker compose -f docker-compose.rds.yml --env-file .env.rds up -d
   ```
   En Docker local: guarda el JSON en `secrets/cuenta-de-servicio.json` (ignorado por git y por la imagen) y en `.env.docker` pon `FIREBASE_CREDENTIALS_FILE=/app/secrets/cuenta-de-servicio.json`; luego `docker compose up -d`. Sin credenciales, las notificaciones quedan desactivadas y todo lo demás funciona igual.

## Recuperación de contraseña (código por correo)

Flujo de la app: *¿La olvidaste?* → correo → código de 6 dígitos → contraseña nueva. La contraseña se guarda en formato de Laravel (`$2y$`, costo 12), así que sirve igual en la web y en la app.

- Solo se guarda el **hash** del código; cada código vence en 15 minutos, sirve una vez y se invalida al 5.º intento fallido o al pedir otro.
- La respuesta de `POST /auth/recuperar` es la misma exista o no el correo (no se pueden adivinar cuentas).
- Al cambiar la contraseña se cierran las sesiones de la app abiertas antes (los tokens responden 401 `SESION_REVOCADA`) y se borra el `remember_token` de la web.
- El **PIN del médico no se recupera por correo**: lo regenera el administrador desde la web.

**Configuración (una vez):**
1. Crea las tablas (se puede correr más de una vez):
   - **RDS:** `mysql -h <RDS> -u admin -p healthnexusdb < database/recuperacion.sql`
   - **Docker local:** una base nueva ya lo trae (`05-recuperacion.sql`). Si tu base ya existía:
     ```powershell
     Get-Content database\recuperacion.sql | docker compose exec -T db mysql -uroot -proot_dev_pass healthnexusdb
     ```
   Si la API arranca sin estas tablas sigue funcionando; solo la recuperación responde 500 y el cambio de contraseña no cierra sesiones.
2. Configura el correo saliente en `.env.rds` (o en SSM): `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`. Con Gmail usa una *contraseña de aplicación* (requiere verificación en dos pasos), no la contraseña de la cuenta. `SMTP_PASS` es un secreto, igual que `DB_PASS`.
3. **Sin `SMTP_HOST`:** en desarrollo el código se imprime en los logs de la API (`docker compose logs -f api`, busca `[correo de desarrollo]`); en producción no se envía nada y el código nunca se escribe en los logs.

## Permisos por rol (alineados con los permisos de tu tabla `permissions`)

| Rol | Puede usar |
|---|---|
| administrador | todo |
| médico | stats, pacientes, triage (único rol que lo cambia), derivaciones, hospitales, seguimiento, existencias, signos y administraciones (solo lectura) |
| enfermería | lo anterior de pacientes y derivaciones, **registrar** signos vitales y administración de medicamentos, existencias y movimientos (solo lectura) |
| farmacia | resumen, medicamentos, existencias, movimientos (**registrar**) y alertas. No ve pacientes, seguimiento, hospitales ni auditoría, y no activa emergencias |

Cuentas y recibos (HU-73, HU-75) son **solo lectura y solo para el administrador**; los montos salen como números con dos decimales y los pagos cancelados no cuentan en el saldo.
El recibo se genera en la API con `pdfkit` (no necesita navegador ni archivos temporales).

`/auth/me` está abierto a cualquier rol con sesión. `/emergencias` es solo para médico y enfermería (y administrador).

## Crear usuarios de prueba (tu BD solo trae administrador y médico)
```
node scripts/crear-usuario.js enfermera@hospital.com "Nombre Apellido" enfermeria "Contraseña123"
node scripts/crear-usuario.js farmacia@hospital.com "Nombre Apellido" farmacia "Contraseña123"
```
El script usa bcrypt en formato Laravel y asigna el rol en `model_has_roles`.

### Datos de prueba de cuentas y pagos (HU-76)
```
docker compose exec api node scripts/crear-usuarios-qa.js     # incluye qa.admin@healthnexus.test
docker compose exec api node scripts/crear-datos-cuentas.js   # 4 cuentas: sin pagos, con abono, pagada y con un pago cancelado
```
Usa los primeros pacientes que existan, no duplica si se repite y **se niega a correr con `NODE_ENV=production`**.

> El respaldo de producción (`respaldo_produccion.sql`) trae usuarios, hashes de contraseña y firmas de personal reales.
> **No lo subas a ningún repositorio**: cárgalo solo en tu MySQL local (`database/initdb/01-laravel.sql` ya está ignorado si lo nombras `respaldo*.sql`).

## Cuerpos de ejemplo

```json
POST /auth/login          { "email": "...", "password": "..." }
POST /patients            (ver «Alta de pacientes» más abajo)
PATCH /patients/5/triage  { "triageLevel": "amarillo" }
POST /derivaciones/internas  { "pacienteId": 5, "camaId": 2, "motivo": "Pasa a observación" }
PATCH /derivaciones/internas/1 { "estado": "finalizada" }
POST /derivaciones/externas  { "pacienteId": 5, "hospitalId": 1, "motivo": "Requiere UCI" }
POST /hospitals/1/reservas   { "pacienteId": 5 }
POST /emergencias         { "mensaje": "Paro cardiaco en urgencias" }
POST /farmacia/movimientos { "loteId": 12, "tipo": "salida", "cantidad": 3, "motivo": "Dispensación" }
POST /enfermeria/signos   { "pacienteId": 5, "temperatura": 36.8, "frecuenciaCardiaca": 80, "presionArterial": "120/80", "saturacionOxigeno": 97 }
POST /enfermeria/administraciones { "pacienteId": 5, "medicamentoId": 3, "dosis": "500 mg", "reaccionAdversa": false }
```

Movimientos: `entrada` y `devolucion` suman, `salida` resta, `ajuste` fija la nueva cantidad del lote. Cada movimiento actualiza `lotes.cantidad_disponible` y `medicamentos.stock_actual` en una sola transacción.

## Alta de pacientes: `POST /patients`
Guarda **todos los campos de la tabla `pacientes`**. Obligatorios: `nombre`, `apellidoPaterno`, `fechaNacimiento` (AAAA-MM-DD) y `sexo`. El resto es opcional:

```json
{
  "nombre": "María Fernanda", "apellidoPaterno": "Lozano", "apellidoMaterno": "Reyes",
  "fechaNacimiento": "1990-05-15", "sexo": "mujer", "estadoCivil": "Casado",
  "nacionalidad": "MEXICANA", "estadoNacimiento": "Guerrero", "curp": "LOPM900515MMCRRN01",
  "telefonoPrincipal": "7221234567", "correoElectronico": "maria@example.com", "ocupacion": "Docente",
  "responsableNombre": "Jorge Lozano", "tipoSanguineo": "O+",
  "alergias": "Penicilina", "enfermedadesCronicas": "Hipertensión",
  "estadoId": 15, "municipioId": 800, "colonia": "Centro", "calle": "Av. Hidalgo",
  "numeroExterior": "120", "numeroInterior": "4B"
}
```
Reglas (tomadas de cómo están tus datos):
- `sexo`: hombre, mujer u otro · `estadoCivil`: Soltero, Casado, Divorciado, Unión Libre o Viudo · `tipoSanguineo`: A+, A-, B+, B-, AB+, AB-, O+, O-.
- `nacionalidad` (por defecto `MEXICANA`): si es `EXTRANJERA` exige `paisNacimiento` y `pasaporte` y no admite `estadoNacimiento`; si es `MEXICANA` no admite país ni pasaporte.
- `curp`: formato oficial de 18 caracteres y única (repetida responde 409).
- `telefonoPrincipal`: 10 dígitos para mexicanos, de 7 a 15 para extranjeros. `correoElectronico`: formato válido.
- Menores de 18 años: `responsableNombre` es obligatorio.
- `municipioId` debe pertenecer a `estadoId` (si solo envías el municipio, el estado se deduce). Usa `/catalogos/estados` y `/catalogos/municipios?estadoId=`.
- No registra triage: la clasificación se hace en `/triage` y `PATCH /patients/:id/triage`.

## Triage
`GET /triage` lista los pacientes con su triage actual (el de su admisión activa; `triageLevel: null` = sin clasificar), con los clasificados primero. `PATCH /patients/:id/triage` con `{ "triageLevel": "rojo|naranja|amarillo|verde|azul" }` cambia el nivel; si el paciente no tiene admisión activa (en espera, atendido u hospitalizado) se crea una de urgencias al clasificarlo.

## Cómo se adaptó a tu base de datos

- **Triage:** acepta `rojo, naranja, amarillo, verde, azul` (los de tu BD) y los alias `red, yellow, green`. En `/stats`, `yellowCount` suma naranja + amarillo y `greenCount` suma verde + azul.
- **POST /patients:** crea el paciente y su admisión de urgencias. Si solo envías `name` y `age`, separa nombre y apellidos y calcula una fecha de nacimiento aproximada; puedes enviar también `nombre`, `apellido_paterno`, `fecha_nacimiento`, `sexo`, `curp`.
- **Derivaciones internas:** usan `cama_paciente` (asignar cama = traslado confirmado; finalizar libera la cama a "limpieza") y dejan un registro tipo `traslado` en `seguimientos`.
- **Derivaciones externas:** actualizan la última admisión del paciente (`hospital_derivado_id`, estado `derivado`).
- **Hospitales:** tu tabla no tenía camas ni reservas, por eso `database/extra.sql` agrega `camas_totales`, `camas_disponibles` y la tabla `reservas_hospital`, además de 3 hospitales de ejemplo si la tabla está vacía.
- **Emergencias:** se guardan como alerta crítica en `alertas`.
- **Seguridad:** JWT con expiración, bcrypt (los hashes `$2y$` de Laravel funcionan), 5 intentos fallidos de login por IP cada 15 minutos, helmet, CORS limitado (`CORS_ORIGINS`), consultas preparadas y auditoría.

## Pendiente (siguiente fase)

- Publicar con HTTPS (Nginx) y un `JWT_SECRET` largo y distinto al de pruebas.
- Dispensación de recetas (sale de `consulta_medicamento`, que hoy está vacía) y que la administración de enfermería descuente inventario: no se incluyeron.
