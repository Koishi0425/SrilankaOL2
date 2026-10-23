import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const token = randomBytes(6).toString('hex');
const project = `srilankaol-smoke-${token}`;
const directory = await mkdtemp(join(tmpdir(), `${project}-`));
const envFile = join(directory, '.env');
const imageArgument = process.argv.indexOf('--image-tag');
const imageTag =
  imageArgument < 0 ? `smoke-${token}` : process.argv[imageArgument + 1];
if (!imageTag || !/^[a-zA-Z0-9_.-]+$/.test(imageTag))
  throw new Error('Invalid --image-tag.');
const build = !process.argv.includes('--no-build');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

const [httpPort, httpsPort] = await Promise.all([freePort(), freePort()]);
const origin = `http://127.0.0.1:${httpPort}`;
const environment = {
  POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
  POSTGRES_USER: 'srilanka',
  POSTGRES_DB: 'srilanka_smoke',
  APP_ENV: 'development',
  APP_ORIGIN: origin,
  SITE_ADDRESS: ':80',
  WEB_BIND: '127.0.0.1',
  HTTP_PORT: String(httpPort),
  HTTPS_PORT: String(httpsPort),
  IMAGE_TAG: imageTag,
  REGISTRATION_MODE: 'invite',
  BACKUP_ENABLED: 'true',
  BACKUP_INTERVAL_MINUTES: '60',
  BACKUP_KEEP: '2',
  LLM_PROVIDER: 'deepseek',
  LLM_API_KEY: '',
  LLM_MODEL: '',
  LOG_LEVEL: 'info',
  COMPOSE_PROFILES: '',
  CLOUDFLARE_TUNNEL_TOKEN: '',
};
const childEnvironment = { ...process.env, ...environment };
delete childEnvironment.LLM_BASE_URL;
const args = [
  'compose',
  '--env-file',
  envFile,
  '-f',
  join(root, 'compose.yaml'),
  '-p',
  project,
];
await writeFile(
  envFile,
  Object.entries(environment)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n'),
  { mode: 0o600 },
);

