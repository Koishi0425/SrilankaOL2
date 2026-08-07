# SrilankaOL

SrilankaOL 是一个由主持人驱动的多人异步战略游戏平台。本仓库当前处于 M4 行动与通信阶段。

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

1. 复制 `.env.example` 为仓库根目录的 `.env`，仅在本机填写密钥；开发服务、迁移和种子命令会自动读取它。
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

## M1 开发账号与动态端口

首次本地启动前，在根目录 `.env` 中填写 `SEED_HOST_USERNAME`、`SEED_HOST_PASSWORD`、`SEED_HOST_NAME`、`SEED_GAME_NAME` 和 `SEED_COUNTRY_NAMES`，然后创建或更新主持人账号及初始游戏：

```powershell
pnpm.cmd db:migrate
pnpm.cmd --filter @srilanka/api seed:dev
```

PowerShell 中已设置的同名 `$env:变量名` 优先于 `.env`，因此仍可用它临时覆盖单项配置。

若 Windows 保留了默认 API 端口，可让 API 使用可用端口，并让 Vite 代理到该地址。浏览器仍访问 `http://localhost:5173`，无需把 `VITE_API_BASE_URL` 改成跨域地址：

```powershell
$env:HOST = '127.0.0.1'
$env:PORT = '6369'
$env:VITE_API_BASE_URL = '/api/v1'
$env:VITE_API_PROXY_TARGET = 'http://127.0.0.1:6369'
pnpm.cmd dev
```

系统同时最多保留一场正在推进的游戏，普通网页不提供创建入口。首次运行 `seed:dev` 会自动建立初始游戏、国家、主持人成员关系和第 1 年春季的准备中季度。其他用户可以用用户名和密码在登录页自助注册，再由主持人按用户名将其添加为玩家或观察者；成员管理、国家分配及跨游戏访问均由 API 强制鉴权。

## M2 开发地图

应用最新迁移后再次运行 `seed:dev`，会为尚无地图的当前游戏生成一张 12×8 的开发地图，包括基础地形、地区、Kandy 城市和示例军队：

```powershell
pnpm.cmd db:migrate
pnpm.cmd --filter @srilanka/api seed:dev
pnpm.cmd dev
```

进入当前游戏后，地图按可见视口加载。滚轮用于缩放，按住拖动用于平移，点击地块打开详情。主持人还可以修改地块控制权，以及在有效地块上创建城市和军队。

## M3 玩家视图

应用 `006_m3_player_perception.sql` 后，地图响应会在后端按成员身份生成：主持人看到真实状态；本国军队显示精确人数；有情报的敌军只显示人数范围、可信度和获知版本；观察者不接收军队秘密数据。未知或过时信息使用明确认知状态，不会用 `0` 冒充真实值。

主持人在游戏工作区顶部可以选择玩家或观察者进行只读视角预览。预览请求与该成员实际请求共用同一投影规则，预览期间地图编辑入口会被禁用。更新后执行：

```powershell
pnpm.cmd db:migrate
pnpm.cmd --filter @srilanka/api seed:dev
pnpm.cmd dev
```

## M4A 行动与通信

应用 `007_m4_actions_and_messages.sql` 后，游戏工作区提供“行动中心”和“消息中心”。玩家可以保存带地图引用的行动草稿；已创建草稿会自动保存并检测多窗口版本冲突，正式提交需要再次确认。主持人可以开放或锁定提交、查看审核队列、保存不覆盖玩家原文的整理稿、要求补充、批准或拒绝。

消息会话按参与成员在后端隔离，主持人自动加入游戏内会话进行监督。发送操作使用客户端幂等标识，网络重试不会生成重复消息；打开会话后更新未读状态。

更新与验收：

```powershell
pnpm.cmd db:migrate
pnpm.cmd dev
```

先由主持人在“行动审核”中开放行动提交；玩家随后可从地图地块详情选择“基于此地块创建行动”，或直接进入行动中心新建草稿。事件回应和正式外交协议属于后续 M4B。
