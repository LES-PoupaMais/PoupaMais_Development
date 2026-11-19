'use strict';

const ATUALIZAR_MS = 3000;
const RECONECTAR_MS = 3000;
const MAX_LINHAS = 3000;

const ESTADOS = {
  running: 'rodando',
  restarting: 'reiniciando',
  exited: 'parado',
  created: 'criado',
  paused: 'pausado',
  dead: 'morto',
  removing: 'removendo',
  missing: 'não criado',
};
const SAUDE = { healthy: 'saudável', unhealthy: 'com falha', 'health: starting': 'iniciando' };

const $ = (id) => document.getElementById(id);
const el = {
  projeto: $('projeto'),
  resumo: $('resumo'),
  atualizado: $('atualizado'),
  erro: $('erro'),
  servicos: $('servicos'),
  modelo: $('modelo-cartao'),
  abas: $('abas'),
  status: $('logs-status'),
  saida: $('saida'),
  filtro: $('filtro'),
  seguir: $('seguir'),
  quebrar: $('quebrar'),
  limpar: $('limpar'),
  toast: $('toast'),
};

const cartoes = new Map();
let servicos = [];
let vars = {};

const guardado = {
  ler(chave) {
    try {
      return localStorage.getItem(chave);
    } catch {
      return null;
    }
  },
  gravar(chave, valor) {
    try {
      localStorage.setItem(chave, valor);
    } catch {
      // sem storage (aba privada etc.): só não lembra a preferência
    }
  },
};

// {host} vira o endereço desta página; os outros marcadores vêm do servidor (portas do .env)
const preencher = (modelo) =>
  modelo.replace(/\{(\w+)\}/g, (inteiro, nome) => (nome === 'host' ? location.hostname : (vars[nome] ?? inteiro)));

function tom(s) {
  if (s.state === 'running') {
    if (s.health === 'unhealthy') return 'ruim';
    if (s.health === 'health: starting') return 'alerta';
    return 'ok';
  }
  if (s.state === 'restarting' || s.state === 'paused') return 'alerta';
  if (s.state === 'dead' || /Exited \((?!0\))/.test(s.status)) return 'ruim';
  return 'parado';
}

function rotuloEstado(s) {
  const rotulo = ESTADOS[s.state] ?? s.state;
  return s.health ? `${rotulo} · ${SAUDE[s.health] ?? s.health}` : rotulo;
}

// --- Serviços -------------------------------------------------------------------

function criarCartao(s) {
  const cartao = el.modelo.content.firstElementChild.cloneNode(true);
  cartao.querySelector('h2').textContent = s.title;
  cartao.querySelector('.nome').textContent = s.name;
  cartao.querySelector('.descricao').textContent = s.description;

  const links = cartao.querySelector('.links');
  for (const link of s.links) {
    const url = preencher(link.url);
    links.append(
      Object.assign(document.createElement('a'), {
        className: 'link',
        href: url,
        target: '_blank',
        rel: 'noopener',
        textContent: `${link.label} ↗`,
        title: url,
      }),
    );
  }
  for (const item of s.copy) {
    const valor = preencher(item.value);
    const botao = Object.assign(document.createElement('button'), {
      className: 'link',
      type: 'button',
      textContent: `${item.label} ⧉`,
      title: `Copiar ${valor}`,
    });
    botao.addEventListener('click', () => copiar(valor, botao));
    links.append(botao);
  }

  cartao.querySelector('[data-acao="logs"]').addEventListener('click', () => escolherLogs(s.name));
  cartao.querySelector('[data-acao="restart"]').addEventListener('click', (e) => executar(s.name, 'restart', e.currentTarget));
  cartao.querySelector('[data-acao="alternar"]').addEventListener('click', (e) => {
    const atual = servicos.find((x) => x.name === s.name);
    executar(s.name, atual?.state === 'running' ? 'stop' : 'start', e.currentTarget);
  });
  return cartao;
}

function atualizarCartao(cartao, s) {
  cartao.dataset.tom = tom(s);
  cartao.classList.toggle('selecionado', s.name === logs.servico);
  cartao.querySelector('.estado').textContent = rotuloEstado(s);
  cartao.querySelector('.status').textContent = s.created
    ? `${s.status} · ${s.image}`
    : `Rode "docker compose up -d ${s.name}" para criar`;

  const portas = cartao.querySelector('.portas');
  if (s.ports.length) {
    portas.replaceChildren(
      ...s.ports.map((p) => {
        const li = document.createElement('li');
        const ip = p.ip && p.ip !== '0.0.0.0' && p.ip !== '::' ? p.ip : 'todas as interfaces';
        li.append(`${p.host}`, Object.assign(document.createElement('span'), { textContent: ` → ${p.container}/${p.protocol} (${ip})` }));
        return li;
      }),
    );
  } else {
    portas.replaceChildren(Object.assign(document.createElement('li'), { className: 'interna', textContent: 'só na rede interna' }));
  }

  const rodando = s.state === 'running';
  const ocupado = cartao.dataset.ocupado === 'true';
  const alternar = cartao.querySelector('[data-acao="alternar"]');
  if (!ocupado) alternar.textContent = rodando ? 'Parar' : 'Iniciar';
  for (const botao of cartao.querySelectorAll('.acoes .botao')) botao.disabled = ocupado || !s.created;
}

