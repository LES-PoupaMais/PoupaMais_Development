// Testes de scripts/conferir-portas.js: só o nginx (e o painel no dev) podem publicar portas, nas esperadas.
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseEsperado, conferir } = require('../scripts/conferir-portas.js');

const config = (services) => ({ services });
const porta = (published, host_ip) => ({ target: 80, published: String(published), ...(host_ip && { host_ip }) });

describe('conferir-portas', () => {
  test('aceita exatamente as portas esperadas, com o IP quando pedido', () => {
    const { erros } = conferir(
      config({ nginx: { ports: [porta(8000), porta(8001, '127.0.0.1')] }, api: {} }),
      parseEsperado(['nginx=8000,127.0.0.1:8001']),
    );
    assert.deepEqual(erros, []);
  });

  test('porta de ferramenta aberta para todas as interfaces falha', () => {
    const { erros } = conferir(config({ nginx: { ports: [porta(8001)] } }), parseEsperado(['nginx=127.0.0.1:8001']));
    assert.equal(erros.length, 1);
  });

  test('serviço fora da lista que publica porta falha (ex.: banco ou API expostos)', () => {
    const { erros } = conferir(
      config({ nginx: { ports: [porta(8000)] }, db: { ports: [porta(5432)] } }),
      parseEsperado(['nginx=8000']),
    );
    assert.deepEqual(erros, ['db publica [5432], esperado []']);
  });

  test('porta esperada que sumiu falha', () => {
    const { erros } = conferir(config({ nginx: { ports: [porta(80)] } }), parseEsperado(['nginx=80,443']));
    assert.equal(erros.length, 1);
  });

  test('argumento sem "=" é recusado', () => {
    assert.throws(() => parseEsperado(['nginx']), /argumento inválido/);
  });
});
