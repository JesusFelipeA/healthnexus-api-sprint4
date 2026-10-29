# Pruebas de la API con Postman

Colección con 47 peticiones y 128 comprobaciones, en 8 carpetas: salud, autenticación y roles (HU-37, CP-33, CP-34), pacientes y triage (HU-38), emergencias (HU-39, CP-32), hospitales (HU-41, CP-30), farmacia (HU-42), cuentas y auditoría (HU-73), y signos vitales (HU-40, Actividad 18). Cada petición comprueba además que la respuesta tarde menos de 3 segundos (CP-38).

> **Solo local o QA.** La colección crea pacientes ficticios y activa una emergencia (que envía notificaciones push). Si `baseUrl` apunta a producción, no envía nada y marca la prueba como fallida.

## Antes de correrla

```powershell
docker compose up -d
docker compose exec api node scripts/crear-usuarios-qa.js
```

## En Postman

1. **Import** → arrastra los dos archivos `.json` de esta carpeta.
2. Arriba a la derecha elige el ambiente **HealthNexus · Local (Docker)**.
3. Clic derecho en la colección → **Run collection** → **Run**. Las peticiones dependen unas de otras (tokens, paciente, emergencia): córrelas en orden.

## En consola, con reporte HTML (evidencia)

```powershell
npx -p newman -p newman-reporter-htmlextra newman run postman\HealthNexus-API.postman_collection.json `
  -e postman\HealthNexus-local.postman_environment.json `
  --reporters cli,htmlextra --reporter-htmlextra-export reporte-api.html
```

`reporte-api.html` queda con el resultado de cada prueba y sus tiempos: sirve como evidencia del plan de pruebas.

## Límites de la API

- Cada ejecución hace 3 intentos de login fallidos a propósito; la API acepta 20 por IP cada 15 minutos (unas 6 ejecuciones seguidas).
- Cada usuario puede activar 3 emergencias por minuto; espera un minuto si repites la colección de inmediato.
