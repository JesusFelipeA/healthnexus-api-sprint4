#!/usr/bin/env bash
# Sube (o actualiza) las variables de un archivo .env a AWS SSM Parameter Store como SecureString.
# Se usa una vez para migrar, y cada vez que rotes un secreto.
#   Uso:  ./scripts/subir-secretos-ssm.sh prod .env.rds
# Necesita credenciales con permiso ssm:PutParameter sobre /healthnexus/<ambiente>/* (tu usuario de IAM, no el rol del servidor).
# Nunca imprime valores.
set -euo pipefail

AMBIENTE="${1:-}"; ORIGEN="${2:-}"
if [[ ! "$AMBIENTE" =~ ^(dev|qa|prod)$ || ! -f "$ORIGEN" ]]; then
  echo "Uso: $0 <dev|qa|prod> <archivo .env existente>" >&2; exit 2
fi
REGION="${AWS_REGION:-us-east-2}"

n=0
while IFS= read -r linea || [[ -n "$linea" ]]; do
  linea="${linea%$'\r'}"
  [[ -z "$linea" || "$linea" =~ ^[[:space:]]*# || "$linea" != *=* ]] && continue
  nombre="${linea%%=*}"; valor="${linea#*=}"
  [[ "$nombre" =~ ^[A-Z_][A-Z0-9_]*$ ]] || { echo "Se omite una línea con nombre inválido: ${nombre}" >&2; continue; }
  [[ -z "$valor" ]] && { echo "Se omite ${nombre} (vacío)"; continue; }
  aws ssm put-parameter --region "$REGION" --name "/healthnexus/${AMBIENTE}/${nombre}" \
    --type SecureString --overwrite --value "$valor" --no-cli-pager > /dev/null
  echo "  ✔ /healthnexus/${AMBIENTE}/${nombre}"
  n=$((n + 1))
done < "$ORIGEN"
echo "${n} parámetro(s) guardados en /healthnexus/${AMBIENTE}/ (región ${REGION})."
