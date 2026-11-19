// Testes do painel (config/painel/server.js). Ele controla o Docker da máquina pelo socket, então o principal é
// provar que só o navegador da própria máquina consegue usá-lo.
//
// Um Docker falso escuta num socket unix temporário: nada aqui toca o Docker de verdade.
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SOCKET = path.join(os.tmpdir(), `painel-docker-falso-${process.pid}.sock`);
process.env.DOCKER_SOCKET = SOCKET;
process.env.APP_PORT = '8100';
process.env.DB_PORT = '5999';

const {
  server,
  isAllowed,
  logRange,
  resolvePublicFile,
  toService,
  createDemuxer,
  createLineSplitter,
} = require('../config/painel/server.js');

const PUBLIC_DIR = path.join(__dirname, '..', 'config', 'painel', 'public');

// ---- Funções puras ----------------------------------------------------------------

describe('isAllowed: só o navegador da própria máquina', () => {
  const req = (method, host, origin) => ({ method, headers: { host, ...(origin && { origin }) } });

  test('leitura (GET) vinda de localhost, 127.0.0.1 ou [::1] passa', () => {
    for (const host of ['localhost:9000', '127.0.0.1:9000', '[::1]:9000', 'localhost']) {
      assert.equal(isAllowed(req('GET', host)), true, host);
    }
  });

  test('Host de outro domínio é barrado (DNS rebinding)', () => {
    for (const host of ['evil.com', 'evil.com:9000', 'localhost.evil.com:9000', '192.168.0.10:9000', '']) {
      assert.equal(isAllowed(req('GET', host)), false, host);
    }
  });

  test('ação (POST) só com Origin igual ao Host (CSRF)', () => {
    assert.equal(isAllowed(req('POST', 'localhost:9000', 'http://localhost:9000')), true);
    assert.equal(isAllowed(req('POST', 'localhost:9000')), false, 'sem Origin');
    assert.equal(isAllowed(req('POST', 'localhost:9000', 'http://evil.com')), false, 'outro site');
    assert.equal(isAllowed(req('POST', 'localhost:9000', 'http://localhost:8000')), false, 'o próprio app (outra porta)');
    assert.equal(isAllowed(req('POST', 'localhost:9000', 'https://localhost:9000')), false, 'outro esquema');
    assert.equal(isAllowed(req('POST', 'localhost:9000', 'null')), false, 'Origin null (sandbox, file://)');
  });
});

describe('logRange: quantas linhas de log pedir ao Docker', () => {
  const range = (query) => logRange(new URLSearchParams(query));

  test('padrão de 300 linhas', () => assert.equal(range(''), 'tail=300'));
  test('tail pedido, limitado a 5000', () => {
    assert.equal(range('tail=50'), 'tail=50');
    assert.equal(range('tail=99999'), 'tail=5000');
    assert.equal(range('tail=2.7'), 'tail=2');
  });
  test('tail inválido, zero ou negativo vira o padrão (negativo traria o log inteiro)', () => {
    for (const tail of ['-5', '0', 'abc', '0.4']) assert.equal(range(`tail=${tail}`), 'tail=300', tail);
  });
  test('since (reconexão) traz tudo desde o instante, em segundos inteiros', () => {
    assert.equal(range('since=1700000000.9&tail=10'), 'since=1700000000&tail=all');
    assert.equal(range('since=-1'), 'tail=300');
  });
});

describe('resolvePublicFile: só arquivos de public/', () => {
  test('raiz serve o index.html e arquivos de public/ resolvem', () => {
    assert.equal(resolvePublicFile('/'), path.join(PUBLIC_DIR, 'index.html'));
    assert.equal(resolvePublicFile('/app.js'), path.join(PUBLIC_DIR, 'app.js'));
  });

  test('caminho que sai de public/ é recusado', () => {
    for (const pathname of ['/../server.js', '/../services.json', '/../../etc/passwd', '/x/../../server.js']) {
      assert.equal(resolvePublicFile(pathname), null, pathname);
    }
  });

  test('pasta irmã com o mesmo prefixo (public-x/) é recusada', () => {
    assert.equal(resolvePublicFile('/../public-x/segredo.txt'), null);
  });
});

