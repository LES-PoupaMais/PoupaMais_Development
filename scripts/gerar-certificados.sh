#!/bin/sh
# Gera o HTTPS local do modo "como produção" em certs/ (fora do git):
#   poupamais-ca.crt / .key -> autoridade certificadora local, autoassinada. É ESTE arquivo (.crt) que se instala
#                              como confiável no Windows/WSL (ver README). Reaproveitada nas próximas execuções.
#   poupamais.crt / .key    -> certificado do nginx (poupamais.localhost, localhost, 127.0.0.1, ::1), assinado pela CA.
# Uso: sh scripts/gerar-certificados.sh [--forcar]   (--forcar refaz o certificado do nginx; a CA continua a mesma)
set -eu

DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
DIAS_CA=3650
# Navegadores recusam certificados de servidor com validade acima de 398 dias
DIAS_SERVIDOR=397

command -v openssl >/dev/null 2>&1 || { echo "openssl não encontrado" >&2; exit 1; }
mkdir -p "$DIR"
cd "$DIR"

if [ ! -f poupamais-ca.key ] || [ ! -f poupamais-ca.crt ]; then
  echo "Gerando a CA local (certs/poupamais-ca.crt)…"
  openssl req -x509 -new -nodes -newkey rsa:2048 -sha256 -days "$DIAS_CA" \
    -subj "/O=PoupaMais (desenvolvimento)/CN=PoupaMais CA local" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout poupamais-ca.key -out poupamais-ca.crt 2>/dev/null
  rm -f poupamais.crt poupamais.key
fi

# Refaz o do servidor se faltar, se for pedido ou se vencer em menos de 30 dias
if [ "${1:-}" = "--forcar" ] || [ ! -f poupamais.crt ] || [ ! -f poupamais.key ] \
  || ! openssl x509 -in poupamais.crt -noout -checkend 2592000 >/dev/null 2>&1; then
  echo "Gerando o certificado do nginx (certs/poupamais.crt)…"
  cat > poupamais.ext <<'EXT'
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:poupamais.localhost, DNS:localhost, IP:127.0.0.1, IP:::1
EXT
  openssl req -new -nodes -newkey rsa:2048 -subj "/CN=poupamais.localhost" \
    -keyout poupamais.key -out poupamais.csr 2>/dev/null
  openssl x509 -req -in poupamais.csr -CA poupamais-ca.crt -CAkey poupamais-ca.key -CAcreateserial \
    -days "$DIAS_SERVIDOR" -sha256 -extfile poupamais.ext -out poupamais.crt 2>/dev/null
  rm -f poupamais.csr poupamais.ext poupamais-ca.srl
  # O nginx lê a chave como root (processo mestre); 644 evita problema de dono no bind mount
  chmod 644 poupamais.key
fi

openssl verify -CAfile poupamais-ca.crt poupamais.crt >/dev/null
echo "Certificados em certs/: confie em certs/poupamais-ca.crt (ver README, seção HTTPS local)."
