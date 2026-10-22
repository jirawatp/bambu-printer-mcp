# Official Node 24 Alpine multi-architecture index, verified 2026-10-18.
# Pin the digest for repeatable base contents; review it deliberately for updates.
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json .c8rc.json ./
COPY src ./src
COPY tests ./tests
COPY examples ./examples
COPY scripts/coverage-inventory.mjs ./scripts/coverage-inventory.mjs
# Test inside the build environment, then retain production dependencies only.
RUN npm run check \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
# App files stay root-owned; the server runs as the image's unprivileged user.
USER node:node
ENTRYPOINT ["node", "--max-old-space-size=128", "dist/src/cli.js"]
