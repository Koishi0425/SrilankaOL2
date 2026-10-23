import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const script = fileURLToPath(new URL('./update.sh', import.meta.url));
const shell =
  process.platform === 'win32'
    ? join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe')
    : '/bin/sh';
const posix = (path) =>
  path
    .replaceAll('\\', '/')
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
const oldImage = `sha256:${'a'.repeat(64)}`;

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'srilanka-update test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(parent)), resolve(tmpdir()));
    assert.ok(parent.includes('srilanka-update test-'));
    await rm(parent, { recursive: true, force: true });
  });
  const root = join(parent, 'project');
  const bin = join(parent, 'bin');
  const log = join(parent, 'docker.log');
  await mkdir(join(root, 'infrastructure/scripts'), { recursive: true });
  await mkdir(bin);
  await copyFile(script, join(root, 'infrastructure/scripts/update.sh'));
  await writeFile(join(root, '.gitignore'), '.env.docker\n');
  await writeFile(
    join(root, '.env.docker'),
    'POSTGRES_PASSWORD=test-fixture-only\n',
  );
  await writeFile(
    join(root, 'compose.yaml'),
    'name: kept-project\nservices: {}\n',
  );
  await writeFile(join(root, 'README.md'), 'fixture\n');
  await writeFile(
    join(bin, 'docker'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$UPDATE_LOG"
case "$1" in
  info) exit 0 ;;
  inspect) printf '%s\\n' '${oldImage}'; exit 0 ;;
esac
action=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    version|config|ps|build|stop|run|up) action=$1; shift; break ;;
  esac
  shift
done
case "$action" in
  config) case "$*" in *--quiet*) ;; *) printf 'name: kept-project\\nservices: {}\\n' ;; esac ;;
  ps)
    for service do :; done
    case "$service" in
      database|redis) printf '%s\\n' "$service" ;;
      api) printf '%s\\n' old-api ;;
      worker) [ "$UPDATE_WORKER" != 1 ] || printf '%s\\n' old-worker ;;
    esac ;;
  build) [ "$UPDATE_FAIL" != build ] || exit 1 ;;
  run)
    [ "$UPDATE_FAIL" != backup ] || exit 1
    printf '%s\\n' '{"event":"backup-complete","detail":{"path":"/app/backups/update-fixture"}}' ;;
  up)
    case "$*" in
      *--exit-code-from*) [ "$UPDATE_FAIL" != migrate ] || exit 1 ;;
      *) [ "$UPDATE_FAIL" != health ] || exit 1 ;;
    esac ;;
