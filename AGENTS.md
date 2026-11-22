# PoupaMais_Development

Guia para qualquer agente de IA (Claude Code, Codex, opencode, Cursor…) e para quem programa. É curto de propósito: ele entra
no contexto em toda sessão. O detalhe fica no `README.md` (seções citadas abaixo) e em `doc/`.

Ambiente integrado do PoupaMais: sobe banco, e-mail, API, front e Nginx com um comando, nos modos **dev**, **como produção** e
**E2E**, com um painel. **Aqui só há orquestração**: o código da aplicação fica nos repositórios irmãos `PoupaMais_BackEnd` e
`PoupaMais_FrontEnd`, cada um com o seu `AGENTS.md`. Mudança de regra, tela ou endpoint é feita lá, não aqui.

## Onde está cada coisa (leia sob demanda)

| Assunto | Onde |
| --- | --- |
| Comandos (`npm run dev`, `prod`, `e2e:up`, `status`…) | `README.md`, seção "Comandos" |
| Modos, painel e portas | `README.md`, seções "Arquitetura" e "Portas" |
| Celular na rede, worktrees (`FRONT_DIR`/`BACK_DIR`), HTTPS local | `README.md`, seções de mesmo nome |
| Pilha E2E do front contra a API real | `README.md`, seção "Pilha E2E" |
| Deploy (Vercel, Render, Neon, Brevo, cron-job.org) e problemas | `README.md`, seção "Deploy" |
| Como trabalhar com agentes de IA nos três repositórios | `doc/fluxo-com-agentes.md` |
| Por que algo foi feito de um jeito | `doc/decisoes/` |

## Regras

- Node 22 ou mais novo só para os atalhos `npm run` e os testes; **não há `npm install`** aqui.
- Nada de segredo no Git: `.env` é local (o `.env.example` é versionado); `certs/` nunca sai da máquina.
- Porta nova ou mudada: ajuste a tabela "Portas" do README e rode `npm run config` (confere portas, `config -q` dos três modos e
  `nginx -t`).
- Não use `docker compose down -v` sem querer apagar o banco (`dev:reset` e `prod:reset` apagam de propósito).
- **Git (Gitflow):** `feat/<card>` a partir da `development` → PR para a `development` → PR `development` → `main` (a `main` só
  aceita PR vindo da `development`). Conventional Commits em português.

## Definição de pronto

`npm test`, `npm run check` e `npm run config` verdes (os mesmos passos do CI, `.github/workflows/ci.yml`). Mudou o jeito de
subir a pilha? Suba o modo afetado (`npm run dev`, `prod` ou `e2e:up`) e confira os endereços. O README acompanha a mudança no
mesmo PR. Se algum passo não rodou, diga exatamente o que faltou.

## Memória do projeto (vale para qualquer IA)

- **O que não virou código também se registra.** Decisão tomada, pesquisa feita, alternativa descartada e o motivo: um arquivo em
  `doc/decisoes/` (modelo em `doc/decisoes/README.md`), no mesmo PR. Armadilha nova (deploy, Docker, rede) vai para o README.
- **Troca de agente ou sessão longa:** antes de encerrar, escreva `HANDOFF.md` na raiz (estado, decisões, próximos passos,
  dúvidas abertas). Quem continua lê e apaga. O arquivo não vai para o Git (`.gitignore`).
- Este guia fica curto: regra nova entra aqui só se valer para toda tarefa.
