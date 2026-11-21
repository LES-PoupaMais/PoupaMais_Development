# PoupaMais_Development

Ambiente integrado do PoupaMais: sobe banco, e-mail, API, front e Nginx com um comando, em dois modos
(**desenvolvimento** e **como produção**), com um painel para acompanhar tudo. O código da aplicação fica nos
repositórios irmãos `PoupaMais_BackEnd` e `PoupaMais_FrontEnd`; aqui só há orquestração.

```
poupamais/
├── PoupaMais_BackEnd/      ← BACK_DIR  (Dockerfile da API)
├── PoupaMais_FrontEnd/     ← FRONT_DIR (Next.js)
└── PoupaMais_Development/  ← este repositório
```

## Pré-requisitos

- Docker Engine com Compose v2 (no WSL, o Docker nativo do Linux, com o usuário no grupo `docker`);
- Node 22 ou mais novo (só para os atalhos `npm run` e os testes; nada é instalado aqui: não há `npm install`);
- `openssl` (certificado do modo como produção).

## Comandos

| Comando | O que faz |
| --- | --- |
| `npm run dev` | Sobe o modo dev, espera todos ficarem saudáveis e mostra os endereços |
| `npm run dev:down` | Derruba o modo dev (mantém o banco) |
| `npm run dev:reset` | Derruba, **apaga o banco** e os volumes de `node_modules`/`.next` e sobe de novo |
| `npm run logs` / `logs:front` / `logs:api` / `logs:nginx` / `logs:db` / `logs:mailpit` / `logs:painel` | Logs do modo dev |
| `npm run prod` | Gera o certificado (se faltar) e sobe o modo como produção |
| `npm run prod:down` / `prod:reset` / `logs:prod` | Derruba / recria do zero / logs do modo como produção |
| `npm run status` | Projetos do PoupaMais no Docker e os containers de cada modo |
| `npm run certs` | Gera a CA local e o certificado do nginx em `certs/` (`-- --forcar` refaz o do nginx) |
| `npm run e2e:up` / `e2e:down` / `e2e:reset` | Pilha da suíte E2E do front contra a API real (ver abaixo) |
| `npm test` | Testes do painel e dos scripts (`node:test`, Docker falso) |
| `npm run check` / `npm run config` | `node --check` dos scripts / `config -q` dos três modos, portas e `nginx -t` |

O `docker compose up` puro também funciona: sem `-f`, o Compose junta `docker-compose.yml` com
`docker-compose.override.yml`, que é o modo dev.

## Arquitetura

```
                 navegador
                     │
            ┌────────▼────────┐  única entrada (dev: http; como produção: https)
  rede borda│      nginx      │
            └───┬─────────┬───┘
                │         │ (só dev, 127.0.0.1) Swagger → api, Postgres → db; Mailpit → mailpit
            ┌───▼───┐     │
            │ front │  Next.js: páginas, BFF em /api/[...path] e Server Actions
            └───┬───┘     │
  rede interna  │ API_URL=http://api:8080
            ┌───▼───┐ ┌───▼────┐ ┌────┐
            │  api  │─│mailpit │ │ db │   sem porta no host, sem saída para a internet
            └───┬───┘ └────────┘ └─▲──┘
                └──────────────────┘
```

- **O navegador fala só com o Next.** Até as chamadas `/api/...` do navegador vão para o BFF do Next, que repassa
  para a API pela rede interna com o JWT do cookie httpOnly `pm_token`.
- **Só o nginx publica portas** (e o painel, no dev, em 127.0.0.1). API, banco e Mailpit ficam na rede `interna`
  (`internal: true`): sem porta no host e sem acesso à internet, como num servidor. O front está nas duas redes
  (precisa da internet para as fontes do Google no build/dev).
- O nginx resolve os serviços a cada requisição (DNS do Docker): sobe mesmo com um serviço parado e acompanha
  o container que o painel reiniciar.
- Os arquivos seguem o padrão **base / override / prod**: `docker-compose.yml` não publica nenhuma porta; cada
  modo publica as suas (o `scripts/conferir-portas.js` garante isso no CI).

### Modo dev — `npm run dev` (projeto `poupamais`)

