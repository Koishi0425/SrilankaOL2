# SrilankaOL

供主持人和玩家共同使用的回合制战略游戏辅助网站。玩家扮演国家或角色，提交文字政策；主持人审核、追问补充、编写反馈，再统一发布结算。玩法参考《欧陆风云》的国家战略，但行动与故事仍由参与者自由表达、主持人裁决。

目前包含地图与战争迷雾、国家资料、经济与贸易、外交、军事、政府、政策讨论、回合结算和历史记录。模型辅助可选，用于已发布结果速览与主持人反馈起草，不自动裁决或发布。

政策按玩家与回合整份编写、一次提交、统一评阅；分项分类只作提示，可重复或自拟标题。旧记录自动汇总，详见[整份回合政策](docs/整份回合政策.md)。

## GHCR 镜像部署（NAS 推荐）

NAS 可直接拉取 GitHub 构建好的镜像，无需本机安装构建工具或保存项目源码。使用 [compose.ghcr.yaml](compose.ghcr.yaml)，默认通过 Cloudflare Tunnel 开放网站：

| 服务        | 镜像                                           |
| ----------- | ---------------------------------------------- |
| API、迁移   | `ghcr.io/koishi0425/srilankaol2-api:latest`    |
| 网页        | `ghcr.io/koishi0425/srilankaol2-web:latest`    |
| 可选 worker | `ghcr.io/koishi0425/srilankaol2-worker:latest` |

首次将现有 NAS 项目切换到上述配置后，后续可直接在绿联 Docker 的项目管理中点击更新。保持原项目名、私有环境变量和数据卷；原来设置了 `IMAGE_TAG=local` 时改为 `latest`。迁移服务会在已有存档上先创建并校验备份，成功后执行待应用迁移，再启动 API 和网页。详细步骤及首次公开镜像设置见 [GHCR 与绿联 NAS 更新](docs/GHCR与绿联NAS更新.md)。

主分支通过 CI 后自动构建 amd64、arm64 镜像，镜像拉取演练通过后才更新 `latest`。每次发布另保留 `sha-完整提交编号` 标签供固定版本使用。公开镜像可匿名拉取；首次发布时需在 GitHub Packages 将三个包设为 Public。

命令行首次部署可使用下文的 `.env.docker` 配置，将 Compose 文件切换为：

```sh
docker compose --env-file .env.docker -f compose.ghcr.yaml pull
docker compose --env-file .env.docker -f compose.ghcr.yaml up -d --wait --wait-timeout 180
```

## Docker 源码构建部署

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

默认通过 Cloudflare Tunnel 开放网站。编辑 `.env.docker`，将生成的随机值填入 `POSTGRES_PASSWORD`，将 `APP_ORIGIN` 改为自己的 HTTPS 域名，并填入 `CLOUDFLARE_TUNNEL_TOKEN`；隧道创建和域名配置见第 4 节。数据库密码使用字母、数字、`-`、`_`，避免连接串中的字符转义问题。

`.env.docker` 是私有部署配置，不提交 Git，也不复制进镜像。根目录 `.env` 留给源码开发使用。每次部署命令都显式指定 `--env-file .env.docker`，避免混用本地端口和数据库地址。

### 2. 构建并启动

```sh
docker compose --env-file .env.docker config --quiet
docker compose --env-file .env.docker up -d --build --wait --wait-timeout 180
docker compose --env-file .env.docker ps -a
```

访问 `APP_ORIGIN` 中配置的 HTTPS 地址。首次构建需要下载基础镜像与依赖；`migrate` 容器正常状态为 `Exited (0)`，应用服务应为 `healthy`，`cloudflared` 应为运行状态。Tunnel 随上述命令默认启动，无需额外 profile；其日志出现 `Registered tunnel connection` 才表示隧道已连接。

启动会等待 PostgreSQL 就绪，执行全部尚未应用的数据库迁移，迁移成功后才启动 API 和网页。重复启动不会重置存档。数据库、Redis、备份和 HTTPS 证书均使用持久化数据卷；API 和数据库端口不发布到宿主机。

