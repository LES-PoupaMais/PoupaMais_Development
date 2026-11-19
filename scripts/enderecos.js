// Mostra os endereços de um modo depois do "npm run dev" / "npm run prod", com as portas do .env (se houver).
// Uso: node scripts/enderecos.js dev|prod|e2e
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function lerEnv(arquivo) {
  const env = {};
  let texto = '';
  try {
    texto = fs.readFileSync(arquivo, 'utf8');
  } catch {
    return env;
  }
  for (const linha of texto.split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

function enderecos(modo, env) {
  // Mesma precedência do Compose: variável do shell vence o .env
  const v = (nome, padrao) => process.env[nome] || env[nome] || padrao;
  if (modo === 'dev') {
    return [
      ['App', `http://localhost:${v('APP_PORT', '8000')}`],
      ['Painel', `http://localhost:${v('PAINEL_PORT', '9000')}`],
      ['Swagger', `http://localhost:${v('SWAGGER_PORT', '8001')}/swagger-ui.html`],
      ['Mailpit', `http://localhost:${v('MAILPIT_PORT', '8002')}`],
      ['Postgres', `localhost:${v('DB_PORT', '5434')} (banco poupamais)`],
    ];
  }
  if (modo === 'prod') {
    return [
      ['App (HTTPS)', `https://${v('PROD_HOST', 'poupamais.localhost')}:${v('PROD_HTTPS_PORT', '8443')}`],
      ['HTTP (redireciona)', `http://localhost:${v('PROD_HTTP_PORT', '8480')}`],
      ['Mailpit', `http://localhost:${v('PROD_MAILPIT_PORT', '8402')}`],
    ];
  }
  if (modo === 'e2e') {
    return [
      ['API', `http://localhost:${v('E2E_API_PORT', '8580')}`],
      ['Mailpit', `http://localhost:${v('E2E_MAILPIT_PORT', '8525')}`],
      ['Postgres', `localhost:${v('E2E_DB_PORT', '5435')}`],
    ];
  }
  throw new Error(`modo desconhecido: ${modo} (use dev, prod ou e2e)`);
}

if (require.main === module) {
  const lista = enderecos(process.argv[2], lerEnv(path.join(__dirname, '..', '.env')));
  const largura = Math.max(...lista.map(([nome]) => nome.length));
  console.log('');
  for (const [nome, url] of lista) console.log(`  ${nome.padEnd(largura)}  ${url}`);
  console.log('');
}

module.exports = { lerEnv, enderecos };