| Serviço | O que é |
| --- | --- |
| `db` | Postgres 17 com healthcheck; volume `poupamais_dados-db` |
| `mailpit` | Mailpit `v1.33.1` (SMTP `mailpit:1025` na rede interna) |
| `api` | Imagem do `Dockerfile` do back (`BACK_DIR`), Swagger ligado; espera `db` e `mailpit` saudáveis. Saudável quando `GET /actuator/health` responde `{"status":"UP"}` (`HEALTHCHECK` do próprio `Dockerfile`) |
| `front` | `next dev` com bind mount de `FRONT_DIR` (hot reload), uid 1000, volumes anônimos para `node_modules` e `.next`, `API_URL=http://api:8080` |
| `nginx` | Na frente do front; também publica Swagger, Mailpit e Postgres em 127.0.0.1 |
| `painel` | Painel de desenvolvimento (abaixo), em 127.0.0.1 |

A API **não** tem hot reload: é a mesma imagem de produção. Mudou o back? `npm run dev` reconstrói o que mudou.
Mudou o `package.json` do front? `npm run dev:reset` (ou `docker compose up -d --build --renew-anon-volumes front`)
para recriar o volume de `node_modules`.

### Modo como produção — `npm run prod` (projeto `poupamais-prod`)

- `front` em build de produção: `config/front/Dockerfile`, multi-stage (`next build` → imagem só com as
  dependências de produção e o `.next`), `next start`, usuário `node` (não-root), `NODE_ENV=production`;
- `api` com `SWAGGER_HABILITADO=false`, `FRONT_URL`/`CORS_ORIGINS` em HTTPS;
- nginx com **HTTPS**, redirecionamento HTTP → HTTPS, HSTS, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, gzip e `client_max_body_size 3m` (uploads de até 2 MB + envelope
  do multipart, igual ao `max-request-size` do back);
- `restart: unless-stopped`; sem painel e sem Postgres no host. Mailpit em 127.0.0.1, fazendo o papel da caixa
  de e-mail (redefinição de senha).

É um projeto Compose separado, com banco próprio: dá para ter os dois modos no ar ao mesmo tempo.
Com `NODE_ENV=production` o front grava o cookie `pm_token` com `Secure`, que só trafega por HTTPS — por isso
este modo é o lugar de conferir sessão, redirecionamentos e cabeçalhos antes de uma entrega.

**PWA:** é também o modo para instalar o PoupaMais como app. O service worker só é registrado no build de produção,
e o navegador só oferece instalar em HTTPS (ou em `localhost`). No modo dev, pelo IP da rede (`http://<IP>:8000`),
não instala. No computador, abra `https://poupamais.localhost:8443` com a CA local confiada (ver "HTTPS local").

### Painel (só no dev)

`http://localhost:9000` — `config/painel`, Node puro (sem dependências) falando com a API do Docker pelo socket:

- cada serviço com estado, saúde, portas e links (`config/painel/services.json`: app, Swagger, Mailpit,
  conexão do Postgres);
- iniciar, parar e reiniciar; logs ao vivo (SSE) com filtro;
- só em `127.0.0.1`; recusa `Host` que não seja localhost (DNS rebinding) e ações sem `Origin` do próprio painel
  (CSRF); não para nem reinicia a si mesmo.

## Portas

Todas configuráveis no `.env` (ver `.env.example`). Os padrões do dev evitam as portas do compose do back
(5432, 8080, 8025, 1025), do db-test (5433) e do `npm run dev` do front (3000).

| Modo | Variável | Padrão | Interface | Para quê |
| --- | --- | --- | --- | --- |
| dev | `APP_PORT` | 8000 | todas | App (nginx → front) |
| dev | `SWAGGER_PORT` | 8001 | 127.0.0.1 | Swagger (`/swagger-ui.html`); `http://localhost:8000/swagger` redireciona para cá |
| dev | `MAILPIT_PORT` | 8002 | 127.0.0.1 | Mailpit |
| dev | `DB_PORT` | 5434 | 127.0.0.1 | Postgres (DBeaver, psql), via nginx |
| dev | `PAINEL_PORT` | 9000 | 127.0.0.1 | Painel |
| prod | `PROD_HTTP_PORT` | 8480 | todas | Redireciona para HTTPS |
| prod | `PROD_HTTPS_PORT` | 8443 | todas | App em HTTPS |
| prod | `PROD_MAILPIT_PORT` | 8402 | 127.0.0.1 | Mailpit |
| e2e | `E2E_API_PORT` / `E2E_MAILPIT_PORT` / `E2E_DB_PORT` | 8580 / 8525 / 5435 | 127.0.0.1 | Pilha E2E |

