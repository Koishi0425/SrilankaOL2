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
RUN pnpm --filter @srilanka/api... build
RUN CI=true pnpm install --prod --frozen-lockfile --ignore-scripts

FROM postgres:17-alpine3.23 AS pg-client
# Backups need pg_dump/pg_restore matching the database major. Copy them from
# the database image (and their shared libraries) instead of downloading an
# Alpine package in the runtime stage, so the build does not depend on the
# Alpine CDN and the client always matches PostgreSQL 17. Match the runtime's
# Alpine version too, so copied shared libraries use the same ABI.
RUN set -eux; \
    mkdir -p /pg-libs; \
    for bin in pg_dump pg_restore; do \
      for lib in $(ldd "/usr/local/bin/$bin" | awk '/=>/ { print $3 }'); do \
        case "$lib" in \
          */ld-musl-*) continue ;; \
        esac; \
        cp -L "$lib" /pg-libs/; \
      done; \
    done; \
    test -f /pg-libs/libpq.so.5

FROM node:24-alpine3.23 AS runtime
WORKDIR /app
COPY --from=pg-client /usr/local/bin/pg_dump /usr/local/bin/pg_dump
COPY --from=pg-client /usr/local/bin/pg_restore /usr/local/bin/pg_restore
COPY --from=pg-client /pg-libs /opt/pg-libs
ENV LD_LIBRARY_PATH=/opt/pg-libs
RUN pg_dump --version && pg_restore --version
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/backups && chown node:node /app/backups
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
