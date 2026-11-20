# Observabilidad: panel de la API en Grafana Cloud

Sirve para ver cómo responde la API en producción: cuántas peticiones llegan, cuántas fallan, cuánto tardan por pantalla, el detalle de una petición lenta (qué consulta SQL tardó) y cómo va el servidor EC2.

```
API (OpenTelemetry) ──OTLP──▶ Grafana Alloy (contenedor) ──HTTPS──▶ Grafana Cloud
                                     ▲                                  (métricas, trazas, panel)
                     CPU, memoria y disco del EC2
```

| Pieza | Archivo | Qué hace |
|---|---|---|
| Instrumentación | `src/telemetria.js` | Mide cada petición HTTP, cada ruta de Express y cada consulta a MySQL. Se carga con `node --require` antes que la API |
| Agente | `observabilidad/alloy/config.alloy` | Recibe los datos de la API, borra por segunda vez lo sensible y los manda a Grafana Cloud. También mide el servidor |
| Panel | `observabilidad/grafana/healthnexus-api.json` | 17 paneles: peticiones, errores 5xx, p95, rechazos 401/403/429, por ruta, trazas con error o lentas, CPU, memoria y disco |

## Privacidad: qué sale y qué no

La API maneja expedientes, así que antes de salir del servidor se quita todo dato de pacientes:

| Dato | Cómo queda |
|---|---|
| Búsquedas (`/patients?q=Castillo`) | `/api/patients`: se quita la query string |
| Ids en la ruta (`/patients/15`) | `/api/patients/:id(\d+)`: queda la plantilla de la ruta |
| Consultas SQL | Con los valores cambiados por `?` (`WHERE curp = ?`) |
| Mensajes de error | Lo que va entre comillas se cambia por `?` y la pila se corta a 8 líneas |
| Encabezados (token, huella del dispositivo), cuerpos, user-agent | No se capturan. Del user-agent solo queda la familia: `app-android`, `web`, `k6` u `otro` |
| Logs de los contenedores | No se recolectan |

Alloy borra otra vez la query, la URL completa, el user-agent y los encabezados de autorización y huella, por si algún día una librería los agrega. Las pruebas `test/telemetria.test.js` revisan la limpieza.

## Puesta en marcha (una sola vez)

### 1. Cuenta de Grafana Cloud
1. Crea la cuenta gratis en grafana.com y un *stack* (por ejemplo `healthnexus`). Elige una región de Estados Unidos.
2. En el portal, abre el stack con **Launch** y en el mosaico **OpenTelemetry** pulsa **Configure** (o **Connections → Add new connection → OpenTelemetry**).
3. Genera el token (nombre: `alloy-ec2`). Copia tres valores:
   - **Endpoint** (`OTEL_EXPORTER_OTLP_ENDPOINT`): algo como `https://otlp-gateway-prod-us-east-0.grafana.net/otlp`.
   - **Instance ID**: un número.
   - **Token**: empieza con `glc_`. Es un secreto: no lo pegues en chats ni en el repo.

   Si la página solo te da `OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <texto>"`, el texto trae los dos últimos. Sácalos en PowerShell; sale `<instance id>:<token>`:
   ```powershell
   [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("<texto>"))
   ```

### 2. Variables en el servidor
Agrégalas al `.env.rds` del EC2 (o súbelas a SSM con `scripts/subir-secretos-ssm.sh`):

```bash
cd ~/healthnexus-api-docker
nano .env.rds
```
```
COMPOSE_PROFILES=observabilidad
OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy:4318
GRAFANA_CLOUD_OTLP_ENDPOINT=<endpoint>
GRAFANA_CLOUD_INSTANCE_ID=<instance id>
GRAFANA_CLOUD_TOKEN=<token>
```

### 3. Levantar
```bash
git pull
docker compose -f docker-compose.rds.yml --env-file .env.rds up -d --build
docker compose -f docker-compose.rds.yml --env-file .env.rds ps
docker logs healthnexus-api --tail 5
docker logs healthnexus-alloy --tail 20
```
- En el log de la API debe salir `Telemetría activa → http://alloy:4318`.
- En el de Alloy no deben salir `401` ni `Exporting failed`. Un `401` es el token o el Instance ID.
- Alloy usa alrededor de 100 a 150 MB. Revisa antes con `free -m` que el EC2 tenga espacio.

### 4. Importar el panel
1. En Grafana Cloud: **Dashboards → New → Import**.
2. Sube `observabilidad/grafana/healthnexus-api.json`.
3. En **Métricas** elige `grafanacloud-<stack>-prom` y en **Trazas** `grafanacloud-<stack>-traces`. Pulsa **Import**.
4. Abre la app y navega un poco: en 1 o 2 minutos aparecen los datos.

Grafana también puede mostrar el servicio en **Observability → Application**, su vista para servicios con OpenTelemetry. El panel importado no depende de ella.

## Qué mirar

| Panel | Bien | Para revisar |
|---|---|---|
| Errores del servidor (5xx) | 0 % | Más de 1 %: abre "Peticiones con error" y entra a la traza |
| Latencia p95 | Menos de 500 ms | Más de 800 ms (el criterio de la prueba de carga) |
| Rechazos 401 / 403 / 429 | Pocos | Un pico de 429: el límite `RATE_LIMIT_MAX` se quedó corto, porque toda la red del hospital sale con la misma IP |
| Consultas SQL lentas | Vacío | Una consulta repetida aquí suele pedir un índice |
| CPU y memoria | Menos de 70 % | Cerca de 100 % o memoria al límite: el EC2 se quedó chico |

Por la noche el RDS está apagado: verás errores 503 o ninguna petición en ese horario. Es lo esperado.

## Apagarla
En `.env.rds` deja vacíos `COMPOSE_PROFILES` y `OTEL_EXPORTER_OTLP_ENDPOINT`, luego:
```bash
docker rm -f healthnexus-alloy
docker compose -f docker-compose.rds.yml --env-file .env.rds up -d
```
Sin `OTEL_EXPORTER_OTLP_ENDPOINT`, `telemetria.js` no carga nada: la API queda igual que antes. Si la telemetría falla al iniciar, la API muestra un aviso y sigue funcionando.

## Plan gratuito
El plan gratuito de Grafana Cloud guarda métricas y trazas 14 días y tiene un límite mensual de series y de trazas. Para este proyecto alcanza. Si se acerca al límite, en `.env.rds` pon `OTEL_TRACES_SAMPLER_ARG=0.2` para guardar solo 1 de cada 5 trazas. Las métricas no cambian.

## Probarlo en tu computadora (opcional)
Con Docker local no hace falta: la telemetría queda apagada. Para ver qué saldría sin cuenta de Grafana, levanta cualquier receptor OTLP en el puerto 4318 y arranca la API con:
```powershell
$env:OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318"
npm start
```
