# SrilankaOL

供主持人和玩家共同使用的回合制战略游戏辅助网站。玩家扮演国家或角色，提交文字政策；主持人审核、追问补充、编写反馈，再统一发布结算。玩法参考《欧陆风云》的国家战略，但行动与故事仍由参与者自由表达、主持人裁决。

目前包含地图与战争迷雾、国家资料、经济与贸易、外交、军事、政府、政策讨论、回合结算和历史记录。模型辅助可选，用于已发布结果速览与主持人反馈起草，不自动裁决或发布。

## Docker 部署

需要 Docker Engine / Docker Desktop（Linux 容器）和 Docker Compose v2.24 以上。部署机器无需安装 Node.js、pnpm 或 PostgreSQL。以下命令均在本 README 所在的仓库根目录执行。

### 1. 准备配置

Linux / macOS：

```sh
cp .env.docker.example .env.docker
openssl rand -hex 24
```

Windows PowerShell：

```powershell
Copy-Item .env.docker.example .env.docker
[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
```

编辑 `.env.docker`，将生成的随机值填入 `POSTGRES_PASSWORD`。使用字母、数字、`-`、`_` 组成的密码，避免数据库连接串中的字符转义问题。保留其余默认值即可在本机 HTTP 试玩。

`.env.docker` 是私有部署配置，不提交 Git，也不复制进镜像。根目录 `.env` 留给源码开发使用。每次部署命令都显式指定 `--env-file .env.docker`，避免混用本地端口和数据库地址。

### 2. 构建并启动

```sh
docker compose --env-file .env.docker config --quiet
docker compose --env-file .env.docker up -d --build --wait --wait-timeout 180
docker compose --env-file .env.docker ps -a
```

访问 **http://localhost:8080**。首次构建需要下载基础镜像与依赖；`migrate` 容器正常状态为 `Exited (0)`，其余默认服务应为 `healthy`。

启动会等待 PostgreSQL 就绪，执行全部尚未应用的数据库迁移，迁移成功后才启动 API 和网页。重复启动不会重置存档。数据库、Redis、备份和 HTTPS 证书均使用持久化数据卷；API 和数据库端口不发布到宿主机。

### 3. 创建第一位主持人

默认采用邀请注册，不提供预设账号和密码。在终端执行：

```sh
docker compose --env-file .env.docker exec api node apps/api/dist/bootstrap-host.js
```

按提示输入用户名、显示名称及密码。密码至少 15 个字符，输入时不回显。此命令仅在数据库完全没有账号时创建第一位用户；已有账号时会拒绝，不会重置账号、创建示例游戏或覆盖存档。

之后在网页登录，创建游戏、设置国家和规则。主持人可生成账号邀请码供其他玩家注册，再把玩家加入游戏并分配国家。已有存档无需再次初始化；账号恢复见下文。

### 4. 正式开放 HTTPS

将域名解析到服务器，开放 TCP 80、443，然后修改 `.env.docker`：

```dotenv
APP_ENV=production
APP_ORIGIN=https://game.example.com
SITE_ADDRESS=game.example.com
WEB_BIND=0.0.0.0
HTTP_PORT=80
HTTPS_PORT=443
```

将 `game.example.com` 替换为自己的域名，再执行启动命令：

```sh
docker compose --env-file .env.docker up -d --build --wait --wait-timeout 180
```

网页容器使用 Caddy，自动申请、续期 HTTPS 证书并将 HTTP 重定向到 HTTPS。生产模式登录 Cookie 带有 `Secure`，必须通过 HTTPS 访问。本机 HTTP 试玩保留 `APP_ENV=development`。

若服务器已有反向代理并占用 80/443，可保留网页仅监听 `127.0.0.1:8080`、`SITE_ADDRESS=:80`，由已有代理转发并提供 HTTPS；`APP_ORIGIN` 仍填写最终 HTTPS 地址，`APP_ENV=production`。API 仅信任 Caddy 这一层代理，Caddy 默认不信任外部伪造的转发头；额外代理的真实来源地址信任应按该代理的固定地址配置。

### 主要配置

