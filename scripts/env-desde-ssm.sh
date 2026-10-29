#!/usr/bin/env bash
# Arma el archivo de variables de un ambiente a partir de AWS SSM Parameter Store.
# Los secretos viven cifrados en /healthnexus/<ambiente>/<VARIABLE> y el archivo se crea con permisos 600.
#   Uso (en el servidor):  ./scripts/env-desde-ssm.sh prod .env.rds
#                          ./scripts/env-desde-ssm.sh qa   .env.qa
# Requiere AWS CLI v2 (viene en Amazon Linux 2023) y un rol de IAM en la instancia (deploy/iam-healthnexus-ssm.json).
# Nunca imprime valores, solo los nombres de las variables.
set -euo pipefail

AMBIENTE="${1:-}"; DESTINO="${2:-}"
if [[ ! "$AMBIENTE" =~ ^(dev|qa|prod)$ || -z "$DESTINO" ]]; then
  echo "Uso: $0 <dev|qa|prod> <archivo destino>   ej. $0 prod .env.rds" >&2; exit 2
fi
REGION="${AWS_REGION:-us-east-2}"
RUTA="/healthnexus/${AMBIENTE}/"

umask 077
TMP="$(mktemp "${DESTINO}.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

aws ssm get-parameters-by-path --region "$REGION" --path "$RUTA" --recursive --with-decryption \
  --query 'Parameters[*].[Name,Value]' --output text \
| while IFS=$'\t' read -r nombre valor; do
    printf '%s=%s\n' "${nombre##*/}" "$valor"
  done > "$TMP"

FALTAN=()
for v in DB_HOST DB_NAME DB_USER DB_PASS JWT_SECRET; do
  grep -q "^${v}=" "$TMP" || FALTAN+=("$v")
done
if (( ${#FALTAN[@]} )); then
  echo "Faltan en ${RUTA}: ${FALTAN[*]}. No se modificó ${DESTINO}." >&2; exit 1
fi

[[ -f "$DESTINO" ]] && cp -p "$DESTINO" "${DESTINO}.anterior"
chmod 600 "$TMP"
mv "$TMP" "$DESTINO"
trap - EXIT
echo "Escrito ${DESTINO} (permisos 600) con: $(cut -d= -f1 "$DESTINO" | tr '\n' ' ')"
[[ -f "${DESTINO}.anterior" ]] && echo "Copia del archivo anterior: ${DESTINO}.anterior (bórrala cuando confirmes que todo funciona)"