function desenhar() {
  const nomes = new Set(servicos.map((s) => s.name));
  for (const [nome, cartao] of cartoes) {
    if (!nomes.has(nome)) {
      cartao.remove();
      cartoes.delete(nome);
    }
  }
  servicos.forEach((s, i) => {
    let cartao = cartoes.get(s.name);
    if (!cartao) {
      cartao = criarCartao(s);
      cartoes.set(s.name, cartao);
    }
    if (el.servicos.children[i] !== cartao) el.servicos.insertBefore(cartao, el.servicos.children[i] ?? null);
    atualizarCartao(cartao, s);
  });

  const rodando = servicos.filter((s) => s.state === 'running').length;
  el.resumo.textContent = `${rodando}/${servicos.length} rodando`;
  desenharAbas();
}

async function atualizar() {
  try {
    const res = await fetch('/api/services', { cache: 'no-store' });
    const corpo = await res.json();
    if (!res.ok) throw new Error(corpo.error ?? `HTTP ${res.status}`);
    servicos = corpo.services;
    vars = corpo.vars ?? {};
    el.projeto.textContent = `projeto compose: ${corpo.project}`;
    el.atualizado.textContent = `atualizado ${new Date().toLocaleTimeString('pt-BR')}`;
    el.erro.hidden = true;
    desenhar();
  } catch (err) {
    el.erro.textContent = `Não foi possível consultar os serviços: ${err.message}`;
    el.erro.hidden = false;
  }
}

async function executar(nome, acao, botao) {
  const cartao = cartoes.get(nome);
  const rotulo = botao.textContent;
  cartao.dataset.ocupado = 'true';
  botao.textContent = '…';
  for (const b of cartao.querySelectorAll('.acoes .botao')) b.disabled = true;
  try {
    const res = await fetch(`/api/services/${nome}/${acao}`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
  } catch (err) {
    el.erro.textContent = `Falha ao executar "${acao}" em ${nome}: ${err.message}`;
    el.erro.hidden = false;
  } finally {
    cartao.dataset.ocupado = 'false';
    botao.textContent = rotulo;
    await atualizar();
  }
}

function toast(mensagem) {
  el.toast.textContent = mensagem;
  el.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.toast.hidden = true;
  }, 2500);
}

async function copiar(valor, botao) {
  try {
    await navigator.clipboard.writeText(valor);
  } catch {
    window.prompt('Copie:', valor);
    return;
  }
  toast(`Copiado: ${valor}`);
  botao.classList.add('copiado');
  setTimeout(() => botao.classList.remove('copiado'), 1200);
}

// --- Logs -----------------------------------------------------------------------

const logs = { servico: null, fonte: null, ultimoTs: null, aguardando: false, timer: null, quadro: 0 };

function desenharAbas() {
  const criados = servicos.filter((s) => s.created);
  const atual = [...el.abas.children].map((t) => t.dataset.servico).join();
  if (atual !== criados.map((s) => s.name).join()) {
    el.abas.replaceChildren(
      ...criados.map((s) => {
        const aba = Object.assign(document.createElement('button'), { className: 'aba', type: 'button', textContent: s.name });
        aba.dataset.servico = s.name;
        aba.setAttribute('role', 'tab');
        aba.addEventListener('click', () => escolherLogs(s.name));
        return aba;
      }),
    );
  }
  for (const aba of el.abas.children) aba.setAttribute('aria-selected', String(aba.dataset.servico === logs.servico));
}

function escolherLogs(nome) {
  if (logs.servico === nome) return;
  guardado.gravar('painel.logs', nome);
  logs.servico = nome;
  logs.ultimoTs = null;
  logs.aguardando = false;
  el.saida.replaceChildren();
  el.seguir.checked = true;
  conectarLogs();
  desenhar();
}

function conectarLogs() {
  clearTimeout(logs.timer);
  logs.fonte?.close();
  const nome = logs.servico;
  // Na reconexão pede só o que veio depois da última linha (o filtro fino é pelo timestamp)
  const consulta = logs.ultimoTs ? `since=${Math.floor(Date.parse(logs.ultimoTs.slice(0, 23) + 'Z') / 1000)}` : 'tail=500';
  const fonte = new EventSource(`/api/services/${nome}/logs?${consulta}`);
  logs.fonte = fonte;
  el.status.textContent = `Conectando aos logs de ${nome}…`;

  fonte.addEventListener('open', () => {
    el.status.textContent = `Logs de ${nome} ao vivo`;
  });
  fonte.addEventListener('line', (evento) => {
    const linha = JSON.parse(evento.data);
    if (linha.t && logs.ultimoTs && linha.t <= logs.ultimoTs) return;
    if (logs.aguardando) {
      logs.aguardando = false;
      el.status.textContent = `Logs de ${nome} ao vivo`;
    }
    if (linha.t) logs.ultimoTs = linha.t;
    adicionarLinha(linha);
  });
  // O Docker encerra o stream quando o container para ou reinicia
  fonte.addEventListener('end', () => {
    fonte.close();
    if (!logs.aguardando) adicionarMarca('stream encerrado (container parou ou reiniciou), aguardando…');
    logs.aguardando = true;
    el.status.textContent = `${nome} não está rodando, tentando reconectar…`;
    agendarReconexao(nome);
  });
  fonte.addEventListener('error', () => {
    if (fonte.readyState === EventSource.CLOSED && logs.fonte === fonte) {
      el.status.textContent = `Sem conexão com os logs de ${nome}, tentando de novo…`;
      agendarReconexao(nome);
    }
  });
}

