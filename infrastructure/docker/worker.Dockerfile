FROM node:24-alpine
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @srilanka/worker... build
CMD ["pnpm", "--filter", "@srilanka/worker", "start"]
