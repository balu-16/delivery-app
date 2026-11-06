# One immutable image runs every APP_ROLE; provide validated production env at runtime.
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS base
WORKDIR /app
RUN npm install --global pnpm@12.18.0

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY scripts/prepare-hooks.mjs ./scripts/prepare-hooks.mjs
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY tsconfig*.json ./
COPY src ./src
RUN pnpm build

FROM base AS production-dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY scripts/prepare-hooks.mjs ./scripts/prepare-hooks.mjs
RUN pnpm install --prod --frozen-lockfile

FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node scripts/migrate.ts ./scripts/migrate.ts
COPY --chown=node:node db/migrations ./db/migrations
RUN mkdir -p /app/var && chown node:node /app/var
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/healthz`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
