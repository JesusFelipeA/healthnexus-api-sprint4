#!/usr/bin/env bash
# Despliega en el EC2 un commit de main y, si la API no responde sana, regresa sola a la versión anterior.
# Lo llama GitHub Actions por AWS SSM (.github/workflows/deploy.yml) como el usuario ec2-user, desde la carpeta
# del repo. También se puede correr a mano:
#   cd ~/healthnexus-api-docker && git fetch origin main && bash scripts/desplegar.sh "$(git rev-parse origin/main)"
# Nunca imprime secretos: solo nombres de variables, commits y el resultado de /api/health.
set -euo pipefail

SHA="${1:-}"
if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Uso: $0 <sha de 40 caracteres de un commit de main>" >&2; exit 2
fi
CORTO="${SHA:0:7}"
ARCHIVO_ENV=".env.rds"
SALUD_URL="http://127.0.0.1:3000/api/health"
INTENTOS_SALUD="${INTENTOS_SALUD:-24}"     # 24 x 5 s = 2 minutos
ESPERA_SALUD="${ESPERA_SALUD:-5}"
COMPOSE=(docker compose -f docker-compose.rds.yml --env-file "$ARCHIVO_ENV")

paso() { printf '\n==> %s\n' "$*"; }
falla() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# Un solo despliegue a la vez (dos merges seguidos no se pisan)
exec 9>/tmp/healthnexus-despliegue.lock
flock -n 9 || falla "Ya hay otro despliegue en curso."

[[ -f docker-compose.rds.yml ]] || falla "Corre el script desde la carpeta del repo (no está docker-compose.rds.yml)."
[[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] || falla "El servidor no está en la rama main."
if ! git diff --quiet || ! git diff --cached --quiet; then
  falla "Hay cambios sin commit en el servidor. Revísalos con 'git status' antes de desplegar."
fi
git cat-file -e "${SHA}^{commit}" 2>/dev/null || falla "El commit ${CORTO} no existe aquí: falta 'git fetch origin main'."
git merge-base --is-ancestor "$SHA" origin/main || falla "El commit ${CORTO} no está en origin/main."

ANTERIOR="$(git rev-parse HEAD)"
IMAGEN_ANTERIOR="$(docker inspect -f '{{.Image}}' healthnexus-api 2>/dev/null || true)"
paso "Versión en línea: ${ANTERIOR:0:7} · versión nueva: ${CORTO}"

codigo_salud() { curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$SALUD_URL" 2>/dev/null || true; }

# Lo normal es exigir 200. Si antes de desplegar la API ya respondía 503 porque la base no está disponible
# (el RDS se apaga de noche junto con la web), basta con que la versión nueva arranque y responda ese mismo 503.
ESPERADO=200
if [[ "$(codigo_salud)" == "503" ]]; then
  ESPERADO=503
  echo "   AVISO: la base de datos no responde ahora (¿RDS apagado?). Solo se revisará que la API arranque."
fi

salud() {
  local i codigo
  for ((i = 1; i <= INTENTOS_SALUD; i++)); do
    codigo="$(codigo_salud)"
    if [[ "$codigo" == "200" || ( "$ESPERADO" == "503" && "$codigo" == "503" ) ]]; then
      echo "   /api/health respondió ${codigo} (intento ${i})"; return 0
    fi
    sleep "$ESPERA_SALUD"
  done
  echo "   /api/health no respondió ${ESPERADO} en $((INTENTOS_SALUD * ESPERA_SALUD)) s (último código: ${codigo:-ninguno})"
  return 1
}

# Vuelve al commit, a las variables y a la imagen que estaban antes
revertir() {
  paso "Regresando a ${ANTERIOR:0:7}"
  git reset -q --keep "$ANTERIOR"
  [[ -f "${ARCHIVO_ENV}.anterior" ]] && cp -p "${ARCHIVO_ENV}.anterior" "$ARCHIVO_ENV"
  if [[ -n "$IMAGEN_ANTERIOR" ]]; then
    docker tag "$IMAGEN_ANTERIOR" healthnexus-api:anterior
    TAG=anterior "${COMPOSE[@]}" up -d --no-build
    if salud; then echo "   La versión anterior quedó en línea."; else echo "   ATENCIÓN: la versión anterior tampoco responde. Revisa 'docker logs healthnexus-api'." >&2; fi
  fi
}

paso "Actualizando el código"
git merge --ff-only -q "$SHA"

paso "Variables desde AWS SSM"
if ! bash scripts/env-desde-ssm.sh prod "$ARCHIVO_ENV"; then
  [[ -f "$ARCHIVO_ENV" ]] || { git reset -q --keep "$ANTERIOR"; falla "No se pudo leer SSM y no existe ${ARCHIVO_ENV}."; }
  echo "   AVISO: no se pudo leer SSM; se usa el ${ARCHIVO_ENV} que ya estaba en el servidor."
  rm -f "${ARCHIVO_ENV}.anterior"
fi

paso "Compilando la imagen healthnexus-api:${CORTO}"
if ! TAG="$CORTO" "${COMPOSE[@]}" build --quiet api; then
  # La API en línea no se tocó: solo se regresa el código y las variables
  git reset -q --keep "$ANTERIOR"
  [[ -f "${ARCHIVO_ENV}.anterior" ]] && cp -p "${ARCHIVO_ENV}.anterior" "$ARCHIVO_ENV"
  falla "La imagen no compiló; la API sigue con la versión ${ANTERIOR:0:7}."
fi

paso "Levantando la versión nueva"
TAG="$CORTO" "${COMPOSE[@]}" up -d --no-build

paso "Revisando /api/health"
if ! salud; then
  echo "   Últimas líneas del log de la API:"
  docker logs --tail 30 healthnexus-api 2>&1 | sed 's/^/   | /' || true
  revertir
  falla "La versión ${CORTO} no pasó la revisión de salud; se regresó a ${ANTERIOR:0:7}."
fi

# 'latest' = lo que está en línea, para que un 'docker compose up' manual levante lo mismo
docker tag "healthnexus-api:${CORTO}" healthnexus-api:latest

paso "Limpieza de imágenes viejas (se conservan la actual y la anterior)"
CONSERVAR="${CORTO} latest anterior ${ANTERIOR:0:7}"
docker images healthnexus-api --format '{{.Tag}}' | while read -r tag; do
  [[ " $CONSERVAR " == *" $tag "* || "$tag" == "<none>" ]] || docker rmi -f "healthnexus-api:${tag}" >/dev/null 2>&1 || true
done
docker image prune -f >/dev/null 2>&1 || true

paso "Listo: ${CORTO} en línea"
