import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { loadServiceConfig } from '@srilanka/config';
import type { SaveGlobalAssistantSettings } from '@srilanka/contracts';
import { createDatabasePool } from '@srilanka/database';
import { buildApp } from './app.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { SettlementService } from './modules/settlements/settlement-service.js';
import { AssistantService } from './modules/assistant/assistant-service.js';
import { CompatibleAssistantModel } from './modules/assistant/assistant-model.js';
import { AssistantSecrets } from './modules/assistant/assistant-secrets.js';
import { AssistantSettingsService } from './modules/assistant/assistant-settings.js';

if (
  !process.env.DATABASE_URL ||
  new URL(process.env.DATABASE_URL).pathname !== '/srilanka_test'
)
  throw new Error('Settings integration requires srilanka_test.');
const database = createDatabasePool(process.env.DATABASE_URL);
const auth = new AuthService(database);
const games = new GameService(database);
const settlements = new SettlementService(database);
const folder = await mkdtemp(join(tmpdir(), 'srilanka-ai-settings-'));
const keyFile = join(folder, '.private/assistant.key');
const fallback = loadServiceConfig({ NODE_ENV: 'test' }).llm;
const transport = vi.fn<typeof fetch>();
const settings = new AssistantSettingsService(
  database,
  new AssistantSecrets(keyFile),
  fallback,
  transport,
);
const assistant = new AssistantService(
  database,
  games,
  settlements,
  new CompatibleAssistantModel(fallback, transport),
  settings,
);
const app = await buildApp({
  auth,
  games,
  settlements,
  assistant,
  logLevel: 'silent',
  health: { checkDatabase: async () => {}, checkRedis: async () => {} },
});
const secret = 'fixture-private-global-key';
const password = 'global-ai-test-password';
let adminId: string, hostId: string, playerId: string;
let adminCookie: string, hostCookie: string, playerCookie: string;
let gameId: string, quarterId: string;

function wire(options?: RequestInit) {
  const body = JSON.parse(String(options?.body));
  const data = JSON.parse(body.messages[1].content);
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              overview: '共享服务结果。',
              highlights: [
                {
                  title: '结算',
                  category: 'Outcome',
                  text: '已发布内容。',
                  sourceIds: [data.sources[0].id],
                },
              ],
              notices: [],
              draft: null,
            }),
          },
        },
      ],
    }),
  );
}
function input(expectedRevision = 0): SaveGlobalAssistantSettings {
  return {
    expectedRevision,
    enabled: true,
    provider: 'compatible',
    baseUrl: 'https://model.example.test/v1',
    model: 'shared-model',
    apiKey: secret,
    jsonMode: true,
    disableThinking: false,
    timeoutMs: 60000,
  };
}
async function login(username: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie']).split(';')[0]!;
}
function save(body = input(), cookie = adminCookie) {
  return app.inject({
    method: 'PUT',
    url: '/api/v1/admin/assistant',
    headers: { cookie },
    payload: body,
  });
}
async function published() {
  for (const state of ['ActionSubmission', 'Locked', 'HostReview'] as const)
    await games.transitionCurrentQuarter({ gameId, userId: hostId, state });
  const begun = await settlements.begin(gameId, hostId, quarterId);
  const draft = await settlements.save(gameId, hostId, quarterId, {
    expectedVersion: begun.version,
    publicReport: '河流运输已经恢复。',
    results: [],
  });
  return settlements.publish(gameId, hostId, quarterId, draft.version);
}

