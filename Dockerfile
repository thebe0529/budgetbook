FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY bin ./bin
COPY public ./public

USER node
EXPOSE 38181
CMD ["node", "bin/import-server.js"]
