import { randomUUID } from 'node:crypto';
import { beforeEach, afterAll, describe, it, expect } from 'vitest';
import { loadServiceConfig } from '@srilanka/config';
import { createDatabasePool } from '@srilanka/database';
import { toDiplomacyInput } from '@srilanka/contracts';
import type {
  DiplomacyChangeInput,
  DiplomacyChange,
  SaveSettlementInput,
} from '@srilanka/contracts';
import { buildApp } from './app.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { ActionService } from './modules/actions/action-service.js';
import { SettlementService } from './modules/settlements/settlement-service.js';
import { WorldService } from './modules/world/world-service.js';
const config = loadServiceConfig({ ...process.env, NODE_ENV: 'test' }),
  db = createDatabasePool(config.databaseUrl);
const auth = new AuthService(db),
  games = new GameService(db),
  actions = new ActionService(db),
  settlements = new SettlementService(db),
  world = new WorldService(db);
const app = await buildApp({
  auth,
  games,
  actions,
  settlements,
  world,
  logLevel: 'silent',
  health: {
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
  },
});
let gameId: string,
  quarterId: string,
  host: string,
  northUser: string,
  southUser: string,
  thirdUser: string,
  observer: string,
  outside: string,
  north: string,
  south: string,
  third: string,
  actionId: string,
  cookie: string,
  playerCookie: string;
const revision = async () => (await games.diplomacy.get(gameId, host)).revision;
let quarterSequence = 1;
function treaty(
  extra: Partial<Extract<DiplomacyChangeInput, { kind: 'Treaty' }>> = {},
): Extract<DiplomacyChangeInput, { kind: 'Treaty' }> {
  return {
    id: randomUUID(),
    actionId: null,
    expectedRevision: 0,
    expectedQuarterSequence: quarterSequence,
    reason: '两国谈成协议',
    kind: 'Treaty',
    treatyId: randomUUID(),
    title: '海湾停战协议',
    type: 'Truce',
    countryIds: [north, south],
    terms: '停战四季，北方支付赔款。',
    visibility: 'Public',
    durationQuarters: 4,
    grantorCountryId: null,
    ...extra,
  };
}
const war = (
  state: 'Peace' | 'War' = 'War',
  rev = 0,
): DiplomacyChangeInput => ({
  id: randomUUID(),
  actionId: null,
  expectedRevision: rev,
  expectedQuarterSequence: quarterSequence,
  reason: state === 'War' ? '边境争端，宣布交战' : '两国接受和议',
  kind: 'WarStatus',
  countryIds: [north, south],
  state,
});
const setup = (changes: unknown[], withCookie = cookie) =>
  app.inject({
    method: 'PUT',
    url: `/api/v1/games/${gameId}/diplomacy`,
    headers: { cookie: withCookie },
    payload: { changes },
  });
async function start() {
  await games.transitionCurrentQuarter({
    gameId,
    userId: host,
    state: 'ActionSubmission',
  });
  const a = await actions.create({
    gameId,
    userId: northUser,
    quarterId,
    title: '议和政策',
    originalText: '议和并支付赔款，争取南海提供独立保障。',
    category: 'Diplomacy',
    secrecy: 'OwnerOnly',
    refs: [],
  });
  actionId = a.id;
  await actions.submit({
    gameId,
    userId: northUser,
    actionId,
    idempotencyKey: randomUUID(),
  });
  await games.transitionCurrentQuarter({
    gameId,
    userId: host,
    state: 'Locked',
  });
  await games.transitionCurrentQuarter({
    gameId,
    userId: host,
    state: 'HostReview',
  });
  await actions.hostTransition({
    gameId,
    userId: host,
    actionId,
    target: 'Approved',
    reason: '双方已达成协议',
  });
  await settlements.begin(gameId, host, quarterId);
}
const save = (
  changes: DiplomacyChangeInput[],
  version = 1,
  extra: Partial<SaveSettlementInput> = {},
) =>
  settlements.save(gameId, host, quarterId, {
    expectedVersion: version,
    publicReport: '两国外交结算完成',
    results: [{ actionId, feedback: '达成和约' }],
    diplomacyChanges: changes,
    ...extra,
  });