beforeAll(async () => {
  await app.ready();
});
beforeEach(async () => {
  transport
    .mockReset()
    .mockImplementation(async (_url, options) => wire(options));
  await database.query('TRUNCATE users,games CASCADE');
  const users = [];
  for (const [name, role] of [
    ['admin', 'Administrator'],
    ['host', 'User'],
    ['player', 'User'],
  ] as const)
    users.push(
      await auth.createDevelopmentUser({
        username: `global-ai-${name}`,
        displayName: name,
        password,
        systemRole: role,
      }),
    );
  [adminId, hostId, playerId] = users.map((user) => user.id) as [
    string,
    string,
    string,
  ];
  adminCookie = await login('global-ai-admin');
  hostCookie = await login('global-ai-host');
  playerCookie = await login('global-ai-player');
  const game = await games.create({
    userId: hostId,
    name: '共享 AI 配置测试',
    countryNames: ['河国'],
  });
  gameId = game.id;
  quarterId = game.currentQuarter.id;
  const countries = await games.listCountries(gameId, hostId);
  await database.query(
    "INSERT INTO game_members (id,game_id,user_id,role,status,controlled_country_id) VALUES ($1,$2,$3,'Player','Active',$4)",
    [crypto.randomUUID(), gameId, playerId, countries[0]!.id],
  );
});
afterAll(async () => {
  await app.close();
  await database.end();
  if (!folder.startsWith(join(tmpdir(), 'srilanka-ai-settings-')))
    throw new Error('Unexpected test path');
  await rm(folder, { recursive: true, force: true });
});

