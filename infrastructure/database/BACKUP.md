# 存档备份与恢复

这是服务器维护命令。备份包含全服账号、密码哈希、会话、私聊、所有国家情报与游戏记录，不通过玩家或主持人的网页下载。不要把 backups 目录提交 Git 或放到公开静态目录。

全局 AI 配置中的 API Key 已加密存入数据库，对应的解密文件位于备份卷 `.private/assistant.key`。同一 NAS 上更新或重建容器时保留原备份卷即可。迁移设备时，除选中的备份目录外，还应单独保留该文件并限制读取权限；若只恢复数据库而丢失该文件，可由系统管理员在网页重新填写 API Key。完整导出 `/app/backups/.` 会包含该私有文件，应作为敏感备份保管。

## 准备

Docker 部署无需在宿主机安装 PostgreSQL 客户端，API 镜像自带 PostgreSQL 17 的工具，数据与备份保存在独立数据卷。以下 Docker 命令在仓库根目录执行，配置见[部署 README](../../README.md)。

```sh
docker compose --env-file .env.docker exec api node packages/database/dist/backup-cli.js create
docker compose --env-file .env.docker exec api node packages/database/dist/backup-cli.js verify --backup /app/backups/BACKUP_ID
docker compose --env-file .env.docker exec api node packages/database/dist/backup-cli.js restore --backup /app/backups/BACKUP_ID --target-name srilanka_restore_drill
```

容器路径固定为 `/app/backups`。先在宿主机创建导出目录，再用 `docker compose --env-file .env.docker cp api:/app/backups/. ./backups/docker` 导出完整备份。不要将备份放在网页静态目录。

若从宿主机导入备份，使用新的备份编号目录，确保没有覆盖现有备份，再修正容器内文件所有者：

```sh
docker compose --env-file .env.docker cp ./backups/docker/BACKUP_ID api:/app/backups/BACKUP_ID
docker compose --env-file .env.docker exec --user root api chown -R node:node /app/backups/BACKUP_ID
```

导入后先执行 `verify`，再按上面的 `restore` 恢复到新数据库。恢复完成仍不改变正在使用的库；正式切换前先停止网页、API 和已启用的 worker，修改 `POSTGRES_DB` 为已恢复的数据库名，再重建服务并核对存档。外部导入的源码快照应保留，后续运行代码和迁移应与恢复点对应。

运行环境需要 Node.js 22 以上、项目指定的 pnpm，以及与 PostgreSQL 服务器主版本一致的 `pg_dump` 和 `pg_restore`。默认从 PATH 查找；也可在本机 `.env` 指定 `POSTGRES_BIN_DIR`。数据库运行账号备份时需能读取全部项目表，恢复时另需 CREATEDB 权限。建议恢复演练在维护环境中进行。

命令使用 `.env` 或当前进程的 `DATABASE_URL`。执行前确认数据库名。终端命令以下以 PowerShell 为例，Linux 使用 `pnpm` 代替 `pnpm.cmd`。不要把生产密码写进文档或共享的命令记录。

## 手动备份和检查

在项目根目录执行：

```powershell
pnpm.cmd db:backup
pnpm.cmd db:backup:verify --backup 'C:/保存位置/备份编号'
```

默认输出到项目根目录 `backups/<UTC时间-随机编号>/`，完成后输出路径和数据库名。可用 `--directory` 或 `BACKUP_DIRECTORY` 指定独立磁盘路径。每份包含：

- `database.dump`：PostgreSQL 自定义格式，来自同一个只读事务快照。
- `manifest.json`：数据库与工具版本、迁移及文件校验值、各表行数和内容摘要。
- `source/`：当时工作区源码、迁移、锁文件、运行配置样例与项目文档，包括未提交和未追踪的项目代码。

源码采用项目目录白名单；不复制 `.git`、依赖与构建缓存、真实 `.env`、私钥、PDF 或根目录私人文件。备份期间源码变化会报告失败，稍后重试。已执行迁移必须能与源码逐一匹配，避免生成无法对应的版本。完整备份检查通过才移出 `.partial` 临时目录；失败目录保留诊断，不能拿来恢复，也不会被保留策略删除。