| 变量                                         | 作用                                                   |
| -------------------------------------------- | ------------------------------------------------------ |
| `POSTGRES_PASSWORD`                          | 数据库密码，首次部署必须替换                           |
| `POSTGRES_USER` / `POSTGRES_DB`              | 默认 `srilanka`；已有数据卷不会因修改变量而重新初始化  |
| `APP_ENV`                                    | 本机 HTTP 为 `development`；正式 HTTPS 为 `production` |
| `APP_ORIGIN`                                 | 浏览器实际访问的协议、主机和端口，不带路径             |
| `SITE_ADDRESS`                               | `:80` 提供 HTTP；域名启用 Caddy 自动 HTTPS             |
| `WEB_BIND` / `HTTP_PORT` / `HTTPS_PORT`      | 默认 `127.0.0.1:8080/8443`                             |
| `REGISTRATION_MODE`                          | `invite` 邀请注册、`closed` 关闭注册、`open` 自由注册  |
| `BACKUP_ENABLED`                             | 默认 `true`，启用定时备份及发布前恢复点                |
| `BACKUP_INTERVAL_MINUTES` / `BACKUP_KEEP`    | 默认每 60 分钟备份，保留最近 48 份定时备份             |
| `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_MODEL` | 可选模型服务；密钥或模型为空时不启用                   |
| `LLM_BASE_URL`                               | 自定义兼容 API 的基础地址，可省略以使用供应商默认地址  |
| `IMAGE_TAG`                                  | 本地构建镜像标签，默认 `local`                         |

修改环境变量后使用 `up -d` 重建容器；单独 `restart` 不会更新环境变量。数据库密码初始化后若需更换，需同时修改数据库角色密码与部署配置，不能只改 `.env.docker`。

### 服务组成

```text
浏览器 → Caddy（静态网页 / HTTPS / API 代理）→ API
                                              ├─ PostgreSQL 17
                                              ├─ Redis 8
                                              └─ 备份数据卷
```

API 使用 Node.js 24，以非 root 用户运行，镜像带 PostgreSQL 17 的备份客户端。基础运行不需要对象存储，当前游戏存档均在 PostgreSQL。

worker 目前仅保留后台任务骨架，正常游玩无需启动。需要验证时可使用：

```sh
docker compose --env-file .env.docker --profile worker up -d --build --wait
```

## 维护

### 状态和日志

```sh
docker compose --env-file .env.docker ps -a
docker compose --env-file .env.docker logs --tail=100 api web migrate
docker compose --env-file .env.docker logs -f api
```

健康检查：`http://localhost:8080/api/v1/health`，正式部署改用自己的 HTTPS 域名。正常返回 `data.status: "ok"`、数据库和 Redis 均为 `up`。

### 备份、导出和恢复

自动备份默认开启，API 启动后和每次结算发布前都会生成恢复点。镜像已包含备份工具，不需要在宿主机安装 PostgreSQL 客户端。

```sh
# 手动备份，终端会输出容器内的备份路径。
docker compose --env-file .env.docker exec api node packages/database/dist/backup-cli.js create

# 用实际备份目录替换 BACKUP_ID。
docker compose --env-file .env.docker exec api node packages/database/dist/backup-cli.js verify --backup /app/backups/BACKUP_ID

# 恢复到新数据库，不覆盖当前存档。
docker compose --env-file .env.docker exec api node packages/database/dist/backup-cli.js restore --backup /app/backups/BACKUP_ID --target-name srilanka_restore_20261021
```

备份包含数据库、文件校验和、对应源码与迁移，存放在 `backup-data` 数据卷。手动备份和发布前恢复点不按定时保留策略删除，需要维护者另行归档。

先在宿主机创建 `backups/docker` 目录，然后可以导出：

```sh
docker compose --env-file .env.docker cp api:/app/backups/. ./backups/docker
```

请将完整备份目录另存到其他设备；同一台机器上的数据卷不等于异地备份。恢复演练、导入备份和切换恢复库见 [备份与恢复说明](infrastructure/database/BACKUP.md)。正式切换恢复库前应先停止写入，再把 `POSTGRES_DB` 指向已恢复的新库并重建服务。

### 更新和停止

更新前先执行手动备份并保存当前 Git 提交号，再更新源码：

```sh
docker compose --env-file .env.docker stop web api
git pull
docker compose --env-file .env.docker build --pull api web
docker compose --env-file .env.docker up -d --wait --wait-timeout 180
```

如启用了 worker，同样停止并重新构建 worker。升级自动应用新的 SQL 迁移，不自动回退数据库；回退时使用对应源码和恢复到新库的备份。

```sh
# 移除容器，保留持久化数据。
docker compose --env-file .env.docker down
```

不要给保留存档的环境添加 `down --volumes` 或 `down -v`，这会删除数据库、备份和证书卷。

### 账号恢复

```sh
docker compose --env-file .env.docker exec api node apps/api/dist/reset-account.js --username USERNAME --reason "本人申请恢复账号"
```

命令仅显示一次有期限的重置码；将其交给账号本人，在登录页选择“使用重置码”设置新密码。不要用开发种子覆盖正式账号。

