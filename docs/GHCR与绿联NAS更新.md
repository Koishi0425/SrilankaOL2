# GHCR 与绿联 NAS 更新

GitHub Actions 构建镜像并上传 GHCR，NAS 只需下载镜像。默认通过 Cloudflare Tunnel 访问，域名、token、账号和存档保存在现有部署中。

## 已有绿联项目首次切换

在绿联 Docker 应用中打开原来的 `srilankaol2` 项目，进入 Compose 配置。继续使用这个项目，不另建项目。

1. 保留原配置副本及原环境变量。记下项目名称和各数据卷的名称、挂载方式。
2. 参考仓库根目录 [compose.ghcr.yaml](../compose.ghcr.yaml) 更新配置。该文件没有 `build` 字段，不需要 NAS 构建镜像。顶部 `name` 应与原项目一致：截图中的项目使用 `srilankaol2`，因此应设为 `name: srilankaol2`。
3. 保持原数据库密码、数据库名、`APP_ORIGIN`、Tunnel token、端口与存储卷配置。若原来的卷显式指定了 `name` 或使用外部卷，也继续使用原设置。镜像切换不能改变数据库所用的数据卷。
4. 将 `IMAGE_TAG=local` 改为 `IMAGE_TAG=latest`。若在 Compose 中直接写镜像地址，使用下表的完整地址，不再保留 `build`。
5. 保存配置，在这个项目中执行拉取镜像并更新整个项目。

| 服务 | 镜像 |
| --- | --- |
| `api`、`migrate` | `ghcr.io/koishi0425/srilankaol2-api:latest` |
| `web` | `ghcr.io/koishi0425/srilankaol2-web:latest` |
| `worker`（可选） | `ghcr.io/koishi0425/srilankaol2-worker:latest` |

新配置的 `migrate` 服务使用 `node packages/database/dist/deploy.js`，并挂载原来的 `backup-data:/app/backups`。已有数据库会先备份，日志显示 `deployment-backup-complete` 后才执行迁移；完成时显示 `deployment-migrated`。备份失败会退出并阻止后续 API 启动，查看该服务日志处理后重试即可。首次空库安装无需创建空库备份。

Tunnel 仍默认启动，Cloudflare 的 Published application 指向 `http://web:8082`。新镜像含备份校验的 `write EPIPE` 修复。

## 后续更新

在绿联 Docker 管理中启用镜像更新检测。收到更新提示后，在原项目中点击更新，拉取并重建整个项目，让 `migrate`、`api`、`web` 使用同次发布的镜像。`migrate` 和 `api` 共用同一 API 镜像。无需登录 SSH、拉取 Git 源码或在 NAS 构建。

更新期间服务会短暂中断。迁移完成后 API 与网页恢复健康，cloudflared 继续连接原隧道。原账号和游戏继续使用，回网页刷新后可重试结算发布。项目需要新增配置项、数据卷或外部服务时，仍需按该次发布说明修改 Compose。

定时备份和发布前备份继续由 API 执行。迁移前备份为手动恢复点，不受定时备份保留数量清理；维护者需定期导出、归档这些恢复点。

## 首次发布：公开包

GHCR 新包默认是 Private。仓库维护者需要一次性将 `srilankaol2-api`、`srilankaol2-web`、`srilankaol2-worker` 设置为 Public，之后 NAS 可匿名拉取，无需配置 GitHub token。

在 GitHub 仓库右侧 Packages 中依次打开三个包，点击 **Package settings → Change visibility → Public**，按页面提示确认。后续上传新版本会沿用公开状态。

如果 NAS 拉取时出现 `denied` 或 `unauthorized`，先确认包已公开，以及镜像地址、标签是否正确。

## 自动发布流程

主分支的常规检查和 Docker 演练通过后，CI 在原生 amd64、arm64 运行器分别构建 API、网页和 worker，发布以完整提交编号标记的镜像。随后合并架构清单，从 GHCR 拉取这些镜像运行完整部署演练，覆盖迁移前备份、备份失败阻止迁移、登录、建局、备份恢复与重启保留。演练通过后才将三个镜像的 `latest` 指向此次发布。

发布使用仓库工作流自带的 `GITHUB_TOKEN`，不需要另建长期写入凭据。源码、SQL、锁文件等随镜像发布；实际 `.env.docker`、数据库、备份、私钥与根目录个人文件由 `.dockerignore` 排除。

需要固定版本时，将三个镜像统一设为 `sha-完整提交编号`；该标签不参与跟随 `latest` 的面板更新。恢复旧数据库应按 [备份与恢复说明](../infrastructure/database/BACKUP.md) 操作，单独选择旧镜像不会回退已执行的数据库迁移。

参考：[绿联项目镜像更新](https://support.ugnas.com/detail/article/zh-CN/289)、[GHCR 容器注册表](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)、[公开包设置](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)。