仅在本机 HTTP 试玩时，将 `APP_ENV=development`、`APP_ORIGIN=http://localhost:8080`，清空 `CLOUDFLARE_TUNNEL_TOKEN`，并显式跳过隧道：

```sh
docker compose --env-file .env.docker up -d --build --wait --wait-timeout 180 --scale cloudflared=0
```

然后访问 **http://localhost:8080**。

### 3. 创建第一位主持人

默认采用邀请注册，不提供预设账号和密码。在终端执行：

```sh
docker compose --env-file .env.docker exec api node apps/api/dist/bootstrap-host.js
```

按提示输入用户名、显示名称及密码。密码至少 6 个字符，输入时不回显。注册、登录、改密和重置密码采用同一下限。此命令仅在数据库完全没有账号时创建第一位用户；已有账号时会拒绝，不会重置账号、创建示例游戏或覆盖存档。

之后在网页登录，创建游戏、设置国家和规则。主持人可生成账号邀请码供其他玩家注册，再把玩家加入游戏并分配国家。已有存档无需再次初始化；账号恢复见下文。

### 4. Cloudflare Tunnel 公网入口（默认）

网站默认由 Cloudflare Tunnel 发布，无需服务器拥有公网 IP 或开放入站 80/443。TLS 在 Cloudflare 边缘终止，cloudflared 通过容器网络访问 Caddy 的内部 HTTP 入口，宿主机端口仅监听 `127.0.0.1`。

1. 在 Cloudflare Zero Trust 的 **Networking → Tunnels** 创建 remotely-managed tunnel（选择 Docker 安装方式），复制安装命令中的 token（`eyJ...` 字符串）。
2. 给隧道添加 Published application：子域名填例如 `game.example.com`，Service URL 填 `http://web:8082`。`web` 是 Compose 服务名，8082 是专供隧道的内部入口；不要填 `localhost`、`https://` 或普通的 80 端口。
3. 修改 `.env.docker`：

```dotenv
APP_ENV=production
APP_ORIGIN=https://game.example.com
SITE_ADDRESS=:80
WEB_BIND=127.0.0.1
HTTP_PORT=8080
HTTPS_PORT=8443
CLOUDFLARE_TUNNEL_TOKEN=replace-with-the-tunnel-token
```

`SITE_ADDRESS` 保持 `:80`，不要写域名，否则 Caddy 会尝试向公网申请证书；`WEB_BIND=127.0.0.1` 确保无法通过服务器 IP 绕过 Cloudflare 直接访问。

4. 保存 token 后直接启动，cloudflared 默认随应用启动，无需 profile 参数：

```sh
docker compose --env-file .env.docker up -d --build --wait --wait-timeout 180
docker compose --env-file .env.docker ps -a
docker compose --env-file .env.docker logs -f cloudflared
```

日志出现 `Registered tunnel connection` 后，访问 `https://game.example.com`。应用健康检查仍可走 `http://localhost:8080/api/v1/health`；它只确认本地应用状态，隧道是否连通以 cloudflared 日志和公网访问为准。默认启动需要有效 token；本机试玩或直接 HTTPS 部署需清空 token 并显式使用 `--scale cloudflared=0`。若同时使用 worker，可加 `--profile worker`。

cloudflared 需要出站访问 Cloudflare 的 UDP/TCP 7844，不需要开放入站端口。隧道模式保持 `WEB_BIND=127.0.0.1`，不要把容器的 8082 端口映射到宿主机。只有内部 8082 入口信任 `CF-Connecting-IP`，普通 HTTP/HTTPS 入口忽略客户端伪造的转发头；API 收到 Caddy 校验后的单一访客地址，登录和注册限流仍按玩家分别计算。旧 PR 配置若使用 `http://web:80`，请改为 `http://web:8082`，否则访客可能共用代理的限流额度。

