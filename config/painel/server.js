// Painel de desenvolvimento do PoupaMais.
// Lista os containers do projeto compose, mostra status, saúde, portas e links, executa iniciar/parar/reiniciar
// e transmite os logs ao vivo (SSE), falando direto com a API do Docker pelo socket. Sem dependências externas.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.PORT || 9000);
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SERVICES = JSON.parse(fs.readFileSync(path.join(__dirname, 'services.json'), 'utf8'));
const ACTIONS = new Set(['start', 'stop', 'restart']);

// Valores dos marcadores {nome} do services.json ({host} o navegador resolve com o próprio endereço)
const VARS = {
  appPort: process.env.APP_PORT || '8000',
  swaggerPort: process.env.SWAGGER_PORT || '8001',
  mailpitPort: process.env.MAILPIT_PORT || '8002',
  dbPort: process.env.DB_PORT || '5434',
  dbUser: process.env.DB_USER || 'poupamais',
  dbPassword: process.env.DB_PASSWORD || 'poupamais',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// --- API do Docker ------------------------------------------------------------

function dockerRequest(method, apiPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCKET, path: apiPath, method }, resolve);
    req.on('error', reject);
    req.end();
  });
}

async function dockerJson(method, apiPath) {
  const res = await dockerRequest(method, apiPath);
  let body = '';
  for await (const chunk of res) body += chunk;
  if (res.statusCode >= 400) {
    let message = `HTTP ${res.statusCode}`;
    try {
      message = JSON.parse(body).message ?? message;
    } catch {
      // corpo que não é JSON: fica o status
    }
    throw Object.assign(new Error(message), { status: res.statusCode });
  }
  return body ? JSON.parse(body) : null;
}

// O projeto compose é o do próprio container do painel (hostname = id do container)
let projectPromise;
function getProject() {
  projectPromise ??= dockerJson('GET', `/containers/${os.hostname()}/json`)
    .then((self) => ({
      name: self.Config.Labels['com.docker.compose.project'],
      self: self.Config.Labels['com.docker.compose.service'],
    }))
    .catch((err) => {
      projectPromise = undefined;
      throw err;
    });
  return projectPromise;
}