it('only lets system administrators manage credentials, including when another user is a game host', async () => {
  for (const cookie of [hostCookie, playerCookie]) {
    expect(
      (
        await app.inject({
          url: '/api/v1/admin/assistant',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(403);
    expect((await save(input(), cookie)).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/assistant/test',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(403);
  }
  expect(
    (await app.inject({ url: '/api/v1/admin/assistant' })).statusCode,
  ).toBe(401);
  expect(transport).not.toHaveBeenCalled();
  expect(
    (await database.query('SELECT * FROM assistant_global_settings')).rowCount,
  ).toBe(0);
});

it('saves encrypted settings, normalizes the address and enables a player without a per-game toggle', async () => {
  const response = await save({
    ...input(),
    baseUrl: 'https://model.example.test/v1/chat/completions/',
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toMatchObject({
    revision: 1,
    configured: true,
    hasApiKey: true,
    baseUrl: 'https://model.example.test/v1',
  });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(JSON.stringify(response.json())).not.toContain(secret);
  expect(response.json().data).not.toHaveProperty('apiKey');
  const record = (
    await database.query('SELECT * FROM assistant_global_settings')
  ).rows[0];
  expect(JSON.stringify(record)).not.toContain(secret);
  expect(
    await new AssistantSecrets(keyFile).decrypt(record.api_key_ciphertext),
  ).toBe(secret);
  expect(
    (await database.query('SELECT ai_enabled FROM games WHERE id=$1', [gameId]))
      .rows[0].ai_enabled,
  ).toBe(false);
  const status = await assistant.status(gameId, playerId);
  expect(status).toMatchObject({
    scope: 'Global',
    configured: true,
    enabled: true,
    model: 'shared-model',
    canManage: false,
  });
  const result = await published();
  const generated = await app.inject({
    method: 'POST',
    url: `/api/v1/games/${gameId}/assistant/generate`,
    headers: { cookie: playerCookie },
    payload: {
      purpose: 'Digest',
      quarterId,
      expectedVersion: result.version,
      expectedCorrectionVersion: 0,
      length: 'Brief',
    },
  });
  expect(generated.statusCode).toBe(200);
  expect(transport.mock.calls[0]![0]).toBe(
    'https://model.example.test/v1/chat/completions',
  );
  expect(transport.mock.calls[0]![1]!.headers).toMatchObject({
    Authorization: `Bearer ${secret}`,
  });
  expect(JSON.stringify(generated.json())).not.toContain(secret);
});

it('keeps a blank key, rejects stale saves and refuses to forward an existing key to a different endpoint', async () => {
  expect((await save()).statusCode).toBe(200);
  const { apiKey: _key, ...withoutKey } = input(1);
  void _key;
  expect(
    (await save({ ...withoutKey, model: 'second-model' })).statusCode,
  ).toBe(200);
  expect((await save({ ...withoutKey, model: 'stale-model' })).statusCode).toBe(
    409,
  );
  expect(
    (
      await save({
        ...withoutKey,
        expectedRevision: 2,
        baseUrl: 'https://other.example.test/v1',
      })
    ).statusCode,
  ).toBe(400);
  expect(transport).not.toHaveBeenCalled();
  const checked = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/assistant/test',
    headers: { cookie: adminCookie },
  });
  expect(checked.statusCode).toBe(200);
  expect(checked.json().data.model).toBe('second-model');
  expect(transport.mock.calls[0]![1]!.headers).toMatchObject({
    Authorization: `Bearer ${secret}`,
  });
  const sent = JSON.parse(String(transport.mock.calls[0]![1]!.body));
  expect(sent.messages[1].content).toContain('不包含任何游戏信息');
});

it('persists across service instances and can be globally disabled without falling back to environment credentials', async () => {
  await save();
  const restarted = new AssistantSettingsService(
    database,
    new AssistantSecrets(keyFile),
    { ...fallback, apiKey: 'legacy-key', model: 'legacy-model' },
    transport,
  );
  expect((await restarted.runtime()).model.configured).toBe(true);
  expect((await restarted.get(adminId)).model).toBe('shared-model');
  expect((await save({ ...input(1), enabled: false })).statusCode).toBe(200);
  expect((await restarted.runtime()).globalEnabled).toBe(false);
  expect((await assistant.status(gameId, playerId)).enabled).toBe(false);
  await expect(
    assistant.configure(gameId, hostId, true, false),
  ).rejects.toMatchObject({ code: 'ASSISTANT_GLOBAL_MANAGED' });
});

it('discards an in-flight result when the global model changes', async () => {
  await save();
  const result = await published();
  let finish!: () => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  transport.mockImplementationOnce(async (_url, options) => {
    const reply = wire(options);
    started();
    return new Promise((resolve) => {
      finish = () => resolve(reply);
    });
  });
  const pending = app
    .inject({
      method: 'POST',
      url: `/api/v1/games/${gameId}/assistant/generate`,
      headers: { cookie: playerCookie },
      payload: {
        purpose: 'Digest',
        quarterId,
        expectedVersion: result.version,
        expectedCorrectionVersion: 0,
        length: 'Brief',
      },
    })
    .then((response) => response);
  await began;
  expect((await save({ ...input(1), model: 'changed-model' })).statusCode).toBe(
    200,
  );
  finish();
  expect((await pending).json().error.code).toBe('ASSISTANT_CONTEXT_CHANGED');
});

it('repairs only the original active account on installations without an administrator', async () => {
  const migration = await readFile(
    new URL(
      '../../../packages/database/migrations/029_global_assistant_settings.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const upgrade = migration.slice(migration.indexOf('UPDATE users SET'));
  await database.query("UPDATE users SET system_role='User'");
  await database.query(upgrade);
  expect(
    (
      await database.query(
        "SELECT id FROM users WHERE system_role='Administrator'",
      )
    ).rows,
  ).toEqual([{ id: adminId }]);
  await database.query("UPDATE users SET system_role='User'");
  await database.query(
    "UPDATE users SET system_role='Administrator' WHERE id=$1",
    [hostId],
  );
  await database.query(upgrade);
  expect(
    (
      await database.query(
        "SELECT id FROM users WHERE system_role='Administrator'",
      )
    ).rows,
  ).toEqual([{ id: hostId }]);
  await database.query("UPDATE users SET system_role='User'");
  await database.query("UPDATE users SET status='Suspended' WHERE id=$1", [
    adminId,
  ]);
  await database.query(upgrade);
  expect(
    (
      await database.query(
        "SELECT id FROM users WHERE system_role='Administrator'",
      )
    ).rowCount,
  ).toBe(0);
});
