FROM node:24-alpine
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @srilanka/api... build
EXPOSE 3000
CMD ["pnpm", "--filter", "@srilanka/api", "start"]
