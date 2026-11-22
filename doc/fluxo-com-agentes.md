# Fluxo de trabalho com agentes de IA

Como a equipe usa agentes de IA (Claude Code, Codex, opencode…) nos três repositórios. Vale para qualquer ferramenta.

## Princípios

- **O humano decide o quê; o agente decide o como.** Arquitetura, escopo e regras de negócio são decisão da equipe. O agente
  propõe; o que contradiz o DVP, o Design System ou o contrato para e vira pergunta.
- **Peça explicitamente** o que importa: testes, tratamento de erro, segurança, refatoração. O agente não faz isso sozinho.
- **Mude só o que foi pedido.** Peça aprovada (tela, texto, componente) não muda "por conta própria": vira proposta.
- **Pronto = pipeline local verde** (a definição de pronto de cada `AGENTS.md`). Se algo não rodou, o relatório diz o quê.
- **Confira no Git** o que o agente diz que fez antes de dar como feito.

## Uma tarefa, uma worktree, uma branch

- Uma tarefa por agente, numa worktree própria em `wt/<nome>` (pasta irmã dos repositórios):
  `git -C PoupaMais_BackEnd worktree add ../wt/<nome> -b feat/<nome> origin/development`. Remova depois do merge.
- Para a pilha integrada usar a worktree: `FRONT_DIR` / `BACK_DIR` (README, seção "Apontar para uma worktree").
- Tarefas que mexem nos mesmos arquivos vão em sequência (ondas), não em paralelo.
- **2 a 3 agentes ao mesmo tempo, no máximo**: mais do que isso gasta tokens demais e a máquina não aguenta os builds.

## Recursos compartilhados entre agentes paralelos

- **Banco de teste do back:** container `db-test` (porta 5433). Um banco por agente paralelo (`poupamais_test_a`,
  `poupamais_test_b`…), porque uma migração numa branch quebra o Flyway das outras. Não rode `docker compose down` no `db-test`
  de outra pessoa.
- **E2E do front:** uma `PORT` por worktree (`PORT=3101 npm run test:e2e`); o Playwright reaproveita qualquer servidor que já
  esteja na porta e testaria o build de outra pasta.
- **Máquina com pouca RAM (WSL):** um build por vez. Agentes de front em paralelo rodam lint, typecheck, testes e build
  localmente e deixam o E2E para o CI do PR. Modo "como produção" (`npm run prod`): pare antes o dev (`front`, `api`, `painel`).

## Do commit ao merge

1. O agente commita (Conventional Commits) e dá push da branch; o relatório traz título e descrição do PR.
2. PR com base **development**; integra só com o CI verde (merge commit, sem apagar a branch).
3. `development` → `main`, tags e releases: só quando o líder pedir.
4. Débito encontrado fora da tarefa não se corrige na hora: vira pendência registrada (`doc/historico.md` do back,
   `doc/pendencias.md` do front).

## Pedidos que funcionam bem

- **Começo de tarefa:** "leia o `AGENTS.md` e o `doc/` de <assunto>; implemente <o quê>; não mude <o que está aprovado>; escreva
  os testes; rode a pipeline local."
- **Depois de muito código:** "revise o que foi feito: código morto, duplicação, números mágicos, módulos grandes, testes que
  faltam. Não mude comportamento sem teste."
- **Antes de release:** auditoria de segurança (segredo vazado, validação ausente, permissões, comandos destrutivos). Vale rodar
  com duas IAs diferentes, porque cada uma acha coisas diferentes.
- **Direção errada:** reduza o escopo ou mude a estratégia em vez de repetir o mesmo pedido. Erro estrutural (ignorou o que foi
  pedido, entregou um mock no lugar do real) pede recomeçar, não remendar.

## Trocar de agente ou de IA

- Antes de encerrar uma sessão longa ou passar para outra ferramenta, peça um `HANDOFF.md` na raiz do repositório (estado,
  decisões, próximos passos, dúvidas). A próxima sessão lê e apaga. Ele está no `.gitignore`.
- O que precisa durar vai para o Git: regras no `AGENTS.md`, detalhes em `doc/`, decisões em `doc/decisoes/`. Assim qualquer
  IA retoma o projeto sem depender da memória de uma ferramenta.