describe('toService: dados do container para a página', () => {
  const container = {
    State: 'running',
    Status: 'Up 2 minutes (healthy)',
    Image: 'nginx:1.30-alpine',
    Names: ['/poupamais-nginx-1'],
    Ports: [
      { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8000, Type: 'tcp' },
      { IP: '::', PrivatePort: 80, PublicPort: 8000, Type: 'tcp' },
      { IP: '127.0.0.1', PrivatePort: 5432, PublicPort: 5434, Type: 'tcp' },
      { PrivatePort: 8099, Type: 'tcp' },
    ],
  };

  test('portas publicadas sem duplicar IPv4/IPv6, ordenadas, sem as internas', () => {
    const portas = toService('nginx', {}, container).ports;
    assert.deepEqual(portas.map((p) => p.host), [5434, 8000]);
    assert.equal(portas[0].ip, '127.0.0.1');
  });

  test('estado, saúde e nome do container', () => {
    const s = toService('nginx', { title: 'Nginx' }, container);
    assert.equal(s.title, 'Nginx');
    assert.equal(s.state, 'running');
    assert.equal(s.health, 'healthy');
    assert.equal(s.container, 'poupamais-nginx-1');
  });

  test('saúde "iniciando" e "com falha" vêm do Status do Docker', () => {
    assert.equal(toService('api', {}, { ...container, Status: 'Up 5 seconds (health: starting)' }).health, 'health: starting');
    assert.equal(toService('api', {}, { ...container, Status: 'Up 3 minutes (unhealthy)' }).health, 'unhealthy');
    assert.equal(toService('api', {}, { ...container, Status: 'Up 3 minutes' }).health, null);
  });

  test('serviço sem container aparece como não criado', () => {
    const s = toService('novo', undefined, undefined);
    assert.equal(s.title, 'novo');
    assert.equal(s.created, false);
    assert.equal(s.state, 'missing');
    assert.deepEqual(s.ports, []);
  });
});

describe('logs do Docker', () => {
  // Frame do Docker sem TTY: [stream, 0, 0, 0, tamanho (uint32 BE)] + conteúdo
  const frame = (stream, text) => {
    const body = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  };

  test('separa stdout e stderr, mesmo com o frame partido entre pedaços', () => {
    const recebidos = [];
    const demux = createDemuxer((stream, text) => recebidos.push([stream, text]));
    const dados = Buffer.concat([frame(1, 'olá\n'), frame(2, 'erro\n')]);

    demux(dados.subarray(0, 5));
    assert.deepEqual(recebidos, [], 'cabeçalho incompleto espera o resto');
    demux(dados.subarray(5, 14));
    demux(dados.subarray(14));

    assert.deepEqual(recebidos, [['stdout', 'olá\n'], ['stderr', 'erro\n']]);
  });

  test('junta linhas partidas, separado por stream', () => {
    const linhas = [];
    const split = createLineSplitter((stream, line) => linhas.push([stream, line]));
    split('stdout', 'primeira li');
    split('stderr', 'erro inteiro\n');
    split('stdout', 'nha\nsegunda\nterc');

    assert.deepEqual(linhas, [
      ['stderr', 'erro inteiro'],
      ['stdout', 'primeira linha'],
      ['stdout', 'segunda'],
    ]);
  });
});

// ---- Servidor HTTP contra um Docker falso ------------------------------------------

