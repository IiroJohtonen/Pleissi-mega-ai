# Kotilo yhtenä palveluna: palvelin tarjoaa rajapinnan ja käännetyn käyttöliittymän samasta osoitteesta.
# Käännös: docker build -t kotilo .
# Ajo:     docker run -p 4000:4000 -v kotilo-data:/data --env-file server/.env kotilo

FROM node:22-slim AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
# Käännös tarvitsee enemmän muistia kuin Noden oletusraja pienellä palvelimella sallii.
RUN NODE_OPTIONS=--max-old-space-size=2048 npm run build

FROM node:22-slim AS server
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN NODE_OPTIONS=--max-old-space-size=2048 npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=4000 \
    DATA_DIR=/data \
    CLIENT_DIST=/app/client/dist
WORKDIR /app/server
COPY --from=server /app/server/node_modules ./node_modules
COPY --from=server /app/server/dist ./dist
COPY --from=server /app/server/package.json ./
COPY --from=client /app/client/dist /app/client/dist
# Tietokanta ja liitteet ovat levyllä /data, joka pitää liittää pysyvään tallennukseen.
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/index.js"]