`verify` 检查文件哈希、大小、源码、已执行迁移和归档目录。实际能否完整使用还需下面的恢复演练。校验值用于发现损坏，并非防恶意篡改的数字签名。

## 自动备份和发布前恢复点

API 启动配置：

```dotenv
BACKUP_ENABLED=true
BACKUP_INTERVAL_MINUTES=60
BACKUP_KEEP=48
BACKUP_DIRECTORY=/独立磁盘/srilanka-backups
```

启用后，API 启动立即备份，之后每隔指定分钟再备份。任务顺序执行；失败会记录错误并在下一间隔重试。保留最近 48 份同一主机、端口、数据库名的定时备份；仅在新备份成功后清理旧的。手动备份和发布前恢复点不自动删除，维护者需按磁盘空间另行归档。可以单独运行 `pnpm.cmd db:backup:watch --interval-minutes 60 --keep 48`，避免与 API 的定时任务重复启用。

启用时，每次通过基本校验的结算发布会在业务数据写入之前再备份，清单记录游戏、回合和结算修订号。该步骤失败则回滚发布并给主持人明确提示。重复发布已发布的同一修订不会额外备份。如果后续业务校验失败，发布仍回滚，已经完成的恢复点保留。未启用时沿用原发布流程；生产环境应在部署检查中确认开关和备份成功日志。

这只是本机独立文件备份。机器或磁盘损坏仍可能同时损失数据库与本机备份。正式运行需将完整备份目录复制到另一台设备或独立存储，并定期检查最新成功记录、磁盘空间和恢复能力。当前没有云端上传、备份失败推送或对象存储附件归档；项目目前的游戏状态均在 PostgreSQL，Redis 缓存无需恢复。

## 恢复到新数据库

```powershell
pnpm.cmd db:restore --backup 'C:/保存位置/备份编号' --target-name srilanka_restore_20261017
```

恢复目标使用维护者当前 `DATABASE_URL` 所指服务器，要求与备份 PostgreSQL 主版本一致。只接受 `srilanka_restore_` 开头的新名称。工具先检查整份备份，再创建新数据库；目标已存在时停止。流程没有覆盖、清库或自动删除数据库的步骤。

恢复使用单个事务，随后比较全部 public 表的行数和逐行内容摘要；成功输出 `restore-verified`。如果新库创建后的恢复失败，保留该新库用于检查，原库不受影响。不要把部分恢复的库接入服务。

完成后，在另一个工作目录取用备份中的 `source/`：

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd build:packages
```

按 `.env.example` 重建本机私有配置，将 `DATABASE_URL` 的数据库名改成刚恢复的新库。用独立 API/Web 端口及独立 Redis 编号启动，避免两个服务混用。先核对账号登录、当前回合、历史、私聊与玩家权限，再决定是否切换。**不要在确认版本和迁移兼容性之前直接对恢复库执行新版本迁移。** 若以 API 启动演练环境，先设 `BACKUP_ENABLED=false`，避免不必要的演练备份。切换正式服务是另外的维护操作，本命令不会自动切换。

## WSL / 容器中的客户端

通过 `POSTGRES_COMMAND_PREFIX_JSON` 指定无 shell 的参数数组。工具通过子进程环境传递连接参数和密码，不写入命令参数或清单。

例如 Windows 已在 Ubuntu 安装 PostgreSQL 16 客户端：

```dotenv
POSTGRES_COMMAND_PREFIX_JSON=["wsl.exe","-d","Ubuntu","--"]
POSTGRES_BIN_DIR=/usr/lib/postgresql/16/bin
```

客户端在容器内时，使用 `docker exec -i` 并用 `-e` 传递 PGHOST、PGPORT、PGUSER、PGPASSWORD、PGDATABASE、PGCONNECT_TIMEOUT，以及需要的 PGSSL 配置。容器内必须能通过指定地址访问数据库。自动化测试示例见 `.github/workflows/ci.yml`。不依赖 PowerShell 的二进制重定向。
