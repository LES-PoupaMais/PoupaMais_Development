# syntax=docker/dockerfile:1
# Front em build de produção, multi-stage, rodando como usuário não-root.
# Saída "standalone" do Next: o build gera .next/standalone (server.js + só os arquivos de node_modules que o servidor
# usa), e a imagem final leva só isso, mais .next/static e public. Sem node_modules inteiro: ~1,15 GB → ~0,3 GB.
# O NEXT_OUTPUT=standalone liga essa saída no next.config.ts do front; sem ele (Vercel, CI) o build é o normal.
# O contexto nomeado "app" é o FRONT_DIR (additional_contexts): só os caminhos copiados abaixo são
# transferidos, então node_modules, .next, coverage etc. do host não entram.
# Arquivo novo na raiz do front que o build precise (ex.: postcss.config.mjs) tem de entrar na lista.

FROM node:26-alpine AS deps
WORKDIR /app
COPY --from=app package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone
COPY --from=app next.config.ts tsconfig.json ./
COPY --from=app public ./public
COPY --from=app src ./src
RUN npm run build

FROM node:26-alpine
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
# Código somente leitura para o processo; só .next/cache (cache do Next) é do usuário node
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
RUN mkdir -p .next/cache && chown node:node .next/cache
USER node
EXPOSE 3000
CMD ["node", "server.js"]