function compose(command, { input, allowFailure = false } = {}) {
  const result = spawnSync('docker', [...args, ...command], {
    cwd: root,
    env: childEnvironment,
    encoding: 'utf8',
    input,
    timeout: 600_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    // Never print stdin or environment: they can contain test credentials.
    throw new Error(
      `${command.slice(0, 3).join(' ')} failed: ${result.error?.message ?? result.stderr ?? 'unknown error'}`,
    );
  }
  return result;
}
const exec = (...command) => compose(['exec', '-T', ...command]).stdout;
let cookie = '';
async function request(path, init = {}) {
  return globalThis.fetch(origin + path, {
    ...init,
    signal: globalThis.AbortSignal.timeout(15_000),
    // Synchronous Docker restarts block socket-close events in this process.
    // Use fresh HTTP connections so the restart probe cannot reuse a stale one.
    headers: { connection: 'close', origin, cookie, ...init.headers },
  });
}
const jsonBody = (value) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

try {
  console.log(`Isolated deployment: ${project}`);
  compose(['config', '--quiet']);
  assert.match(compose(['config', '--services']).stdout, /cloudflared/);
  const tunnelConfig = JSON.parse(
    compose(['config', '--format', 'json']).stdout,
  );
  assert.ok(tunnelConfig.services.cloudflared);
  assert.equal(tunnelConfig.services.cloudflared.profiles, undefined);
  assert.ok(
    tunnelConfig.services.web.ports.every(
      (port) => Number(port.target) !== 8082,
    ),
  );
  console.log('Building and starting containers...');
  compose([
    'up',
    '-d',
    ...(build ? ['--build'] : []),
    '--wait',
    '--wait-timeout',
    '180',
    '--scale',
    'cloudflared=0',
  ]);
  assert.equal(
    compose(['ps', '--all', '--quiet', 'cloudflared']).stdout.trim(),
    '',
  );
  assert.equal(
    (await (await request('/api/v1/health')).json()).data.status,
    'ok',
  );
  const html = await (await request('/')).text();
  assert.match(html, /SrilankaOL/);
  const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)[1];
  const assetResponse = await request(asset);
  assert.equal(assetResponse.status, 200);
  assert.match(assetResponse.headers.get('cache-control'), /immutable/);
  assert.equal((await request('/assets/missing-test-file.js')).status, 404);
  assert.equal((await request('/a-client-route')).status, 200);
  assert.equal((await request('/api/v1/me')).status, 401);
  assert.equal(
    (await (await request('/api/v1/auth/options')).json()).data
      .registrationMode,
    'InviteOnly',
  );
  console.log('Health, static assets, SPA routing and private API verified.');

  // Exercise the actual Caddy -> Fastify client-IP chain without a real tunnel
  // token. The internal request simulates cloudflared on the Compose network.
  const directId = `smoke-direct-${token}`,
    tunnelId = `smoke-tunnel-${token}`;
  const forged = '198.51.100.10',
    visitor = '203.0.113.20';
  await request('/api/v1/health', {
    headers: {
      'x-request-id': directId,
      'CF-Connecting-IP': forged,
      'X-Forwarded-For': forged,
    },
  });
  exec(
    'api',
    'node',
    '--input-type=module',
    '-e',
    `const r=await fetch('http://web:8082/api/v1/health',{headers:{'x-request-id':${JSON.stringify(tunnelId)},'CF-Connecting-IP':${JSON.stringify(visitor)},'X-Forwarded-For':${JSON.stringify(forged)}}});if(!r.ok)throw new Error('Tunnel ingress failed');await r.text();`,
  );
  let directLog, tunnelLog;
  for (let attempt = 0; attempt < 20; attempt++) {
    const lines = compose(['logs', '--no-color', '--no-log-prefix', 'api'])
      .stdout.split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
    directLog = lines.find((line) => line.reqId === directId && line.req);
    tunnelLog = lines.find((line) => line.reqId === tunnelId && line.req);
    if (directLog && tunnelLog) break;
    await delay(100);
  }
  assert.ok(
    directLog && tunnelLog,
    'Expected access logs for both ingress paths',
  );
  assert.notEqual(
    directLog.req.remoteAddress,
    forged,
    'Ordinary ingress must ignore spoofed forwarding headers',
  );
  assert.equal(
    tunnelLog.req.remoteAddress,
    visitor,
    'Tunnel ingress must preserve the validated visitor IP',
  );
  console.log(
    'Default tunnel configuration, explicit local opt-out and forwarded-IP isolation verified.',
  );

  const user = {
    username: 'docker-host',
    displayName: '部署演练主持人',
    password: randomBytes(3).toString('hex'),
  };
  const bootstrap = [
    'exec',
    '-T',
    'api',
    'node',
    'apps/api/dist/bootstrap-host.js',
    '--stdin',
  ];
  compose(bootstrap, { input: JSON.stringify(user) });
  const repeated = compose(bootstrap, {
    input: JSON.stringify(user),
    allowFailure: true,
  });
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /数据库已有账号/);
  const login = await request('/api/v1/auth/login', jsonBody(user));
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal(
    (await (await request('/api/v1/me')).json()).data.username,
    user.username,
  );
  const gameResponse = await request(
    '/api/v1/games',
    jsonBody({ name: 'Docker 独立部署演练', countryNames: ['河谷', '海岸'] }),
  );
  assert.equal(gameResponse.status, 201);
  const game = (await gameResponse.json()).data;
  assert.ok(game.id);
  assert.equal(exec('api', 'id', '-u').trim(), '1000');
  assert.match(exec('api', 'pg_dump', '--version'), /PostgreSQL\)?\s+17\./);
  console.log(
    'First-host bootstrap, repeat protection, login and game creation verified.',
  );

  const output = exec(
    'api',
    'node',
    'packages/database/dist/backup-cli.js',
    'create',
  );
  const backup = output
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((line) => line.event === 'backup-complete').detail.path;
  exec(
    'api',
    'node',
    'packages/database/dist/backup-cli.js',
    'verify',
    '--backup',
    backup,
  );
  const restoreName = `srilanka_restore_smoke_${token}`;
  exec(
    'api',
    'node',
    'packages/database/dist/backup-cli.js',
    'restore',
    '--backup',
    backup,
    '--target-name',
    restoreName,
  );
  assert.equal(
    exec(
      'database',
      'psql',
      '-U',
      'srilanka',
      '-d',
      restoreName,
      '-At',
      '-c',
      'SELECT count(*) FROM users',
    ).trim(),
    '1',
  );
  assert.equal(
    exec(
      'database',
      'psql',
      '-U',
      'srilanka',
      '-d',
      restoreName,
      '-At',
      '-c',
      'SELECT count(*) FROM games',
    ).trim(),
    '1',
  );
  console.log(
    'Backup creation, archive verification and restore into a new database verified.',
  );

  compose(['restart', 'database', 'redis', 'api', 'web']);
  compose([
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '180',
    '--scale',
    'cloudflared=0',
  ]);
  const games = (await (await request('/api/v1/games')).json()).data;
  assert.ok(games.some((item) => item.id === game.id));
  exec('web', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile');
  compose([
    'exec',
    '-T',
    '-e',
    'SITE_ADDRESS=game.example.com',
    'web',
    'caddy',
    'validate',
    '--config',
    '/etc/caddy/Caddyfile',
  ]);
  console.log(
    'Restart persistence and HTTP/HTTPS Caddy configuration verified.',
  );
  console.log(
    'Docker smoke test passed. Public certificate issuance requires a real domain.',
  );
} catch (error) {
  console.error(
    compose(['logs', '--tail=40', 'migrate', 'api', 'web'], {
      allowFailure: true,
    }).stdout,
  );
  throw error;
} finally {
  // Only this randomly named, disposable test project is removed.
  const cleanup = compose(['down', '--volumes', '--remove-orphans'], {
    allowFailure: true,
  });
  if (cleanup.status !== 0) {
    console.error(
      `Cleanup failed for disposable project ${project}: ${cleanup.stderr}`,
    );
    process.exitCode = 1;
  }
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith(project + '-'));
  await rm(directory, { recursive: true, force: true });
}
