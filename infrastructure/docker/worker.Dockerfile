FROM node:24-alpine3.23 AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/
COPY packages/logger/package.json packages/logger/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @srilanka/worker... build
RUN CI=true pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24-alpine3.23 AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /app /app
ENV NODE_ENV=production
USER node
CMD ["node", "apps/worker/dist/index.js"]