async function listContainers() {
  const project = await getProject();
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project.name}`] }));
  const containers = await dockerJson('GET', `/containers/json?all=1&filters=${filters}`);
  return { project, containers };
}

// Container de um serviço do projeto; o próprio painel nunca é devolvido (não para nem reinicia a si mesmo)
async function findContainer(service) {
  const { project, containers } = await listContainers();
  if (service === project.self) return null;
  return containers.find((c) => c.Labels['com.docker.compose.service'] === service) ?? null;
}

function toService(name, meta, container) {
  const ports = (container?.Ports ?? [])
    .filter((p) => p.PublicPort)
    // IPv4 e IPv6 aparecem duplicados
    .filter((p, i, all) => all.findIndex((o) => o.PublicPort === p.PublicPort && o.Type === p.Type) === i)
    .map((p) => ({ host: p.PublicPort, container: p.PrivatePort, protocol: p.Type, ip: p.IP }))
    .sort((a, b) => a.host - b.host);

  return {
    name,
    title: meta?.title ?? name,
    description: meta?.description ?? '',
    links: meta?.links ?? [],
    copy: meta?.copy ?? [],
    created: Boolean(container),
    state: container?.State ?? 'missing',
    status: container?.Status ?? 'Container não criado',
    health: container?.Status?.match(/\((healthy|unhealthy|health: starting)\)/)?.[1] ?? null,
    image: container?.Image ?? null,
    container: container?.Names?.[0]?.replace(/^\//, '') ?? null,
    ports,
  };
}

async function getServices() {
  const { project, containers } = await listContainers();
  const byService = new Map(containers.map((c) => [c.Labels['com.docker.compose.service'], c]));
  byService.delete(project.self);

  // Ordem do services.json primeiro, depois qualquer serviço novo que não esteja lá
  const names = [...Object.keys(SERVICES), ...[...byService.keys()].filter((n) => !(n in SERVICES))];
  return {
    project: project.name,
    vars: VARS,
    services: names.map((n) => toService(n, SERVICES[n], byService.get(n))),
  };
}

// --- Logs (SSE) ---------------------------------------------------------------

// Sem TTY o Docker multiplexa stdout/stderr em frames: [stream, 0, 0, 0, tamanho (uint32 BE)] + conteúdo
function createDemuxer(onChunk) {
  let buffer = Buffer.alloc(0);
  return (data) => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 8) {
      const size = buffer.readUInt32BE(4);
      if (buffer.length < 8 + size) break;
      onChunk(buffer[0] === 2 ? 'stderr' : 'stdout', buffer.subarray(8, 8 + size).toString('utf8'));
      buffer = buffer.subarray(8 + size);
    }
  };
}

function createLineSplitter(onLine) {
  const pending = { stdout: '', stderr: '' };
  return (stream, text) => {
    const lines = (pending[stream] + text).split('\n');
    pending[stream] = lines.pop();
    for (const line of lines) onLine(stream, line);
  };
}

async function streamLogs(service, range, req, res) {
  const container = await findContainer(service);
  if (!container) return sendJson(res, 404, { error: `Serviço "${service}" não encontrado` });

  const info = await dockerJson('GET', `/containers/${container.Id}/json`);
  const logs = await dockerRequest(
    'GET',
    `/containers/${container.Id}/logs?follow=1&stdout=1&stderr=1&timestamps=1&${range}`,
  );

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const split = createLineSplitter((stream, raw) => {
    const match = raw.match(/^(\S+Z) (.*)$/s);
    send('line', { s: stream, t: match?.[1] ?? null, l: match ? match[2] : raw });
  });
  const onData = info.Config.Tty ? (data) => split('stdout', data.toString('utf8')) : createDemuxer(split);

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  logs.on('data', onData);
  // O stream do Docker termina quando o container para ou reinicia
  logs.on('end', () => {
    clearInterval(keepAlive);
    send('end', {});
    res.end();
  });
  req.on('close', () => {
    clearInterval(keepAlive);
    logs.destroy();
  });
}

// since (unix, segundos): reconexão, traz tudo desde então; senão as últimas "tail" linhas, entre 1 e 5000.
// tail inválido, zero ou negativo vira o padrão: o Docker trataria um negativo como "o log inteiro"
function logRange(searchParams) {
  const since = Number(searchParams.get('since'));
  if (since > 0) return `since=${Math.floor(since)}&tail=all`;
  const tail = Math.floor(Number(searchParams.get('tail')));
  return `tail=${tail >= 1 ? Math.min(tail, 5000) : 300}`;
}

// --- HTTP ---------------------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Arquivo dentro de public/, ou null se o caminho sair dela. Compara pelo caminho relativo: um startsWith no
// prefixo aceitaria uma pasta irmã com o mesmo começo (ex.: public-x/)
function resolvePublicFile(pathname) {
  const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  const relative = path.relative(PUBLIC_DIR, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? file : null;
}

function serveStatic(pathname, res) {
  const file = resolvePublicFile(pathname);
  if (!file) return sendJson(res, 404, { error: 'Não encontrado' });
  fs.readFile(file, (err, content) => {
    if (err) return sendJson(res, 404, { error: 'Não encontrado' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      // Só scripts e estilos do próprio painel: a página chama a API que controla o Docker
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(content);
  });
}

// Protege a API (que controla o Docker) de outros sites abertos no navegador:
// Host fora de localhost barra DNS rebinding; Origin diferente nas ações barra CSRF
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function isAllowed(req) {
  const host = req.headers.host ?? '';
  if (!LOCAL_HOST.test(host)) return false;
  return req.method === 'GET' || req.headers.origin === `http://${host}`;
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendJson(res, 400, { error: 'URL inválida' });
  }
  if (!isAllowed(req)) return sendJson(res, 403, { error: 'Proibido' });
  try {
    if (req.method === 'GET' && url.pathname === '/api/services') {
      return sendJson(res, 200, await getServices());
    }

    const logsMatch = url.pathname.match(/^\/api\/services\/([\w.-]+)\/logs$/);
    if (req.method === 'GET' && logsMatch) {
      return await streamLogs(logsMatch[1], logRange(url.searchParams), req, res);
    }

    const actionMatch = url.pathname.match(/^\/api\/services\/([\w.-]+)\/(\w+)$/);
    if (req.method === 'POST' && actionMatch && ACTIONS.has(actionMatch[2])) {
      const [, service, action] = actionMatch;
      const container = await findContainer(service);
      if (!container) return sendJson(res, 404, { error: `Serviço "${service}" não encontrado` });
      await dockerJson('POST', `/containers/${container.Id}/${action}`);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      return serveStatic(url.pathname, res);
    }
    sendJson(res, 404, { error: 'Não encontrado' });
  } catch (err) {
    console.error(`[painel] ${req.method} ${url.pathname}:`, err.message);
    if (res.headersSent) return res.end();
    const unreachable = err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'ECONNREFUSED';
    sendJson(res, err.status ?? 500, {
      error: unreachable ? `Sem acesso ao Docker em ${DOCKER_SOCKET} (${err.code})` : err.message,
    });
  }
});

// Só abre a porta quando executado (node server.js); os testes importam as funções sem subir o servidor
if (require.main === module) {
  server.listen(PORT, () => console.log(`[painel] painel de desenvolvimento em http://localhost:${PORT}`));

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.closeAllConnections();
      server.close(() => process.exit(0));
    });
  }
}

module.exports = {
  server,
  isAllowed,
  logRange,
  resolvePublicFile,
  toService,
  createDemuxer,
  createLineSplitter,
};
