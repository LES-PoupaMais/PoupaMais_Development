// Confere as portas que um modo publica no host, a partir do "docker compose config --format json" (stdin).
//
// Uso: docker compose config --format json | node scripts/conferir-portas.js nginx=8000,127.0.0.1:8001 painel=127.0.0.1:9000
//
// Cada argumento é "serviço=porta[,porta…]"; uma porta com IP ("127.0.0.1:8001") exige que ela esteja presa a
// esse IP. Serviço que publica porta sem estar na lista falha: só o nginx (e o painel no dev) podem expor algo.
// O Compose soma as listas de portas de todos os arquivos (-f): uma porta posta no docker-compose.yml base
// vazaria para todos os modos, e é isso que este script pega.
'use strict';

function parseEsperado(args) {
  const esperado = {};
  for (const arg of args) {
    const [servico, lista] = arg.split('=');
    if (!servico || lista === undefined) throw new Error(`argumento inválido: "${arg}" (use serviço=porta,porta)`);
    esperado[servico] = lista ? lista.split(',').sort() : [];
  }
  return esperado;
}

// Portas publicadas por serviço, no formato dos argumentos ("8000" ou "127.0.0.1:8001")
function portasPublicadas(config) {
  const publicadas = {};
  for (const [nome, servico] of Object.entries(config.services ?? {})) {
    const portas = (servico.ports ?? [])
      .filter((p) => p.published)
      .map((p) => (p.host_ip && p.host_ip !== '0.0.0.0' ? `${p.host_ip}:${p.published}` : String(p.published)));
    if (portas.length) publicadas[nome] = portas.sort();
  }
  return publicadas;
}

function conferir(config, esperado) {
  const publicadas = portasPublicadas(config);
  const erros = [];
  for (const nome of new Set([...Object.keys(publicadas), ...Object.keys(esperado)])) {
    const tem = publicadas[nome] ?? [];
    const quer = esperado[nome] ?? [];
    if (JSON.stringify(tem) !== JSON.stringify(quer)) {
      erros.push(`${nome} publica [${tem.join(', ')}], esperado [${quer.join(', ')}]`);
    }
  }
  return { publicadas, erros };
}

if (require.main === module) {
  let entrada = '';
  process.stdin.on('data', (c) => (entrada += c));
  process.stdin.on('end', () => {
    try {
      const { publicadas, erros } = conferir(JSON.parse(entrada), parseEsperado(process.argv.slice(2)));
      if (erros.length) {
        for (const erro of erros) console.error(erro);
        process.exit(1);
      }
      for (const [nome, portas] of Object.entries(publicadas)) console.log(`${nome} publica [${portas.join(', ')}]`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });
}

module.exports = { parseEsperado, portasPublicadas, conferir };