O Swagger tem porta própria para o "Try it out" falar direto com a API: no endereço do app, `/api` é do BFF do Next.

Postgres do dev: `postgresql://poupamais:poupamais@localhost:5434/poupamais` (schema `poupamais`).

## Abrir pelo celular (modo dev)

1. No `.env`, coloque o IP desta máquina na rede (no WSL: `ip -4 addr show eth0`):
   ```
   ORIGENS_DEV_PERMITIDAS=192.168.0.10
   APP_URL=http://192.168.0.10:8000
   ```
   Sem `ORIGENS_DEV_PERMITIDAS`, o `next dev` bloqueia os scripts para esse endereço e o login não funciona. O `APP_URL` faz o link do e-mail de senha abrir no celular.
2. No WSL, use a rede espelhada (`networkingMode=mirrored` no `.wslconfig` do Windows) e libere a porta no PowerShell como administrador:
   ```powershell
   New-NetFirewallHyperVRule -Name PoupaMais8000 -DisplayName "PoupaMais 8000" -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 8000
   New-NetFirewallRule -DisplayName "PoupaMais 8000" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Private
   ```
3. `npm run dev` e abra `http://<IP>:8000` no celular, na mesma rede Wi-Fi (marcada como Privada no Windows).

Assim o app abre e funciona, mas não instala como PWA (o navegador exige HTTPS). Para instalar no celular, é preciso
HTTPS com um certificado que o celular confie (por exemplo, depois de um deploy com HTTPS).

## Apontar para uma worktree (`FRONT_DIR` / `BACK_DIR`)

Por padrão o ambiente usa `../PoupaMais_FrontEnd` e `../PoupaMais_BackEnd`. Para testar uma branch, aponte para
a worktree dela, no `.env` ou só no comando (caminho relativo a esta pasta ou absoluto):

```sh
FRONT_DIR=../wt/telas-integradas npm run dev
FRONT_DIR=../wt/telas-integradas BACK_DIR=../wt/minha-branch-do-back npm run prod
```

- O back entra pelo próprio `Dockerfile` e `.dockerignore`.
- O front entra pelos Dockerfiles daqui (`config/front`), com o código como contexto nomeado (`additional_contexts`):
  só o que eles copiam é enviado ao Docker (`package.json`, `package-lock.json`, `next.config.ts`, `tsconfig.json`,
  `public/`, `src/`), então `node_modules` e `.next` da worktree ficam de fora. Arquivo novo na raiz do front que o
  build precise tem de entrar no `config/front/Dockerfile`.
- No dev, o front monta a worktree em `/app`: como num `npm run dev` local, o `next dev` pode reescrever o
  `next-env.d.ts` (ignorado pelo git do front). `node_modules` e `.next` do container ficam em volumes anônimos,
  sem tocar nos da worktree.

## HTTPS local (modo como produção)

`npm run certs` (chamado pelo `npm run prod`) cria em `certs/` (fora do git):

- `poupamais-ca.crt` / `.key`: uma **CA local autoassinada**, reaproveitada nas próximas execuções;
- `poupamais.crt` / `.key`: o certificado do nginx, assinado por ela, para `poupamais.localhost`, `localhost`,
  `127.0.0.1` e `::1` (397 dias; refeito sozinho quando falta menos de 30).

Abra **`https://poupamais.localhost:8443`** (`*.localhost` aponta para a própria máquina nos navegadores).
`https://localhost:8443` também funciona, mas sem HSTS: o HSTS vale para o host em todas as portas, e mandado
para `localhost` faria o navegador forçar HTTPS em todo `http://localhost:*` (inclusive no modo dev).

