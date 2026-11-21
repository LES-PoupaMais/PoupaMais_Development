#!/bin/sh
# Confere a configuração dos três modos sem subir nada: "docker compose config -q", portas publicadas
# (scripts/conferir-portas.js) e "nginx -t" dos templates de dev e de produção. Usado pelo CI e por "npm run config".
# Confere as portas padrão (ignora o .env local).
set -eu
cd "$(dirname "$0")/.."

# Ignora o .env local: confere os padrões versionados
export COMPOSE_ENV_FILES=/dev/null
PROD="-f docker-compose.yml -f docker-compose.prod.yml"
E2E="-f docker-compose.e2e.yml"
NGINX_IMAGE=nginx:1.30-alpine

echo "== dev: compose"
docker compose config -q
docker compose config --format json | node scripts/conferir-portas.js \
  nginx=8000,127.0.0.1:8001,127.0.0.1:8002,127.0.0.1:5434 painel=127.0.0.1:9000

echo "== prod: compose"
# shellcheck disable=SC2086
docker compose $PROD config -q
# shellcheck disable=SC2086
docker compose $PROD config --format json | node scripts/conferir-portas.js nginx=8480,8443,127.0.0.1:8402

echo "== e2e: compose"
# shellcheck disable=SC2086
docker compose $E2E config -q
# shellcheck disable=SC2086
docker compose $E2E config --format json | node scripts/conferir-portas.js \
  db=127.0.0.1:5435 mailpit=127.0.0.1:8525 api=127.0.0.1:8580

echo "== dev: nginx -t"
docker run --rm -e NGINX_ENVSUBST_FILTER=^PORTA_ -e PORTA_SWAGGER=8001 \
  -v "$PWD/config/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v "$PWD/config/nginx/snippets:/etc/nginx/snippets:ro" \
  -v "$PWD/config/nginx/dev:/etc/nginx/templates:ro" \
  -v "$PWD/config/nginx/stream-dev:/etc/nginx/stream.d:ro" \
  "$NGINX_IMAGE" nginx -t

echo "== prod: nginx -t"
# Certificado descartável só para o nginx -t carregar o bloco HTTPS (não mexe em certs/)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
openssl req -x509 -nodes -newkey rsa:2048 -days 1 -subj /CN=ci \
  -keyout "$TMP/poupamais.key" -out "$TMP/poupamais.crt" 2>/dev/null
chmod 644 "$TMP/poupamais.key"
docker run --rm -e NGINX_ENVSUBST_FILTER=^PORTA_ -e PORTA_HTTPS=8443 \
  -v "$PWD/config/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v "$PWD/config/nginx/snippets:/etc/nginx/snippets:ro" \
  -v "$PWD/config/nginx/prod:/etc/nginx/templates:ro" \
  -v "$TMP:/etc/nginx/certs:ro" \
  "$NGINX_IMAGE" nginx -t

echo "Configuração OK"