beforeEach(async () => {
  quarterSequence = 1;
  await db.query(
    'TRUNCATE auth_sessions,game_members,quarters,countries,games,users CASCADE',
  );
  const users = [];
  for (const username of [
    'dip-host',
    'dip-north',
    'dip-south',
    'dip-third',
    'dip-observer',
    'dip-outside',
  ])
    users.push(
      await auth.createDevelopmentUser({
        username,
        displayName: username,
        password: 'diplomacy-password',
      }),
    );
  [host, northUser, southUser, thirdUser, observer, outside] = users.map(
    (u) => u.id,
  ) as [string, string, string, string, string, string];
  const game = await games.create({
    userId: host,
    name: '外交测试',
    countryNames: ['北国', '南国', '山国'],
  });
  gameId = game.id;
  quarterId = game.currentQuarter.id;
  const countries = await games.listCountries(gameId, host);
  north = countries.find((c) => c.name === '北国')!.id;
  south = countries.find((c) => c.name === '南国')!.id;
  third = countries.find((c) => c.name === '山国')!.id;
  for (const [i, u] of users.slice(1, 5).entries()) {
    const m = await games.addMember({
      gameId,
      actorUserId: host,
      username: u.username,
      role: i < 3 ? 'Player' : 'Observer',
    });
    if (i < 3)
      await games.assignCountry({
        gameId,
        actorUserId: host,
        memberId: m.id,
        countryId: [north, south, third][i]!,
      });
  }
  const login = async (username: string) =>
    String(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username, password: 'diplomacy-password' },
        })
      ).headers['set-cookie'],
    ).split(';')[0]!;
  cookie = await login('dip-host');
  playerCookie = await login('dip-north');
  await settlements.countries.setBalances(gameId, host, north, {
    expectedRevision: 0,
    treasury: 100,
    manpower: 0,
    reason: '测试开场',
  });
});
afterAll(async () => {
  await app.close();
  await db.end();
});
describe('persistent diplomacy', () => {
  it('stages peace and directional guarantees, preserves old clients and publishes money and diplomacy exactly once without a map', async () => {
    expect((await setup([war()])).statusCode).toBe(200);
    await start();
    const port = treaty({
      type: 'Guarantee',
      title: '南海独立保障协议',
      terms: '南国向北国提供独立保障。',
      grantorCountryId: south,
      visibility: 'Participants',
      durationQuarters: null,
      expectedRevision: 1,
      actionId,
    });
    const peace = war('Peace', 1),
      before = (await games.getForUser(gameId, host)).currentQuarter
        .currentWorldVersion;
    const saved = await save([peace, port], 1, {
      resourceChanges: [
        {
          id: randomUUID(),
          actionId,
          countryId: north,
          resource: 'Treasury',
          amount: -20,
          expectedResourceRevision: 1,
          reason: '和约赔款',
        },
      ],
    });
    expect(
      (await games.diplomacy.get(gameId, northUser)).relations[0]?.state,
    ).toBe('War');
    expect((await games.diplomacy.get(gameId, northUser)).treaties).toEqual([]);
    expect(
      (await settlements.countries.status(gameId, host)).countries.find(
        (c) => c.id === north,
      )?.treasury,
    ).toBe(100);
    const legacy = await settlements.save(gameId, host, quarterId, {
      expectedVersion: saved.version,
      publicReport: '正式议和',
      results: [{ actionId, feedback: '获得秘密保障协议' }],
    });
    expect(legacy.diplomacyChanges).toHaveLength(2);
    await Promise.all([
      settlements.publish(gameId, host, quarterId, legacy.version),
      settlements.publish(gameId, host, quarterId, legacy.version),
    ]);
    const data = await games.diplomacy.get(gameId, northUser);
    expect(data.relations[0]?.state).toBe('Peace');
    expect(data.treaties[0]?.grantorCountryId).toBe(south);
    expect(data.treaties[0]?.visibility).toBe('Participants');
    expect(await revision()).toBe(2);
    expect(
      (await games.getForUser(gameId, host)).currentQuarter.currentWorldVersion,
    ).toBe(before + 1);
    expect(
      (await settlements.countries.status(gameId, host)).countries.find(
        (c) => c.id === north,
      )?.treasury,
    ).toBe(80);
    expect(
      (
        await db.query('SELECT id FROM diplomacy_history WHERE game_id=$1', [
          gameId,
        ])
      ).rows,
    ).toHaveLength(3);
    for (const u of [northUser, observer, thirdUser])
      expect(await settlements.get(gameId, u, quarterId)).not.toHaveProperty(
        'diplomacyChanges',
      );
  });
  it('projects public treaties and wars to everyone while private terms and history stay with current participants', async () => {
    const publicTreaty = treaty(),
      secret = treaty({
        title: '秘密贸易',
        terms: 'SECRET_PORT_TERMS',
        visibility: 'Participants',
        countryIds: [north, south],
      });
    expect((await setup([war(), publicTreaty, secret])).statusCode).toBe(200);
    for (const u of [northUser, southUser]) {
      const data = await games.diplomacy.get(gameId, u);
      expect(data.treaties).toHaveLength(2);
      expect(data.history).toHaveLength(3);
      expect(data).not.toHaveProperty('countries');
      expect(data.canEdit).toBe(false);
    }
    for (const u of [thirdUser, observer]) {
      const data = await games.diplomacy.get(gameId, u);
      expect(data.treaties).toHaveLength(1);
      expect(data.history).toHaveLength(2);
      expect(JSON.stringify(data)).not.toContain('SECRET_PORT_TERMS');
      expect(JSON.stringify(data)).not.toContain(secret.treatyId);
      expect(JSON.stringify(data.history)).not.toContain('actionId');
    }
    await expect(games.diplomacy.get(gameId, outside)).rejects.toMatchObject({
      code: 'OBJECT_NOT_FOUND',
    });
    expect((await setup([war()], playerCookie)).statusCode).toBe(403);
  });
  it('checks setup phase, revisions, duplicate targets and immutable treaty audience with no partial writes', async () => {
    const t = treaty();
    expect((await setup([t])).statusCode).toBe(200);
    expect((await setup([war()])).statusCode).toBe(409);
    expect((await setup([war('War', 1), war('War', 1)])).statusCode).toBe(400);
    expect(
      (
        await setup([
          {
            ...t,
            id: randomUUID(),
            expectedRevision: 1,
            visibility: 'Participants',
          },
        ])
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await setup([
          {
            ...t,
            id: randomUUID(),
            expectedRevision: 1,
            countryIds: [north, third],
          },
        ])
      ).statusCode,
    ).toBe(400);
    expect(await revision()).toBe(1);
    expect((await games.diplomacy.get(gameId, host)).relations).toEqual([]);
    const concurrent = await Promise.all([
      setup([war('War', 1)]),
      setup([war('War', 1)]),
    ]);
    expect(concurrent.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    await start();
    expect((await setup([war('Peace', 2)])).statusCode).toBe(409);
  });
  it('validates directional rights, bounds, foreign targets and policies, recomputes metadata and rejects reused formal IDs', async () => {
    for (const type of ['MilitaryAccess', 'FleetBasing']) {
      const response = await setup([{ ...treaty(), type }]);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_FAILED');
    }
    for (const t of [
      treaty({ type: 'Guarantee' }),
      treaty({ type: 'Guarantee', grantorCountryId: third }),
      treaty({
        type: 'Guarantee',
        grantorCountryId: north,
        countryIds: [north, south, third],
      }),
      treaty({ countryIds: [north, north] }),
      treaty({ countryIds: [north, randomUUID()] }),
      treaty({ durationQuarters: 0 }),
      treaty({ durationQuarters: 1.5 }),
      treaty({ terms: ' ' }),
    ])
      expect((await setup([t])).statusCode).toBe(400);
    const t = treaty({ type: 'Guarantee', grantorCountryId: north });
    expect(
      (await setup([{ ...t, summary: 'forged', after: { terms: 'forged' } }]))
        .statusCode,
    ).toBe(200);
    expect((await games.diplomacy.get(gameId, host)).treaties[0]?.terms).toBe(
      t.terms,
    );
    expect((await setup([{ ...war('War', 1), id: t.id }])).statusCode).toBe(
      400,
    );
    await start();
    await expect(
      save([treaty({ expectedRevision: 1, actionId: randomUUID() })]),
    ).rejects.toMatchObject({ code: 'INVALID_DIPLOMACY_CHANGE' });
  });
  it('amends and terminates treaties, derives expiry across years, and keeps published history unchanged', async () => {
    quarterSequence = 8;
    await db.query(
      "UPDATE quarters SET game_year=2,season='Winter',sequence_number=8 WHERE id=$1",
      [quarterId],
    );
    const t = treaty({ durationQuarters: 1, visibility: 'Participants' });
    expect((await setup([t])).statusCode).toBe(200);
    const initial = (await games.diplomacy.get(gameId, host)).treaties[0]!;
    expect(initial.expiresAt).toEqual({
      gameYear: 3,
      season: 'Spring',
      sequenceNumber: 9,
    });
    await start();
    const edited = treaty({
      ...t,
      id: randomUUID(),
      expectedRevision: 1,
      terms: '续约：允许商团驻扎两季',
      durationQuarters: 2,
      actionId,
    });
    const draft = await save([edited]);
    await settlements.publish(gameId, host, quarterId, draft.version);
    const historical = await settlements.get(gameId, host, quarterId);
    const h = (await games.diplomacy.get(gameId, host)).history;
    await settlements.advance(gameId, host, quarterId);
    quarterSequence = 9;
    quarterId = (await games.getCurrentQuarter(gameId, host)).id;
    expect(
      (await games.diplomacy.get(gameId, host)).treaties[0]?.expiresAt
        ?.sequenceNumber,
    ).toBe(10);
    const end: DiplomacyChangeInput = {
      id: randomUUID(),
      actionId: null,
      expectedRevision: 2,
      expectedQuarterSequence: 9,
      reason: '提前结束协议',
      kind: 'EndTreaty',
      treatyId: t.treatyId,
    };
    expect((await setup([end])).statusCode).toBe(200);
    expect(
      (await games.diplomacy.get(gameId, host)).treaties[0]?.endedAt
        ?.sequenceNumber,
    ).toBe(9);
    expect((await games.diplomacy.get(gameId, host)).history?.slice(1)).toEqual(
      h,
    );
    expect(
      (await settlements.get(gameId, host, historical.quarter.id))
        .diplomacyChanges,
    ).toEqual(historical.diplomacyChanges);
    expect(
      (
        await setup([
          {
            ...edited,
            id: randomUUID(),
            expectedRevision: 3,
            expectedQuarterSequence: 9,
            actionId: null,
          },
        ])
      ).statusCode,
    ).toBe(400);
  });
  it('does not rebase saved plans when clients rewrite revisions after true diplomatic state changes', async () => {
    await start();
    const w = war();
    const saved = await save([w]);
    expect(saved.diplomacyChanges?.[0]?.before).toBeNull();
    await db.query(
      'UPDATE games SET diplomacy_revision=diplomacy_revision+1 WHERE id=$1',
      [gameId],
    );
    await expect(
      save([{ ...w, expectedRevision: 1 }], saved.version),
    ).rejects.toMatchObject({ code: 'DIPLOMACY_VERSION_CONFLICT' });
    await expect(
      settlements.publish(gameId, host, quarterId, saved.version),
    ).rejects.toMatchObject({ code: 'DIPLOMACY_VERSION_CONFLICT' });
    const cleared = await save([], saved.version);
    const fresh = await save([war('War', 1)], cleared.version);
    await settlements.publish(gameId, host, quarterId, fresh.version);
    expect((await games.diplomacy.get(gameId, host)).relations[0]?.state).toBe(
      'War',
    );
  });
  it('rolls diplomacy, money and history back if a later exploration plan fails', async () => {
    await world.setup.create(gameId, host, {
      name: '边境',
      width: 1,
      height: 1,
    });
    await start();
    const tile = (
      await world.getViewport({
        gameId,
        userId: host,
        minQ: 0,
        maxQ: 0,
        minR: 0,
        maxR: 0,
      })
    ).tiles[0]!;
    await world.setup.knowledge(gameId, host, {
      expectedRevision: (await world.getMap(gameId, host)).revision!,
      countryId: north,
      tileIds: [tile.id],
      state: 'Observed',
      sourceActionId: actionId,
      note: '边境情报',
    });
    const saved = await save(
      [war(), treaty({ visibility: 'Participants' })],
      1,
      {
        resourceChanges: [
          {
            id: randomUUID(),
            actionId: null,
            countryId: north,
            resource: 'Treasury',
            amount: -20,
            expectedResourceRevision: 1,
            reason: '外交支出',
          },
        ],
      },
    );
    await db.query("UPDATE actions SET status='Rejected' WHERE id=$1", [
      actionId,
    ]);
    const before = (await games.getForUser(gameId, host)).currentQuarter
        .currentWorldVersion,
      map = (await world.getMap(gameId, host)).revision!;
    await expect(
      settlements.publish(gameId, host, quarterId, saved.version, map),
    ).rejects.toMatchObject({ code: 'INVALID_EXPLORATION_RESULT' });
    const data = await games.diplomacy.get(gameId, host);
    expect(data.relations).toEqual([]);
    expect(data.treaties).toEqual([]);
    expect(data.history).toEqual([]);
    expect(data.revision).toBe(0);
    expect(
      (await settlements.countries.status(gameId, host)).countries.find(
        (c) => c.id === north,
      )?.treasury,
    ).toBe(100);
    expect(
      (await games.getForUser(gameId, host)).currentQuarter.currentWorldVersion,
    ).toBe(before);
    expect((await world.getMap(gameId, host)).revision).toBe(map);
    expect(
      (await settlements.get(gameId, host, quarterId)).publishedAt,
    ).toBeNull();
  });
  it.each(['MilitaryAccess', 'FleetBasing'] as const)(
    'preserves %s history and publishes old drafts as ordinary agreements',
    async (type) => {
      const legacyInput = treaty({
        type: 'Custom',
        visibility: 'Participants',
        terms: '双方口头允许借道，后续争议由主持人处理。',
      });
      expect((await setup([legacyInput])).statusCode).toBe(200);
      const current = (await games.diplomacy.get(gameId, host)).treaties[0]!;
      const oldRecord = { ...current, type, grantorCountryId: south };
      await db.query(
        'UPDATE diplomatic_treaties SET record=$2::jsonb WHERE id=$1',
        [legacyInput.treatyId, JSON.stringify(oldRecord)],
      );
      const oldHistory = (
        await db.query('SELECT change FROM diplomacy_history WHERE id=$1', [
          legacyInput.id,
        ])
      ).rows[0]!.change;
      const historical = {
        ...oldHistory,
        type,
        grantorCountryId: south,
        after: oldRecord,
      };
      await db.query(
        'UPDATE diplomacy_history SET change=$2::jsonb WHERE id=$1',
        [legacyInput.id, JSON.stringify(historical)],
      );
      expect(
        (await games.diplomacy.get(gameId, northUser)).treaties[0]?.terms,
      ).toBe(oldRecord.terms);
      expect((await games.diplomacy.get(gameId, thirdUser)).treaties).toEqual(
        [],
      );
      await start();
      const input = treaty({ expectedRevision: 1, actionId, type: 'Custom' });
      const saved = await save([input]);
      const oldPlan: DiplomacyChange = {
        ...saved.diplomacyChanges![0]!,
        ...input,
        type,
        grantorCountryId: south,
        after: {
          ...(saved.diplomacyChanges![0]!.after as typeof current),
          type,
          grantorCountryId: south,
        },
      };
      await db.query(
        'UPDATE quarter_settlements SET diplomacy_changes=$2::jsonb WHERE game_id=$1 AND quarter_id=$3',
        [gameId, JSON.stringify([oldPlan]), quarterId],
      );
      let version = saved.version;
      if (type === 'MilitaryAccess') {
        const resaved = await settlements.save(gameId, host, quarterId, {
          expectedVersion: version,
          publicReport: '保留约定原文',
          results: [{ actionId, feedback: '双方继续按自由政策处理' }],
        });
        expect(resaved.diplomacyChanges?.[0]?.after).toMatchObject({
          type: 'Custom',
          grantorCountryId: null,
          terms: input.terms,
        });
        version = resaved.version;
      }
      const published = await settlements.publish(
        gameId,
        host,
        quarterId,
        version,
      );
      expect(published.diplomacyChanges?.[0]).toMatchObject({
        type: 'Custom',
        grantorCountryId: null,
        after: { type: 'Custom', grantorCountryId: null, terms: input.terms },
      });
      const final = (
        await games.diplomacy.get(gameId, northUser)
      ).treaties.find((t) => t.id === input.treatyId)!;
      expect(final.type).toBe('Custom');
      expect(final.grantorCountryId).toBeNull();
      expect(
        (
          await db.query('SELECT change FROM diplomacy_history WHERE id=$1', [
            legacyInput.id,
          ])
        ).rows[0]!.change,
      ).toEqual(historical);
    },
  );
  it('strips server metadata from saved requests', () => {
    const t = treaty();
    expect(
      toDiplomacyInput({
        ...t,
        summary: 'hidden',
        after: {},
      } as DiplomacyChangeInput),
    ).toEqual(t);
  });
  it('rejects a preparation form carried into a later quarter even when diplomatic truth is unchanged', async () => {
    const old = war();
    await db.query(
      "UPDATE quarters SET season='Summer',sequence_number=2 WHERE id=$1",
      [quarterId],
    );
    const response = await setup([old]);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('QUARTER_CHANGED');
    expect((await games.diplomacy.get(gameId, host)).relations).toEqual([]);
    quarterSequence = 2;
    expect((await setup([war()])).statusCode).toBe(200);
  });
});