Sem confiar na CA, o navegador mostra o aviso de certificado. Para confiar (uma vez só; a CA não muda ao refazer
o certificado do nginx):

**Windows (Chrome, Edge), com o Docker no WSL**

1. No WSL, copie a CA para o Windows: `cp certs/poupamais-ca.crt /mnt/c/Users/<seu-usuário>/Downloads/`
   (ou abra `\\wsl$\<distro>\...\PoupaMais_Development\certs` no Explorer).
2. No PowerShell (sem precisar de administrador):
   `certutil -user -addstore Root $env:USERPROFILE\Downloads\poupamais-ca.crt` — ou dê dois cliques no arquivo →
   *Instalar Certificado* → *Usuário Atual* → *Colocar todos os certificados no repositório a seguir* →
   *Autoridades de Certificação Raiz Confiáveis*.
3. Feche e abra o navegador.

**Firefox**: usa o repositório do Windows se `security.enterprise_roots.enabled` estiver `true` em
`about:config`; senão, *Configurações → Privacidade e Segurança → Certificados → Ver certificados → Autoridades →
Importar* e marque "confiar para identificar sites".

**Dentro do WSL** (curl, Node, Playwright no host):

```sh
sudo cp certs/poupamais-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates
# ou, sem sudo:
curl --cacert certs/poupamais-ca.crt https://poupamais.localhost:8443/login
NODE_EXTRA_CA_CERTS=$PWD/certs/poupamais-ca.crt node script.js
```

Para remover: `certmgr.msc` → *Autoridades de Certificação Raiz Confiáveis* → *PoupaMais CA local*.
A chave da CA (`certs/poupamais-ca.key`) só existe nesta máquina: não a compartilhe.

## Pilha E2E

`docker-compose.e2e.yml` (projeto `poupamais-e2e`) sobe só `db` (em `tmpfs`, some no `down`), `mailpit` e `api`,
em portas próprias de 127.0.0.1. A suíte `e2e/api-real` do front roda o Next (build de produção, porta 3130) e o
Playwright no host com `API_URL=http://localhost:8580` e lê os e-mails pela API do Mailpit
(`http://localhost:8525/api/v1/messages`).

```bash
npm run e2e:up                      # aqui
npm run test:e2e:api-real           # no PoupaMais_FrontEnd
npm run e2e:down                    # aqui (apaga o banco da pilha)
```

`E2E_FRONT_PORT` (padrão 3130) precisa ser a mesma porta do front da suíte: é para ela que apontam o link do e-mail
de senha e o CORS da API. `npm run e2e:reset` recria a pilha do zero.

## Estrutura

```
.
├── docker-compose.yml           # base: serviços e redes, sem portas
├── docker-compose.override.yml  # modo dev (carregado sozinho pelo "docker compose")
├── docker-compose.prod.yml      # modo como produção
├── docker-compose.e2e.yml       # pilha E2E (suíte e2e/api-real do front)
├── config/
│   ├── front/                   # Dockerfile (produção) e Dockerfile.dev do Next
│   ├── nginx/                   # nginx.conf, snippets/, dev/ e prod/ (templates), stream-dev/ (Postgres)
│   └── painel/                  # server.js, services.json e public/
├── scripts/                     # certificados, conferência de portas e de configuração, endereços
├── tests/                       # node:test do painel e dos scripts
└── .github/workflows/ci.yml     # node --check, npm test, config -q dos modos e nginx -t
```

## Problemas comuns

- **Porta ocupada**: troque no `.env` (`APP_PORT`, `PROD_HTTPS_PORT` etc.).
- **`api` não fica saudável**: `npm run logs:api`. Na primeira subida o Maven baixa as dependências (alguns minutos).
  O healthcheck consulta `GET /actuator/health` dentro do container: `DOWN` (503) quase sempre é o banco fora do ar.
- **Painel sem acesso ao Docker**: ele precisa de `/var/run/docker.sock`; a mensagem na página diz o motivo.
- **Navegador forçando HTTPS em `http://localhost`**: algum HSTS antigo para `localhost`; apague em
  `chrome://net-internals/#hsts` (*Delete domain security policies*).
