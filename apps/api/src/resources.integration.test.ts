import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadServiceConfig } from '@srilanka/config';
import type { ResourceChangeInput } from '@srilanka/contracts';
import { createDatabasePool } from '@srilanka/database';
import { buildApp } from './app.js';
import { ActionService } from './modules/actions/action-service.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { SettlementService } from './modules/settlements/settlement-service.js';
import { WorldService } from './modules/world/world-service.js';

const config = loadServiceConfig({ ...process.env, NODE_ENV: 'test' });
const database = createDatabasePool(config.databaseUrl);
const auth = new AuthService(database),
  games = new GameService(database),
  actions = new ActionService(database),
  world = new WorldService(database),
  settlements = new SettlementService(database);
const app = await buildApp({
  logLevel: 'silent',
  auth,
  games,
  actions,
  world,
  settlements,
  health: {
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
  },
});
let gameId: string,
  quarterId: string,
  hostId: string,
  playerId: string,
  otherId: string,
  observerId: string,
  countryId: string,
  otherCountryId: string,
  actionId: string;
let hostCookie: string, playerCookie: string, observerCookie: string;
const url = () => `/api/v1/games/${gameId}`;
const status = () => settlements.countries.status(gameId, hostId);
const version = async () =>
  Number(
    (
      await database.query(
        'SELECT current_world_version FROM games WHERE id=$1',
        [gameId],
      )
    ).rows[0]!.current_world_version,
  );
