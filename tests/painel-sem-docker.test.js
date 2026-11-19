// Painel sem acesso ao Docker (socket inexistente ou sem permissão): a página tem de dizer o motivo, e não
// responder um erro genérico. Arquivo separado porque o caminho do socket é lido quando o módulo carrega.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

process.env.DOCKER_SOCKET = path.join(os.tmpdir(), `painel-sem-docker-${process.pid}.sock`);

const { server } = require('../config/painel/server.js');

let base;
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('sem o socket do Docker responde 500 dizendo onde procurou', async () => {
  const res = await fetch(`${base}/api/services`);
  assert.equal(res.status, 500);
  const { error } = await res.json();
  assert.match(error, /Sem acesso ao Docker em .*painel-sem-docker-\d+\.sock \(ENOENT\)/);
});

test('a página continua sendo servida, para mostrar o erro', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
});
