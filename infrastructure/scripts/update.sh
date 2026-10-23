#!/bin/sh

# Parse the complete function before pulling: an update may replace this script.
main() {
  set -eu
  umask 077
  root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
  cd "$root"
  env_file="$root/.env.docker"
  pull=1
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env-file)
        [ "$#" -ge 2 ] || { printf '%s\n' '缺少 --env-file 路径。' >&2; exit 1; }
        env_file=$2
        shift 2
        ;;
      --no-pull) pull=0; shift ;;
      --help|-h)
        printf '%s\n' '用法：sh infrastructure/scripts/update.sh [--env-file PATH] [--no-pull]' \
          '默认拉取当前分支的上游版本，备份存档、执行迁移并更新应用。' \
          '--no-pull 用于已经手动拉取代码或离线更新的服务器。'
        exit 0
        ;;
      *) printf '未知参数：%s\n' "$1" >&2; exit 1 ;;
    esac
  done
  [ -f "$env_file" ] || { printf '找不到部署配置：%s\n' "$env_file" >&2; exit 1; }
  for tool in git docker; do
    command -v "$tool" >/dev/null 2>&1 || { printf '缺少命令：%s\n' "$tool" >&2; exit 1; }
  done
  [ "$(git rev-parse --is-inside-work-tree)" = true ] && \
    [ -z "$(git rev-parse --show-prefix)" ] || {
    printf '%s\n' '请在独立的 SrilankaOL2 Git 仓库内更新。' >&2; exit 1;
  }
  [ -z "$(git status --porcelain)" ] || {
    printf '%s\n' '仓库有未提交或未追踪的文件，请先保存这些修改再更新。私有配置和备份不受影响。' >&2
    exit 1
  }
  docker info >/dev/null
  docker compose version >/dev/null
  lock_dir=$(git rev-parse --git-path srilanka-update.lock)
  mkdir "$lock_dir" 2>/dev/null || {
    printf '%s\n' '已有更新正在执行。如上次进程被强制终止，请确认无更新进程后移除 Git 目录中的 srilanka-update.lock 空目录。' >&2
    exit 1
  }
  state=$(git rev-parse --git-path srilanka-update-state)
  maintenance=0
  cleanup() {
    status=$?
    trap - 0
    rmdir "$lock_dir" 2>/dev/null || :
    if [ "$status" -ne 0 ] && [ "$maintenance" -eq 1 ]; then
      printf '%s\n' '更新未完成，应用可能处于维护状态。修复错误后重新执行同一命令，会继续本次更新。' \
        '不会自动回退已执行的数据库迁移；需要回退时请按备份恢复说明操作。' >&2
    fi
    exit "$status"
  }
  trap cleanup 0
  trap 'exit 130' 2
  trap 'exit 143' 15
  env_checksum=$(cksum < "$env_file")
  compose() {
    docker compose --env-file "$env_file" -f "$root/compose.yaml" -p "$project" --profile worker "$@"
  }
  if [ -d "$state" ]; then
    [ "$(cat "$state/environment")" = "$env_checksum" ] && \
      [ "$(cat "$state/revision")" = "$(git rev-parse HEAD)" ] || {
      printf '%s\n' '上次更新尚未完成；请保持当时的代码版本和部署配置后重试。' >&2; exit 1;
    }
    project=$(cat "$state/project")
    worker=$(cat "$state/worker")
    maintenance=1
    printf '%s\n' '继续上次更新，本次不再拉取新代码。'
  else
    docker compose --env-file "$env_file" -f "$root/compose.yaml" config --quiet
    project=$(docker compose --env-file "$env_file" -f "$root/compose.yaml" config --format yaml | sed -n 's/^name: //p')
    worker=0
  fi
  case "$project" in
    ''|*[!a-z0-9_-]*) printf '%s\n' '无法识别原部署的 Compose 项目名。' >&2; exit 1 ;;
  esac
  compose config --quiet
  configuration=$(compose config --format yaml | cksum)
  if [ -d "$state" ]; then
    [ "$(cat "$state/configuration")" = "$configuration" ] || {
      printf '%s\n' '上次更新的实际部署配置已变化，请还原配置和终端环境变量后重试。' >&2; exit 1;
    }
  fi
  for service in database redis; do
    [ -n "$(compose ps --status running --quiet "$service")" ] || {
      printf '原部署的 %s 服务未运行，请先启动原服务。\n' "$service" >&2; exit 1;
    }
  done
  if [ ! -d "$state" ]; then
    api_id=$(compose ps --all --quiet api)
    [ -n "$api_id" ] || { printf '%s\n' '尚未找到已部署的 API，请先完成首次部署。' >&2; exit 1; }
    previous_image=$(docker inspect --format '{{.Image}}' "$api_id")
    [ -z "$(compose ps --status running --quiet worker)" ] || worker=1
    if [ "$pull" -eq 1 ]; then
      git symbolic-ref --quiet HEAD >/dev/null && \
        git rev-parse --verify '@{upstream}' >/dev/null 2>&1 || {
        printf '%s\n' '当前分支没有上游；请先设置跟踪分支，或手动更新代码后使用 --no-pull。' >&2; exit 1;
      }
      git pull --ff-only
    fi
  fi
  compose config --quiet
  printf '%s\n' '构建新版本，现有应用在构建期间继续运行。'
  if [ "$worker" -eq 1 ]; then
    compose build api web worker
  else
    compose build api web
  fi
  if [ ! -d "$state" ]; then
    mkdir "$state"
    printf '%s\n' "$env_checksum" > "$state/environment"
    git rev-parse HEAD > "$state/revision"
    printf '%s\n' "$project" > "$state/project"
    printf '%s\n' "$worker" > "$state/worker"
    compose config --format yaml | cksum > "$state/configuration"
    # Use the deployed image for the pre-migration backup, including its source.
    printf 'services:\n  api:\n    image: "%s"\n' "$previous_image" > "$state/backup-image.yaml"
  fi
  maintenance=1
  printf '%s\n' '短暂停止应用写入；数据库、Redis、存档和证书卷继续保留。'
  if [ "$worker" -eq 1 ]; then
    compose stop web api worker
  else
    compose stop web api
  fi
  if [ ! -f "$state/backed-up" ]; then
    printf '%s\n' '使用原运行版本生成更新前恢复点。'
    docker compose --env-file "$env_file" -f "$root/compose.yaml" \
      -f "$state/backup-image.yaml" -p "$project" --profile worker \
      run --rm --no-deps --pull never api node packages/database/dist/backup-cli.js create > "$state/backup.json"
    touch "$state/backed-up"
  fi
  cat "$state/backup.json"
  printf '%s\n' '执行待应用迁移。'
  compose up --no-deps --force-recreate --exit-code-from migrate migrate
  printf '%s\n' '启动新版本并等待健康检查。'
  if [ "$worker" -eq 1 ]; then
    compose up -d --no-deps --wait --wait-timeout 180 api web worker
  else
    compose up -d --no-deps --wait --wait-timeout 180 api web
  fi
  compose ps -a
  printf '更新完成，当前版本：%s\n' "$(git rev-parse --short HEAD)"
  rm -f "$state/environment" "$state/revision" "$state/project" "$state/worker" "$state/configuration" \
    "$state/backup-image.yaml" "$state/backed-up" "$state/backup.json"
  rmdir "$state"
  maintenance=0
}

main "$@"
