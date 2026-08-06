# SrilankaOL

SrilankaOL 是一个由主持人驱动的多人异步战略游戏平台。本仓库当前处于 M0 工程基线阶段。

## 工程结构

```text
apps/web       React 网页前端
apps/api       Fastify 模块化单体 API
apps/worker    异步任务进程基线
packages/      安全共享契约、配置、数据库与日志
infrastructure 容器、反向代理和数据库说明
docs/          产品、架构、规则与验收文档
```

## 本地开发

要求 Node.js 22+、pnpm 11，以及可选的 Docker Compose。

1. 复制 `.env.example` 为 `.env`，仅在本机填写密钥。
2. 安装依赖：`pnpm.cmd install`。
3. 启动 PostgreSQL、Redis 和对象存储：`docker compose -f infrastructure/compose.yaml up -d database redis object-storage`。
4. 执行迁移：`pnpm.cmd db:migrate`。
5. 启动 Web、API 和 worker：`pnpm.cmd dev`。
6. 访问 `http://localhost:5173`；API 健康接口为 `http://localhost:3000/api/v1/health`。

如果本机没有 Docker，可提供外部 PostgreSQL/Redis，并通过 `DATABASE_URL` 与 `REDIS_URL` 指向对应的开发环境实例。

## 质量检查

```powershell
pnpm.cmd format:check
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
```

真实依赖集成测试需要隔离的测试数据库与 Redis：

```powershell
$env:NODE_ENV = 'test'
$env:DATABASE_URL = 'postgresql://srilanka:srilanka@localhost:5432/srilanka_test'
$env:REDIS_URL = 'redis://localhost:6379/1'
pnpm.cmd db:migrate
pnpm.cmd --filter @srilanka/api test:integration
```

## 配置与安全

- 不提交 `.env` 或任何真实密钥。
- 玩家权限必须由后端执行；前端隐藏不构成安全边界。
- 共享契约不得导出数据库实体或秘密字段。
- 正式世界状态将在 M5 后只能通过状态变更集修改。