function agendarReconexao(nome) {
  clearTimeout(logs.timer);
  logs.timer = setTimeout(() => {
    if (logs.servico === nome) conectarLogs();
  }, RECONECTAR_MS);
}

// Converte cores ANSI (SGR) em spans; outros escapes são descartados
function ansiParaNos(texto) {
  const limpo = texto.replace(/\x1b\[[0-9;?]*[A-La-ln-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  const nos = [];
  let classes = [];
  limpo.split(/\x1b\[([0-9;]*)m/).forEach((parte, i) => {
    if (i % 2 === 1) {
      for (const codigo of (parte || '0').split(';').map(Number)) {
        if (codigo === 0) classes = [];
        else if (codigo === 1) classes.push('a-negrito');
        else if (codigo === 2) classes.push('a-fraco');
        else if (codigo === 22) classes = classes.filter((c) => c !== 'a-negrito' && c !== 'a-fraco');
        else if (codigo === 39) classes = classes.filter((c) => !/^a-\d/.test(c));
        else if ((codigo >= 30 && codigo <= 37) || (codigo >= 90 && codigo <= 97)) {
          classes = classes.filter((c) => !/^a-\d/.test(c)).concat(`a-${codigo}`);
        }
      }
    } else if (parte) {
      nos.push(
        classes.length
          ? Object.assign(document.createElement('span'), { className: classes.join(' '), textContent: parte })
          : document.createTextNode(parte),
      );
    }
  });
  return nos;
}

function passaNoFiltro(linha) {
  const filtro = el.filtro.value.trim().toLowerCase();
  return !filtro || linha.textContent.toLowerCase().includes(filtro);
}

function empurrar(linha) {
  linha.classList.toggle('oculta', !passaNoFiltro(linha));
  el.saida.append(linha);
  while (el.saida.childElementCount > MAX_LINHAS) el.saida.firstElementChild.remove();
  if (el.seguir.checked && !logs.quadro) {
    logs.quadro = requestAnimationFrame(() => {
      logs.quadro = 0;
      el.saida.scrollTop = el.saida.scrollHeight;
    });
  }
}

function adicionarLinha({ s, t, l }) {
  // Linhas com \r (barras de progresso) mostram só o último estado
  const texto = l.replace(/\r+$/, '').split('\r').pop();
  const linha = document.createElement('span');
  linha.className = `linha ${s}`;
  if (t) {
    const hora = new Date(t.slice(0, 23) + 'Z');
    linha.append(Object.assign(document.createElement('span'), { className: 'hora', textContent: hora.toLocaleTimeString('pt-BR') }));
  }
  linha.append(...ansiParaNos(texto), '\n');
  empurrar(linha);
}

function adicionarMarca(texto) {
  empurrar(Object.assign(document.createElement('span'), { className: 'linha marca', textContent: `— ${texto} —\n` }));
}

el.filtro.addEventListener('input', () => {
  for (const linha of el.saida.children) linha.classList.toggle('oculta', !passaNoFiltro(linha));
});
el.quebrar.addEventListener('change', () => {
  el.saida.classList.toggle('quebrar', el.quebrar.checked);
  guardado.gravar('painel.quebrar', el.quebrar.checked ? '1' : '0');
});
el.limpar.addEventListener('click', () => el.saida.replaceChildren());
el.seguir.addEventListener('change', () => {
  if (el.seguir.checked) el.saida.scrollTop = el.saida.scrollHeight;
});
// Rolar para cima pausa o "seguir"; voltar ao fim retoma
el.saida.addEventListener('scroll', () => {
  const noFim = el.saida.scrollHeight - el.saida.scrollTop - el.saida.clientHeight < 24;
  if (el.seguir.checked !== noFim) el.seguir.checked = noFim;
});

// --- Início ---------------------------------------------------------------------

el.quebrar.checked = guardado.ler('painel.quebrar') === '1';
el.saida.classList.toggle('quebrar', el.quebrar.checked);

atualizar().then(() => {
  const salvo = new URLSearchParams(location.search).get('logs') ?? guardado.ler('painel.logs');
  if (salvo && servicos.some((s) => s.name === salvo && s.created)) escolherLogs(salvo);
});
setInterval(atualizar, ATUALIZAR_MS);