const resource = (
  overrides: Partial<ResourceChangeInput> = {},
): ResourceChangeInput => ({
  id: randomUUID(),
  actionId: null,
  countryId,
  expectedResourceRevision: 1,
  resource: 'Treasury',
  amount: -100,
  reason: '建设开支',
  ...overrides,
});
async function save(
  changes: ResourceChangeInput[],
  expectedVersion = 1,
  extra: Record<string, unknown> = {},
) {
  return app.inject({
    method: 'PUT',
    url: `${url()}/quarters/${quarterId}/settlement`,
    headers: { cookie: hostCookie },
    payload: {
      expectedVersion,
      publicReport: '本季各国发展。',
      results: [{ actionId, feedback: '建设完成。' }],
      resourceChanges: changes,
      ...extra,
    },
  });
}
async function prepare(withMap = false) {
  let tileId: string | undefined, armyId: string | undefined;
  if (withMap) {
    await world.setup.create(gameId, hostId, {
      name: '本土',
      width: 2,
      height: 1,
    });
    const tiles = (
      await world.getViewport({
        gameId,
        userId: hostId,
        minQ: 0,
        maxQ: 1,
        minR: 0,
        maxR: 0,
      })
    ).tiles;
    tileId = tiles[0]!.id;
    await world.setup.batch(gameId, hostId, {
      expectedRevision: (await world.getMap(gameId, hostId)).revision!,
      tileIds: [tileId],
      controllerCountryId: countryId,
      legalOwnerCountryId: countryId,
    });
    await world.createCity({
      gameId,
      userId: hostId,
      tileId,
      name: '都城',
      countryId,
    });
    await world.createArmy({
      gameId,
      userId: hostId,
      tileId,
      countryId,
      name: '第一军',
      strength: 100,
    });
    armyId = (await world.getTile(gameId, hostId, tileId)).armies[0]!.id;
  }
  await games.transitionCurrentQuarter({
    gameId,
    userId: hostId,
    state: 'ActionSubmission',
  });
  const action = await actions.create({
    gameId,
    userId: playerId,
    quarterId,
    title: '建设',
    originalText: '拨款建设',
    category: 'Construction',
    secrecy: 'OwnerOnly',
    refs: [],
  });
  actionId = action.id;
  await actions.submit({
    gameId,
    userId: playerId,
    actionId,
    idempotencyKey: randomUUID(),
  });
  await games.transitionCurrentQuarter({
    gameId,
    userId: hostId,
    state: 'Locked',
  });
  await games.transitionCurrentQuarter({
    gameId,
    userId: hostId,
    state: 'HostReview',
  });
  await actions.hostTransition({
    gameId,
    userId: hostId,
    actionId,
    target: 'Approved',
    reason: '允许建设',
  });
  await settlements.begin(gameId, hostId, quarterId);
  return { tileId, armyId };
}
beforeEach(async () => {
  await database.query(
    'TRUNCATE auth_sessions,game_members,quarters,countries,games,users CASCADE',
  );
  const users = [];
  for (const username of [
    'resource-host',
    'resource-player',
    'resource-other',
    'resource-observer',
  ])
    users.push(
      await auth.createDevelopmentUser({
        username,
        displayName: username,
        password: 'resource-password',
      }),
    );
  [hostId, playerId, otherId, observerId] = users.map((u) => u.id) as [
    string,
    string,
    string,
    string,
  ];
  const game = await games.create({
    userId: hostId,
    name: '国家资源',
    countryNames: ['北国', '南国'],
  });
  gameId = game.id;
  quarterId = game.currentQuarter.id;
  [countryId, otherCountryId] = (await games.listCountries(gameId, hostId)).map(
    (c) => c.id,
  ) as [string, string];
  for (const [index, role] of ['Player', 'Player', 'Observer'].entries()) {
    const member = await games.addMember({
      gameId,
      actorUserId: hostId,
      username: users[index + 1]!.username,
      role: role as 'Player' | 'Observer',
    });
    if (index < 2)
      await games.assignCountry({
        gameId,
        actorUserId: hostId,
        memberId: member.id,
        countryId: index === 0 ? countryId : otherCountryId,
      });
  }
  async function login(username: string) {
    return String(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username, password: 'resource-password' },
        })
      ).headers['set-cookie'],
    ).split(';')[0]!;
  }
  [hostCookie, playerCookie, observerCookie] = await Promise.all([
    login('resource-host'),
    login('resource-player'),
    login('resource-observer'),
  ]);
  await settlements.countries.setBalances(gameId, hostId, countryId, {
    expectedRevision: 0,
    treasury: 1000.25,
    manpower: 10000,
    reason: '开场资源',
  });
  await settlements.countries.setBalances(gameId, hostId, otherCountryId, {
    expectedRevision: 0,
    treasury: 500,
    manpower: 5000,
    reason: '南国开场资源',
  });
});
afterAll(async () => {
  await app.close();
  await database.end();
});
describe('national resources and settlement ledger', () => {
  it('scopes national truth and ledgers, protects setup with phase and revision, supports decimals and debt', async () => {
    const own = await app.inject({
      url: `${url()}/national-status`,
      headers: { cookie: playerCookie },
    });
    expect(own.json().data).toMatchObject({
      canSetBalances: false,
      countries: [{ id: countryId, treasury: 1000.25, manpower: 10000 }],
    });
    expect(own.json().data.countries).toHaveLength(1);
    expect(
      (await settlements.countries.status(gameId, otherId)).countries.map(
        (c) => c.id,
      ),
    ).toEqual([otherCountryId]);
    expect(
      (
        await app.inject({
          url: `${url()}/national-status`,
          headers: { cookie: observerCookie },
        })
      ).json().data.countries,
    ).toEqual([]);
    expect(
      (
        await app.inject({
          url: `${url()}/countries/${otherCountryId}/ledger`,
          headers: { cookie: playerCookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: `${url()}/countries/${countryId}/ledger`,
          headers: { cookie: observerCookie },
        })
      ).statusCode,
    ).toBe(404);
    const payload = {
      expectedRevision: 1,
      treasury: -20.15,
      manpower: 10000,
      reason: '剧本债务',
    };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `${url()}/countries/${countryId}/balances`,
          headers: { cookie: playerCookie },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `${url()}/countries/${countryId}/balances`,
          headers: { cookie: hostCookie },
          payload,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `${url()}/countries/${countryId}/balances`,
          headers: { cookie: hostCookie },
          payload,
        })
      ).statusCode,
    ).toBe(409);
    const ledger = (
      await settlements.countries.ledger(gameId, playerId, countryId)
    ).entries;
    expect(ledger[0]).toMatchObject({
      before: 1000.25,
      after: -20.15,
      amount: -1020.4,
      reason: '剧本债务',
    });
    expect(ledger[0]).not.toHaveProperty('actor_user_id');
    await prepare();
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `${url()}/countries/${countryId}/balances`,
          headers: { cookie: hostCookie },
          payload: { ...payload, expectedRevision: 2 },
        })
      ).json().error.code,
    ).toBe('RESOURCE_SETUP_LOCKED');
    expect(
      (
        await app.inject({
          url: `${url()}/countries/${countryId}/ledger?before=9999999999999999999`,
          headers: { cookie: hostCookie },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('stages ordered income and expenses, publishes army and resources once, retains private immutable history', async () => {
    const { armyId } = await prepare(true);
    const changes = [
      resource({ actionId, amount: 200.1, reason: '税收' }),
      resource({ actionId, amount: -120.35, reason: '军费' }),
      resource({
        actionId,
        resource: 'Manpower',
        amount: -300,
        reason: '征募',
      }),
      resource({
        countryId: otherCountryId,
        amount: -50,
        reason: '南国秘密工程',
      }),
    ];
    const worldBefore = await version(),
      mapRevision = (await world.getMap(gameId, hostId)).revision!;
    const draft = await save(changes, 1, {
      expectedMapRevision: mapRevision,
      stateChanges: [
        {
          id: randomUUID(),
          actionId,
          kind: 'ArmyStrength',
          armyId,
          strength: 400,
        },
      ],
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().data.resourceChanges[1]).toMatchObject({
      before: 1200.35,
      after: 1080,
    });
    expect(
      (await status()).countries.find((c) => c.id === countryId),
    ).toMatchObject({ treasury: 1000.25, manpower: 10000 });
    expect(
      (await settlements.countries.ledger(gameId, playerId, countryId)).entries,
    ).toHaveLength(2);
    expect(
      await settlements.get(gameId, playerId, quarterId),
    ).not.toHaveProperty('resourceChanges');
    const pub = await Promise.all([
      settlements.publish(gameId, hostId, quarterId, 2, mapRevision),
      settlements.publish(gameId, hostId, quarterId, 2, mapRevision),
    ]);
    expect(pub[0].publishedAt).toBe(pub[1].publishedAt);
    expect(await version()).toBe(worldBefore + 1);
    const national = (await status()).countries.find(
      (c) => c.id === countryId,
    )!;
    expect(national).toMatchObject({
      treasury: 1080,
      manpower: 9700,
      resourceRevision: 2,
      controlledTileCount: 1,
      legalTileCount: 1,
      armies: [{ strength: 400 }],
      cities: [{ name: '都城' }],
    });
    const ledger = (
      await settlements.countries.ledger(gameId, playerId, countryId)
    ).entries;
    expect(ledger).toHaveLength(5);
    expect(JSON.stringify(ledger)).not.toContain('南国秘密工程');
    expect(
      await settlements.get(gameId, playerId, quarterId),
    ).not.toHaveProperty('resourceChanges');
    expect(
      await settlements.get(gameId, observerId, quarterId),
    ).not.toHaveProperty('resourceChanges');
    await settlements.advance(gameId, hostId, quarterId);
    await settlements.countries.setBalances(gameId, hostId, countryId, {
      expectedRevision: 2,
      treasury: 2000,
      manpower: 9700,
      reason: '下季调整',
    });
    expect(
      (await settlements.get(gameId, hostId, quarterId)).resourceChanges,
    ).toEqual(pub[0].resourceChanges);
    expect(
      (
        await settlements.countries.ledger(gameId, playerId, countryId)
      ).entries.find((e) => e.reason === '军费'),
    ).toMatchObject({ before: 1200.35, after: 1080 });
  });
  it('publishes resources without a map, preserving older clients and ignoring invented metadata', async () => {
    await prepare();
    const change = resource();
    const result = await save([
      {
        ...change,
        before: 9,
        after: 999,
        countryName: '伪造',
      } as ResourceChangeInput,
    ]);
    expect(result.statusCode).toBe(200);
    expect(result.json().data.resourceChanges[0]).toMatchObject({
      before: 1000.25,
      after: 900.25,
      countryName: '北国',
    });
    await settlements.save(gameId, hostId, quarterId, {
      expectedVersion: 2,
      publicReport: '修改公报',
      results: [{ actionId, feedback: '建设完成' }],
    });
    expect(
      (await settlements.get(gameId, hostId, quarterId)).resourceChanges,
    ).toHaveLength(1);
    const previous = await version();
    await settlements.publish(gameId, hostId, quarterId, 3);
    expect(await version()).toBe(previous + 1);
    expect(
      (await status()).countries.find((c) => c.id === countryId)!.treasury,
    ).toBe(900.25);
  });
  it('keeps fresh exploration current when only resources change and leaves map revision alone', async () => {
    const { tileId } = await prepare(true);
    await world.setup.knowledge(gameId, hostId, {
      expectedRevision: (await world.getMap(gameId, hostId)).revision!,
      countryId,
      tileIds: [tileId!],
      state: 'Observed',
      note: '观察本土',
      sourceActionId: actionId,
    });
    const mapRevision = (await world.getMap(gameId, hostId)).revision!;
    expect((await save([resource()])).statusCode).toBe(200);
    await settlements.publish(gameId, hostId, quarterId, 2, mapRevision);
    expect((await world.getMap(gameId, hostId)).revision).toBe(mapRevision + 1); // exploration only
    expect(
      (await world.getTile(gameId, playerId, tileId!)).discoveryState,
    ).toBe('Observed');
  });
  it('rejects malformed, foreign, duplicate and insufficient changes and stale balances without rebasing', async () => {
    await prepare();
    const invalid = [
      resource({ amount: 0 }),
      resource({ amount: 1.001 }),
      resource({ resource: 'Manpower', amount: 1.5 }),
      resource({ resource: 'Manpower', amount: -10001 }),
      resource({ amount: 1_000_000_000 }),
      resource({ reason: '' }),
      resource({ countryId: randomUUID() }),
      resource({ actionId: randomUUID() }),
      resource({ expectedResourceRevision: 0 }),
    ];
    for (const change of invalid)
      expect((await save([change])).statusCode).toBeGreaterThanOrEqual(400);
    const dup = resource();
    expect((await save([dup, dup])).statusCode).toBe(400);
    const retiredId = (
      await database.query(
        'SELECT change_id FROM country_resource_ledger WHERE country_id=$1 LIMIT 1',
        [countryId],
      )
    ).rows[0]!.change_id as string;
    expect((await save([resource({ id: retiredId })])).statusCode).toBe(400);
    const change = resource();
    expect((await save([change])).statusCode).toBe(200);
    expect(
      (await save([{ ...change, resource: 'Manpower', amount: -10 }], 2))
        .statusCode,
    ).toBe(400);
    await database.query(
      'UPDATE countries SET treasury=900,resource_revision=resource_revision+1 WHERE id=$1',
      [countryId],
    );
    const truth = await status();
    await expect(
      settlements.save(gameId, hostId, quarterId, {
        expectedVersion: 2,
        publicReport: '文字',
        results: [],
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
    await expect(
      settlements.publish(gameId, hostId, quarterId, 2),
    ).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
    expect(await status()).toEqual(truth);
    expect(
      (await save([resource({ expectedResourceRevision: 2 })], 2)).statusCode,
    ).toBe(200); // remove old and re-add
    expect(
      (await settlements.get(gameId, hostId, quarterId)).resourceChanges![0],
    ).toMatchObject({ before: 900, after: 800 });
  });
  it('rolls balances, ledger, army truth, versions and publication back when exploration fails', async () => {
    const { tileId, armyId } = await prepare(true);
    await world.setup.knowledge(gameId, hostId, {
      expectedRevision: (await world.getMap(gameId, hostId)).revision!,
      countryId,
      tileIds: [tileId!],
      state: 'Observed',
      note: '本土',
      sourceActionId: actionId,
    });
    const mapRevision = (await world.getMap(gameId, hostId)).revision!;
    expect(
      (
        await save([resource()], 1, {
          expectedMapRevision: mapRevision,
          stateChanges: [
            {
              id: randomUUID(),
              actionId: null,
              kind: 'ArmyStrength',
              armyId,
              strength: 200,
            },
          ],
        })
      ).statusCode,
    ).toBe(200);
    await database.query("UPDATE actions SET status='Rejected' WHERE id=$1", [
      actionId,
    ]);
    const truth = await status(),
      worldBefore = await version(),
      ledgerBefore = await settlements.countries.ledger(
        gameId,
        playerId,
        countryId,
      );
    await expect(
      settlements.publish(gameId, hostId, quarterId, 2, mapRevision),
    ).rejects.toMatchObject({ code: 'INVALID_EXPLORATION_RESULT' });
    expect(await status()).toEqual(truth);
    expect(await version()).toBe(worldBefore);
    expect(
      await settlements.countries.ledger(gameId, playerId, countryId),
    ).toEqual(ledgerBefore);
    expect((await world.getMap(gameId, hostId)).revision).toBe(mapRevision);
    expect(
      (await settlements.get(gameId, hostId, quarterId)).publishedAt,
    ).toBeNull();
  });
  it('pages older account entries without duplicates', async () => {
    for (let i = 0; i < 51; i++)
      await settlements.countries.setBalances(gameId, hostId, countryId, {
        expectedRevision: i + 1,
        treasury: 1001.25 + i,
        manpower: 10000,
        reason: `调整 ${i}`,
      });
    const first = await settlements.countries.ledger(
      gameId,
      playerId,
      countryId,
    );
    expect(first.entries).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await settlements.countries.ledger(
      gameId,
      playerId,
      countryId,
      first.nextCursor!,
    );
    expect(second.entries).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.entries, ...second.entries].map((e) => e.id)).size,
    ).toBe(53);
    expect(second.entries.at(-1)!.reason).toBe('开场资源');
  });
});