### 5. 直接 HTTPS 部署（可选）

需要由服务器直接开放 HTTPS 时，将域名解析到服务器，开放 TCP 80、443，然后修改 `.env.docker`：

```dotenv
APP_ENV=production
APP_ORIGIN=https://game.example.com
SITE_ADDRESS=game.example.com
WEB_BIND=0.0.0.0
HTTP_PORT=80
HTTPS_PORT=443
CLOUDFLARE_TUNNEL_TOKEN=
```

将 `game.example.com` 替换为自己的域名，显式跳过隧道：

```sh
docker compose --env-file .env.docker up -d --build --wait --wait-timeout 180 --scale cloudflared=0
```

网页容器使用 Caddy，自动申请、续期 HTTPS 证书并将 HTTP 重定向到 HTTPS。生产模式登录 Cookie 带有 `Secure`，必须通过 HTTPS 访问。

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
| `CLOUDFLARE_TUNNEL_TOKEN`                    | 默认 Tunnel 部署必填；本机试玩或直接 HTTPS 部署留空    |
| `IMAGE_TAG`                                  | 本地构建镜像标签，默认 `local`                         |

修改环境变量后使用 `up -d` 重建容器；单独 `restart` 不会更新环境变量。数据库密码初始化后若需更换，需同时修改数据库角色密码与部署配置，不能只改 `.env.docker`。

### 服务组成

```text
浏览器 → Cloudflare 边缘（HTTPS）→ cloudflared → Caddy → API
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

使用 GHCR 的 NAS 部署可直接更新整个项目镜像，见 [NAS 更新说明](docs/GHCR与绿联NAS更新.md)。下述脚本用于源码构建部署。

首次部署完成后，在服务器仓库内执行一条命令即可更新：

```sh
sh infrastructure/scripts/update.sh
```

命令需要服务器已有 Git、Docker 和 Compose v2.24 以上，跟踪上游分支且工作区干净；无需安装 Node.js 或 pnpm。首次采用此更新入口时，先 `git pull --ff-only` 获取脚本，之后均可直接使用上述命令。Windows 的 Git Bash 也可执行；PowerShell 可使用 `& 'C:\Program Files\Git\bin\bash.exe' infrastructure/scripts/update.sh`。

脚本自动快进拉取当前分支、构建新版 API/网页，然后短暂停止应用写入，使用原运行镜像创建并校验恢复点，再执行数据库迁移、启动新版本并等待健康检查。原来正在使用的 worker 会一同更新；已配置 token 或正在运行的 cloudflared 会在网页恢复后按当前配置启动。原 Compose 项目名、私有配置、数据库、Redis、备份和证书数据卷保留，无需重新建局或创建账号。构建阶段原应用继续运行；迁移和重启期间会短暂无法访问，因此应在本轮文字保存后更新。

自定义部署配置使用 `sh infrastructure/scripts/update.sh --env-file /path/to/private.env`。若已手动拉取代码或采用离线更新，可加 `--no-pull`。脚本不会清理本地修改、运行种子或删除数据卷，也不会在更新时升级数据库/Redis镜像。

构建失败时原应用继续运行。备份或迁移失败时停止后续发布；排查后重新执行同一命令可继续，重试须保留失败时的代码和配置，避免再拉取其他版本。恢复点成功后保留在备份卷，原运行镜像在更新期间用于备份，勿在此期间清理 Docker 镜像。更新进度保存在 Git 目录中的 `srilanka-update-state`；只有健康检查通过才清除，且并发更新会被拒绝。进程被强制终止后如遗留 `srilanka-update.lock` 空目录，先确认没有更新进程，再移除该空目录重试。更新不自动回退已执行的 SQL 迁移；需要回退时使用恢复点中对应源码和恢复到新库的存档，见 [备份与恢复说明](infrastructure/database/BACKUP.md)。

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
| `compose.ghcr.yaml`                   | NAS 与服务器直接拉取镜像的部署环境    |
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
