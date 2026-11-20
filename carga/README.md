# Prueba de carga: turno de enfermería (k6)

k6 no abre la app: reproduce las mismas peticiones HTTP que el teléfono le manda a la API, con muchos usuarios a la vez. Usa el mismo token, la misma huella de dispositivo (`X-Device-Fingerprint`) y el mismo cliente (`okhttp`) que la app de Android. Al cliente le agrega `k6`, así sus trazas quedan separadas (`cliente = k6`) si la API tiene la telemetría encendida.

Cada usuario virtual hace esto en ciclo:
1. Abre **Pacientes**.
2. Abre **Signos vitales** de un paciente al azar.
3. **Guarda** una toma con `clientUuid` y `capturadoEn`, como la cola sin conexión.
4. **Reintenta** la misma toma, como cuando se corta la red antes de recibir la respuesta: debe responder 200 `duplicado`.
5. Hace pausas de 1 a 8 s entre pantallas, como una persona real.

## Criterios de aceptación (umbrales)

| Umbral | Significado |
|---|---|
| `http_req_failed rate<0.01` | Menos de 1 % de errores |
| `http_req_duration p(95)<800` | 95 % de las respuestas en menos de 800 ms |
| `checks rate>0.99` | Las respuestas son las esperadas (200, 201, 200 duplicado) |
| `registros_duplicados count==0` | Ningún reintento crea otra fila |

Si alguno no se cumple, k6 termina con código 99, así que el CI lo marca en rojo.

## Cómo correrla (Windows)

1. Instala k6 (una sola vez):
   ```powershell
   winget install k6 --source winget
   ```
   Cierra y vuelve a abrir PowerShell.

2. Levanta la API local. Antes, en `.env.docker`, sube el límite global, porque todas las peticiones de k6 salen de tu misma IP:
   ```
   RATE_LIMIT_MAX=100000
   ```
   ```powershell
   docker compose up -d --force-recreate
   ```

3. Córrela (con la cuenta de enfermería de tu base local):
   ```powershell
   $env:CORREO = "qa.enfermeria@healthnexus.test"
   $env:CLAVE = "<su contraseña>"
   npm run carga
   ```
   Cambia la carga con `$env:USUARIOS = "50"` y `$env:DURACION = "3m"`. La URL se cambia con `$env:BASE` y por defecto es `http://localhost:3000/api`.

4. Resultados:
   - **Consola:** total de peticiones, latencia p50/p95 por pantalla y ✓/✗ por umbral.
   - **`reports/k6-turno-enfermeria.xml`:** JUnit, un caso por umbral. Lo leen Jenkins y GitHub Actions igual que `junit-api.xml`.
   - **`reports/k6-turno-enfermeria.json`:** todas las métricas.

## Ver la corrida en Grafana Cloud (opcional)

Con la misma cuenta de Grafana Cloud del panel de la API (`observabilidad/README.md`):

1. En Grafana Cloud abre tu stack: **Testing & synthetics → Performance → Configuration** (arriba a la derecha) **→ Access → Personal token**. Copia el token; es un secreto.
2. En PowerShell, una sola vez (`healthnexus` es el nombre de tu stack):
   ```powershell
   k6 cloud login --token <token> --stack healthnexus
   ```
3. Córrela igual que antes, pero con:
   ```powershell
   npm run carga:grafana
   ```
   La carga sigue saliendo de tu computadora hacia tu API local; k6 solo manda los resultados a Grafana, donde quedan las gráficas de cada corrida para compararlas.

El plan gratuito tiene un límite mensual de horas de usuarios virtuales; una corrida de 20 usuarios por 1.5 min gasta muy poco.

## No la corras contra producción

- La API de producción limita las peticiones por minuto por IP, así que verías errores 429 y no medirías la API.
- Guarda registros de signos de prueba en la base real.
- Si de verdad hay que medir producción, hazlo en una ventana acordada, con pocos usuarios, una cuenta de prueba y borrando después los registros con `client_uuid` de la corrida.