### 可选模型辅助

在私有 `.env.docker` 中填写 `LLM_PROVIDER=deepseek` 或 `glm`、相应密钥和模型名称，重建 API 后由主持人在“剧本与规则”开启本局辅助。兼容接口还需填写 `LLM_BASE_URL`，不要包含 `/chat/completions`。

密钥只在服务器使用，不以 `VITE_` 开头，不进入网页包。用途、长度和权限限制见 [模型辅助说明](docs/模型辅助配置与使用.md)。

## 源码开发

需要 Node.js 24 和 pnpm 11.10.0。Windows 使用 `pnpm.cmd` 可避开 PowerShell 对脚本执行策略的限制；其他平台使用 `pnpm`。

```sh
corepack enable
pnpm install --frozen-lockfile
```

复制 `.env.example` 为根目录 `.env`，配置独立开发库。旧的 `infrastructure/compose.yaml` 保留供本地依赖开发使用，与根目录部署 Compose 分开；不要把两套配置指向同一份存档。

```sh
docker compose -f infrastructure/compose.yaml up -d database redis
pnpm build:packages
pnpm db:migrate
pnpm --filter @srilanka/api dev
```

另开终端启动网页：

```sh
pnpm --filter @srilanka/web dev
```

默认网页 `http://localhost:5173`，API `http://localhost:3000`。端口变化时同步修改 `.env` 中的 `PORT`、`VITE_API_PROXY_TARGET` 和 `WEB_ORIGIN`。开发账号和演练种子只用于隔离开发库，见 `.env.example` 与 [试玩说明](docs/界河危机试玩说明.md)。

### 检查与测试

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

接口集成测试会清理测试数据，必须使用独立 `srilanka_test` 数据库和 Redis 编号，不能使用开发或正式存档：

```sh
pnpm --filter @srilanka/api test:integration
pnpm --filter @srilanka/database test:integration
```

部署回归可使用下面的独立演练（需要本机 Node.js 24 和 Docker）：

```sh
node infrastructure/scripts/smoke-deploy.mjs
```

脚本使用随机名称、独立端口和全新数据卷，构建并验证迁移、静态资源、主持人初始化、登录、建局、备份恢复及重启保留。结束时只删除此次演练的容器和数据卷，不读取 `.env.docker`，不连接正式存档。它会校验 HTTPS 配置，但公网证书签发仍需真实域名。

## 目录和文档

| 路径                                  | 内容                                  |
| ------------------------------------- | ------------------------------------- |
| `apps/web`                            | React + Vite 网页、地图与操作面板     |
| `apps/api`                            | Fastify API、权限、游戏规则与结算事务 |
| `apps/worker`                         | 后台任务骨架                          |
| `packages/contracts`                  | 前后端共享数据契约                    |
| `packages/database`                   | PostgreSQL、迁移、备份与恢复          |
| `packages/config` / `packages/logger` | 配置与日志                            |
| `compose.yaml`                        | 完整部署环境                          |
| `infrastructure/docker`               | Web、API 和 worker 镜像构建           |
| `docs`                                | 当前实现约定、验收记录和设计资料      |

继续开发前建议先看 [当前开发基线与剧本原则](docs/当前开发基线与剧本原则.md)；早期设计稿与当前实现存在差异，以当前基线和代码为准。另见 [规则与主持人裁决](docs/斯里兰卡核心游戏规则与主持人裁决说明书.md)、[存档维护](infrastructure/database/BACKUP.md) 和 [模型辅助](docs/模型辅助配置与使用.md)。

## 常见问题

- **Docker 无法连接引擎**：启动 Docker Desktop 并确认使用 Linux 容器；`docker version` 应同时显示 Client 和 Server。
- **迁移退出非零**：查看 `logs migrate`，解决后重新执行 `up -d`。不要修改已应用的 SQL 文件或通过删除数据卷解决存档问题。
- **网页能打开但登录后仍未登录**：检查 HTTP 是否误配 `APP_ENV=production`、是否混用 `localhost` 和 `127.0.0.1`、`APP_ORIGIN` 是否与浏览器一致。
- **端口被占用**：修改 `HTTP_PORT` / `HTTPS_PORT`，同步调整访问地址和 `APP_ORIGIN`。
- **发布提示备份失败**：检查 API 日志、备份卷权限和磁盘空间。发布尚未生效，修复后可以重试。

部署机制参考 [Compose 启动依赖](https://docs.docker.com/compose/how-tos/startup-order/) 与 [Caddy 官方运行说明](https://caddyserver.com/docs/running#docker-compose)。
