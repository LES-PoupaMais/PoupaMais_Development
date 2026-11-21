# syntax=docker/dockerfile:1
# Front em build de produção (next build + next start), multi-stage, rodando como usuário não-root.
# O contexto nomeado "app" é o FRONT_DIR (additional_contexts): só os caminhos copiados abaixo são
# transferidos, então node_modules, .next, coverage etc. do host não entram.
# Arquivo novo na raiz do front que o build precise (ex.: postcss.config.mjs) tem de entrar na lista.

FROM node:26-alpine AS deps
WORKDIR /app
COPY --from=app package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=app next.config.ts tsconfig.json ./
COPY --from=app public ./public
COPY --from=app src ./src
RUN npm run build

# Só as dependências de produção para a imagem final
FROM node:26-alpine AS deps-prod
WORKDIR /app
COPY --from=app package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:26-alpine
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# Código e dependências do root (somente leitura para o processo); .next do usuário node (cache do Next)
COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/next.config.ts ./
COPY --from=build /app/public ./public
COPY --from=build --chown=node:node /app/.next ./.next
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