esac
exit 0
`,
  );
  await chmod(join(bin, 'docker'), 0o755);
  function git(...args) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git('init', '-b', 'main');
  git('config', 'user.name', 'Update Test');
  git('config', 'user.email', 'update-test@example.invalid');
  git('add', '.');
  git('commit', '-m', 'fixture');
  return {
    root,
    parent,
    git,
    state: join(root, '.git/srilanka-update-state'),
    async run({ failure = '', worker = '0', pull = false } = {}) {
      const result = spawnSync(
        shell,
        [
          '-c',
          'PATH="$1:$PATH"; export PATH; shift; exec sh "$@"',
          'update-test',
          posix(bin),
          posix(join(root, 'infrastructure/scripts/update.sh')),
          ...(pull ? [] : ['--no-pull']),
        ],
        {
          cwd: parent,
          encoding: 'utf8',
          timeout: 60_000,
          env: {
            ...process.env,
            UPDATE_LOG: posix(log),
            UPDATE_FAIL: failure,
            UPDATE_WORKER: worker,
          },
        },
      );
      assert.ifError(result.error);
      return {
        ...result,
        calls: existsSync(log) ? await readFile(log, 'utf8') : '',
      };
    },
  };
}

const options = {
  skip: !existsSync(shell) ? 'A POSIX shell is required.' : false,
};

test(
  'updates in place with a pre-migration backup and health checks, preserving project and data services',
  options,
  async (t) => {
    const f = await fixture(t);
    const result = await f.run();
    assert.equal(result.status, 0, result.stderr);
    const calls = result.calls.split('\n');
    const position = (part) => calls.findIndex((line) => line.includes(part));
    assert.ok(position(' build api web') < position(' stop web api'));
    assert.ok(position(' stop web api') < position(' run --rm'));
    assert.ok(position(' run --rm') < position(' --exit-code-from migrate'));
    assert.ok(
      position(' --exit-code-from migrate') <
        position(' --wait --wait-timeout 180'),
    );
    assert.ok(
      calls
        .filter((line) => / (build|stop|run|up) /.test(line))
        .every((line) => line.includes('-p kept-project')),
    );
    assert.doesNotMatch(
      result.calls,
      /\bdown\b|--volumes|stop .*database|up .*database/,
    );
    assert.equal(
      await readFile(join(f.root, '.env.docker'), 'utf8'),
      'POSTGRES_PASSWORD=test-fixture-only\n',
    );
    assert.equal(f.git('status', '--porcelain'), '');
    assert.equal(existsSync(f.state), false);
  },
);

test(
  'a failed build leaves the deployed application running',
  options,
  async (t) => {
    const f = await fixture(t);
    const result = await f.run({ failure: 'build' });
    assert.notEqual(result.status, 0);
    assert.match(result.calls, / build api web/);
    assert.doesNotMatch(result.calls, / stop | run | up /);
    assert.equal(existsSync(f.state), false);
    assert.equal(existsSync(join(f.root, '.git/srilanka-update.lock')), false);
  },
);

test(
  'backup failure prevents migration and retries using the original image',
  options,
  async (t) => {
    const f = await fixture(t);
    const failed = await f.run({ failure: 'backup' });
    assert.notEqual(failed.status, 0);
    assert.doesNotMatch(failed.calls, / up /);
    assert.match(
      await readFile(join(f.state, 'backup-image.yaml'), 'utf8'),
      new RegExp(oldImage),
    );
    const retry = await f.run({ pull: true });
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(existsSync(f.state), false);
  },
);

test(
  'migration failure prevents startup and reuses the successful backup on retry',
  options,
  async (t) => {
    const f = await fixture(t);
    const failed = await f.run({ failure: 'migrate' });
    assert.notEqual(failed.status, 0);
    assert.doesNotMatch(failed.calls, / up -d /);
    const retry = await f.run({ pull: true });
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(
      retry.calls.split('\n').filter((line) => line.includes(' run --rm'))
        .length,
      1,
    );
  },
);

test(
  'remembers an enabled worker through a failed health check and retry',
  options,
  async (t) => {
    const f = await fixture(t);
    assert.notEqual(
      (await f.run({ failure: 'health', worker: '1' })).status,
      0,
    );
    const retry = await f.run();
    assert.equal(retry.status, 0, retry.stderr);
    assert.match(retry.calls, /build api web worker/);
    assert.match(retry.calls, /--wait-timeout 180 api web worker/);
  },
);

test(
  'rejects local edits and changes to a pending update configuration',
  options,
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.root, 'README.md'), 'local edits\n');
    const dirty = await f.run();
    assert.notEqual(dirty.status, 0);
    assert.equal(dirty.calls, '');
    f.git('restore', 'README.md');
    assert.notEqual((await f.run({ failure: 'migrate' })).status, 0);
    await writeFile(join(f.root, '.env.docker'), 'POSTGRES_PASSWORD=changed\n');
    const retry = await f.run();
    assert.notEqual(retry.status, 0);
    assert.match(retry.stderr, /上次更新尚未完成/);
  },
);

test(
  'pulls the tracked branch with a fast-forward before updating',
  options,
  async (t) => {
    const f = await fixture(t);
    const remote = join(f.parent, 'remote.git');
    f.git('init', '--bare', remote);
    f.git('remote', 'add', 'origin', remote);
    f.git('push', '-u', 'origin', 'main');
    await writeFile(join(f.root, 'README.md'), 'remote update\n');
    f.git('add', 'README.md');
    f.git('commit', '-m', 'new version');
    const target = f.git('rev-parse', 'HEAD');
    f.git('push');
    f.git('reset', '--hard', 'HEAD~1');
    const result = await f.run({ pull: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.git('rev-parse', 'HEAD'), target);
  },
);