describe('API do painel', () => {
  const CONTAINERS = [
    { Id: 'id-api', Labels: { 'com.docker.compose.service': 'api' }, Names: ['/a'], State: 'running', Status: 'Up (healthy)', Ports: [] },
    { Id: 'id-painel', Labels: { 'com.docker.compose.service': 'painel' }, Names: ['/p'], State: 'running', Status: 'Up', Ports: [] },
    { Id: 'id-extra', Labels: { 'com.docker.compose.service': 'extra' }, Names: ['/e'], State: 'exited', Status: 'Exited (0)', Ports: [] },
  ];
  const chamadas = [];
  let docker;

  before(async () => {
    fs.rmSync(SOCKET, { force: true });
    docker = http.createServer((req, res) => {
      chamadas.push(`${req.method} ${req.url}`);
      const json = (body) => res.end(JSON.stringify(body));
      if (req.url === `/containers/${os.hostname()}/json`) {
        // O próprio painel: diz de qual projeto compose ele é
        return json({
          Config: { Labels: { 'com.docker.compose.project': 'poupamais', 'com.docker.compose.service': 'painel' } },
        });
      }
      if (req.url.startsWith('/containers/json?')) return json(CONTAINERS);
      if (req.url === '/containers/id-api/json') return json({ Config: { Tty: false } });
      if (req.url.startsWith('/containers/id-api/logs?')) {
        const body = Buffer.from('2026-11-19T10:00:00.000000000Z Started PoupaMaisApplication\n');
        const header = Buffer.alloc(8);
        header[0] = 1;
        header.writeUInt32BE(body.length, 4);
        return res.end(Buffer.concat([header, body]));
      }
      if (req.method === 'POST' && /^\/containers\/id-api\/(start|stop|restart)$/.test(req.url)) {
        res.statusCode = 204;
        return res.end();
      }
      res.statusCode = 404;
      json({ message: 'no such container' });
    });
    await new Promise((resolve) => docker.listen(SOCKET, resolve));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => docker.close(resolve));
    fs.rmSync(SOCKET, { force: true });
  });

  // http.request, e não fetch: o fetch não deixa trocar o Host nem mandar caminhos com ".."
  function pedir(method, caminho, headers = {}) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method, path: caminho, headers: { host: `localhost:${port}`, ...headers } },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }
  const origem = () => ({ origin: `http://localhost:${server.address().port}` });

  test('lista os serviços na ordem do services.json, sem o próprio painel e com os novos no fim', async () => {
    const res = await pedir('GET', '/api/services');
    assert.equal(res.status, 200);
    const dados = JSON.parse(res.body);
    const nomes = dados.services.map((s) => s.name);
    assert.equal(dados.project, 'poupamais');
    assert.deepEqual(nomes, ['nginx', 'front', 'api', 'db', 'mailpit', 'extra']);
    assert.equal(dados.services.find((s) => s.name === 'front').created, false);
    assert.equal(dados.services.find((s) => s.name === 'api').health, 'healthy');
  });

  test('variáveis dos links vêm do ambiente (portas do .env)', async () => {
    const { vars } = JSON.parse((await pedir('GET', '/api/services')).body);
    assert.equal(vars.appPort, '8100');
    assert.equal(vars.dbPort, '5999');
    assert.equal(vars.swaggerPort, '8001');
  });

  test('todo link e cópia do services.json usa só marcadores conhecidos', async () => {
    const { vars, services } = JSON.parse((await pedir('GET', '/api/services')).body);
    const conhecidos = new Set(['host', ...Object.keys(vars)]);
    for (const s of services) {
      for (const texto of [...s.links.map((l) => l.url), ...s.copy.map((c) => c.value)]) {
        for (const [, nome] of texto.matchAll(/\{(\w+)\}/g)) assert.ok(conhecidos.has(nome), `${s.name}: {${nome}}`);
      }
    }
  });

  for (const acao of ['start', 'stop', 'restart']) {
    test(`executa "${acao}" com Origin do próprio painel`, async () => {
      chamadas.length = 0;
      const res = await pedir('POST', `/api/services/api/${acao}`, origem());
      assert.equal(res.status, 200);
      assert.ok(chamadas.includes(`POST /containers/id-api/${acao}`));
    });
  }

  test('ação vinda de outro site é barrada sem chegar ao Docker', async () => {
    chamadas.length = 0;
    const res = await pedir('POST', '/api/services/api/restart', { origin: 'http://evil.com' });
    assert.equal(res.status, 403);
    assert.deepEqual(chamadas, []);
  });

  test('ação sem Origin é barrada sem chegar ao Docker', async () => {
    chamadas.length = 0;
    const res = await pedir('POST', '/api/services/api/stop');
    assert.equal(res.status, 403);
    assert.deepEqual(chamadas, []);
  });

  test('Host de outro domínio é barrado até na leitura (DNS rebinding)', async () => {
    chamadas.length = 0;
    const res = await pedir('GET', '/api/services', { host: 'evil.com' });
    assert.equal(res.status, 403);
    assert.deepEqual(chamadas, []);
  });

  test('ação fora da lista (start, stop, restart) não chega ao Docker', async () => {
    chamadas.length = 0;
    const res = await pedir('POST', '/api/services/api/kill', origem());
    assert.equal(res.status, 404);
    assert.ok(!chamadas.some((c) => c.startsWith('POST')));
  });

  test('o painel não para nem reinicia a si mesmo', async () => {
    for (const acao of ['stop', 'restart']) {
      chamadas.length = 0;
      const res = await pedir('POST', `/api/services/painel/${acao}`, origem());
      assert.equal(res.status, 404, acao);
      assert.ok(!chamadas.some((c) => c.startsWith('POST')), acao);
    }
  });

  test('serviço inexistente responde 404', async () => {
    const res = await pedir('POST', '/api/services/naoexiste/restart', origem());
    assert.equal(res.status, 404);
  });

  test('transmite os logs como eventos (SSE) e avisa quando o stream termina', async () => {
    chamadas.length = 0;
    const res = await pedir('GET', '/api/services/api/logs?tail=-5');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    assert.match(
      res.body,
      /event: line\ndata: {"s":"stdout","t":"2026-11-19T10:00:00.000000000Z","l":"Started PoupaMaisApplication"}/,
    );
    assert.match(res.body, /event: end/);
    assert.ok(chamadas.some((c) => c.includes('/containers/id-api/logs?') && c.endsWith('tail=300')));
  });

  test('não transmite os logs do próprio painel', async () => {
    const res = await pedir('GET', '/api/services/painel/logs');
    assert.equal(res.status, 404);
  });

  test('página servida com CSP que só aceita os scripts do próprio painel', async () => {
    const res = await pedir('GET', '/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  });

  test('não serve arquivos fora de public/ (server.js, services.json)', async () => {
    for (const caminho of ['/..%2fserver.js', '/%2e%2e/server.js', '/../services.json', '/x/../../server.js']) {
      const res = await pedir('GET', caminho);
      assert.equal(res.status, 404, caminho);
      assert.doesNotMatch(res.body, /require\(|"mailpit"/, caminho);
    }
  });
});
