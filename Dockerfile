# syntax=docker/dockerfile:1

# ---- Construction : sur la plateforme de build (le résultat est du JS pur, identique pour toutes les archis)
FROM --platform=$BUILDPLATFORM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Le typecheck et les tests tournent en CI ; ici on ne fait que construire.
RUN npx vite build && npm run build:server

# ---- Exécution : Node + l'interface + un seul fichier serveur, sans node_modules
FROM node:24-alpine
ARG SILLON_VERSION=dev
RUN apk add --no-cache tzdata \
 && mkdir -p /data && chown node:node /data
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    STATIC_DIR=/app/dist \
    TZ=Europe/Paris \
    SILLON_VERSION=$SILLON_VERSION
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "dist-server/index.mjs"]
