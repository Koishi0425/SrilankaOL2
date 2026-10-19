import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadServiceConfig } from '@srilanka/config';
import type {
  SettlementStateChangeInput,
  SettlementBattleInput,
} from '@srilanka/contracts';
import { createDatabasePool } from '@srilanka/database';
import { buildApp } from './app.js';
import { ActionService } from './modules/actions/action-service.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { SettlementService } from './modules/settlements/settlement-service.js';
import { WorldService } from './modules/world/world-service.js';

const config = loadServiceConfig({ ...process.env, NODE_ENV: 'test' });
const database = createDatabasePool(config.databaseUrl);
const auth = new AuthService(database);
const games = new GameService(database);
const actions = new ActionService(database);
const world = new WorldService(database);
const settlements = new SettlementService(database);
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
  otherId: string;
let countryId: string, otherCountryId: string, actionId: string, armyId: string;
let hostCookie: string, playerCookie: string, observerCookie: string;
let tiles: string[];
let defenderId: string;
const revision = async () => (await world.getMap(gameId, hostId)).revision!;
const base = () => ({ id: randomUUID(), actionId });
const changes = (): SettlementStateChangeInput[] => [
  { ...base(), kind: 'ArmyMove', armyId, destinationTileId: tiles[1]! },
  { ...base(), kind: 'ArmyStrength', armyId, strength: 720 },
  {
    ...base(),
    kind: 'Territory',
    tileIds: [tiles[1]!],
    controllerCountryId: countryId,
  },
];
const truth = async () => ({
  army: (
    await database.query('SELECT tile_id,strength FROM armies WHERE id=$1', [
      armyId,
    ])
  ).rows[0],
  tile: (
    await database.query(
      'SELECT controller_country_id,legal_owner_country_id FROM hex_tiles WHERE id=$1',
      [tiles[1]],
    )
  ).rows[0],
  city: (
    await database.query(
      'SELECT controller_country_id FROM cities WHERE tile_id=$1',
      [tiles[1]],
    )
  ).rows[0],
  world: (
    await database.query(
      'SELECT current_world_version FROM games WHERE id=$1',
      [gameId],
    )
  ).rows[0]!.current_world_version,
});
async function save(
  stateChanges: SettlementStateChangeInput[],
  expectedVersion = 1,
  cookie = hostCookie,
) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/games/${gameId}/quarters/${quarterId}/settlement`,
    headers: { cookie },
    payload: {
      expectedVersion,
      expectedMapRevision: await revision(),
      publicReport: '边境战事结束。',
      results: [{ actionId, feedback: '北军攻占边城，余下七百二十人。' }],
      stateChanges,
    },
  });
}
async function publish(expectedVersion = 2, expectedMapRevision?: number) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/games/${gameId}/quarters/${quarterId}/settlement/publish`,
    headers: { cookie: hostCookie },
    payload: {
      expectedVersion,
      expectedMapRevision: expectedMapRevision ?? (await revision()),
    },
  });
}
beforeEach(async () => {
  await database.query(
    'TRUNCATE auth_sessions,game_members,quarters,countries,games,users CASCADE',
  );
  const users = [];
  for (const username of [
    'battle-host',
    'battle-player',
    'battle-other',
    'battle-observer',
  ])
    users.push(
      await auth.createDevelopmentUser({
        username,
        displayName: username,
        password: 'state-test-password',
      }),
    );
  hostId = users[0]!.id;
  playerId = users[1]!.id;
  otherId = users[2]!.id;
  const game = await games.create({
    userId: hostId,
    name: '状态结算测试',
    countryNames: ['北国', '南国'],
  });
  gameId = game.id;
  quarterId = game.currentQuarter.id;
  const countries = await games.listCountries(gameId, hostId);
  countryId = countries[0]!.id;
  otherCountryId = countries[1]!.id;
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
  const login = async (username: string) =>
    String(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username, password: 'state-test-password' },
        })
      ).headers['set-cookie'],
    ).split(';')[0]!;
  [hostCookie, playerCookie, observerCookie] = await Promise.all([
    login('battle-host'),
    login('battle-player'),
    login('battle-observer'),
  ]);
  await world.setup.create(gameId, hostId, {
    name: '边境',
    width: 4,
    height: 2,
  });
  tiles = (
    await world.getViewport({
      gameId,
      userId: hostId,
      minQ: 0,
      maxQ: 3,
      minR: 0,
      maxR: 1,
    })
  ).tiles.map((tile) => tile.id);
  await world.setup.batch(gameId, hostId, {
    expectedRevision: await revision(),
    tileIds: [tiles[1]!],
    controllerCountryId: otherCountryId,
    legalOwnerCountryId: otherCountryId,
  });
  await world.createCity({
    gameId,
    userId: hostId,
    tileId: tiles[1]!,
    name: '边城',
  });
  await world.createArmy({
    gameId,
    userId: hostId,
    tileId: tiles[0]!,
    countryId,
    name: '北军',
    strength: 1000,
  });
  armyId = (await world.getTile(gameId, hostId, tiles[0]!)).armies[0]!.id;
  await world.createArmy({
    gameId,
    userId: hostId,
    tileId: tiles[1]!,
    countryId: otherCountryId,
    name: '南军',
    strength: 800,
  });
  defenderId = (await world.getTile(gameId, hostId, tiles[1]!)).armies[0]!.id;
  await world.setup.knowledge(gameId, hostId, {
    expectedRevision: await revision(),
    countryId: otherCountryId,
    tileIds: [tiles[0]!],
    state: 'Observed',
    note: '北军在边境',
    armyErrorPercent: 25,
  });
  await games.transitionCurrentQuarter({
    gameId,
    userId: hostId,
    state: 'ActionSubmission',
  });
  const action = await actions.create({
    gameId,
    userId: playerId,
    quarterId,
    title: '攻占边城',
    originalText: '出兵攻占边城',
    category: 'Military',
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
    reason: '允许执行',
  });
});
afterAll(async () => {
  await app.close();
  await database.end();
});

function battle(): SettlementBattleInput {
  return {
    id: randomUUID(),
    actionId,
    title: '边城之战',
    kind: 'Field',
    tileId: tiles[1]!,
    attackers: [{ armyId, committedStrength: 600 }],
    defenders: [{ armyId: defenderId, committedStrength: 800 }],
    resolution: null,
  };
}
async function saveBattles(
  battles: SettlementBattleInput[],
  expectedVersion = 1,
  stateChanges: SettlementStateChangeInput[] = [],
  cookie = hostCookie,
) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/games/${gameId}/quarters/${quarterId}/settlement`,
    headers: { cookie },
    payload: {
      expectedVersion,
      expectedMapRevision: await revision(),
      publicReport: '边境战事结束。',
      results: [{ actionId, feedback: '北军攻占边城。' }],
      battles,
      stateChanges,
    },
  });
}
function resolution(input: SettlementBattleInput) {
  return {
    ...input,
    resolution: {
      outcome: 'AttackerVictory' as const,
      narrative: '南军退往后方，北军占领边城。',
      armies: [
        { armyId, casualties: 100, destinationTileId: tiles[1]! },
        { armyId: defenderId, casualties: 200, destinationTileId: tiles[2]! },
      ],
      occupyCountryId: countryId,
    },
  };
}
async function roll(
  battleId: string,
  expectedVersion: number,
  overrides: Record<string, unknown> = {},
  cookie = hostCookie,
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/games/${gameId}/quarters/${quarterId}/settlement/battles/${battleId}/roll`,
    headers: { cookie },
    payload: {
      expectedVersion,
      expectedMapRevision: await revision(),
      idempotencyKey: randomUUID(),
      phase: 'Fire',
      count: 1,
      sides: 10,
      zeroBased: true,
      attackerModifier: 1,
      defenderModifier: -1,
      modifierNote: '进攻将领 +1，防守士气低落 −1',
      note: '第一轮',
      ...overrides,
    },
  });
}

describe('battle adjudication', () => {
  it('preserves server rolls on retries, stages losses and movement privately and publishes one immutable battle with the world', async () => {
    await settlements.begin(gameId, hostId, quarterId);
    const input = battle(),
      before = await truth();
    expect((await saveBattles([input])).statusCode).toBe(200);
    expect(await truth()).toEqual(before);
    const key = randomUUID();
    const attempts = await Promise.all([
      roll(input.id, 2, { idempotencyKey: key }),
      roll(input.id, 2, { idempotencyKey: key }),
    ]);
    for (const response of attempts) expect(response.statusCode).toBe(200);
    const rolled = attempts[0]!.json().data;
    expect(rolled.version).toBe(3);
    expect(rolled.battles[0].rolls).toEqual(
      attempts[1]!.json().data.battles[0].rolls,
    );
    const die = rolled.battles[0].rolls[0];
    expect(die.attackerDice[0]).toBeGreaterThanOrEqual(0);
    expect(die.attackerDice[0]).toBeLessThanOrEqual(9);
    expect(die.attackerTotal).toBe(die.attackerDice[0] + 1);
    expect(die.defenderTotal).toBe(die.defenderDice[0] - 1);
    expect((await roll(input.id, 2)).json().error.code).toBe(
      'SETTLEMENT_VERSION_CONFLICT',
    );
    expect(
      (
        await roll(input.id, 3, { idempotencyKey: key, attackerModifier: 2 })
      ).json().error.code,
    ).toBe('IDEMPOTENCY_CONFLICT');
    expect((await publish(3)).json().error.code).toBe('BATTLE_UNRESOLVED');
    expect((await roll(input.id, 3, { phase: 'Shock' })).statusCode).toBe(200);
    const adjudicated = resolution(input);
    expect((await saveBattles([adjudicated], 4)).statusCode).toBe(200);
    expect(await truth()).toEqual(before);
    const pending = await settlements.get(gameId, hostId, quarterId);
    expect(pending.battles![0]!.effects).toHaveLength(5);
    for (const cookie of [playerCookie, observerCookie]) {
      expect((await saveBattles([input], 5, [], cookie)).statusCode).toBe(403);
      expect((await roll(input.id, 5, {}, cookie)).statusCode).toBe(403);
    }
    expect(
      (await settlements.get(gameId, playerId, quarterId)).battles,
    ).toBeUndefined();
    expect(
      (await settlements.get(gameId, otherId, quarterId)).battles,
    ).toBeUndefined();
    const responses = await Promise.all([publish(5), publish(5)]);
    responses.forEach((response) => expect(response.statusCode).toBe(200));
    expect(responses[0]!.json().data.publishedAt).toBe(
      responses[1]!.json().data.publishedAt,
    );
    expect((await truth()).army).toEqual({ tile_id: tiles[1], strength: 900 });
    expect((await truth()).city.controller_country_id).toBe(countryId);
    expect((await truth()).tile).toEqual({
      controller_country_id: countryId,
      legal_owner_country_id: otherCountryId,
    });
    expect(Number((await truth()).world)).toBe(Number(before.world) + 1);
    expect(
      (
        await database.query(
          'SELECT strength,tile_id FROM armies WHERE id=$1',
          [defenderId],
        )
      ).rows[0],
    ).toEqual({ strength: 600, tile_id: tiles[2] });
    expect(
      (await settlements.get(gameId, playerId, quarterId)).battles,
    ).toBeUndefined();
    const history = responses[0]!.json().data.battles;
    expect(
      (await roll(input.id, 2, { idempotencyKey: key })).json().data.battles,
    ).toEqual(history);
    expect((await roll(input.id, 5)).statusCode).toBe(409);
    await settlements.advance(gameId, hostId, quarterId);
    await world.moveArmy({
      gameId,
      userId: hostId,
      armyId,
      tileId: tiles[3]!,
      expectedRevision: await revision(),
      correctionReason: '验收历史保留：修正军队位置',
    });
    expect((await settlements.get(gameId, hostId, quarterId)).battles).toEqual(
      history,
    );
    expect(
      (
        await database.query(
          'SELECT count(*) AS count FROM settlement_battle_rolls WHERE game_id=$1',
          [gameId],
        )
      ).rows[0]!.count,
    ).toBe('2');
  });

  it('supports siege and custom dice without allowing client supplied results, invalid presets or missing modifier reasons', async () => {
    await settlements.begin(gameId, hostId, quarterId);
    const input = { ...battle(), kind: 'Siege' as const };
    expect((await saveBattles([input])).statusCode).toBe(200);
    expect(
      (
        await roll(input.id, 2, {
          phase: 'Siege',
          sides: 14,
          zeroBased: false,
          attackerDice: [14],
          defenderModifier: 0,
        })
      ).statusCode,
    ).toBe(200);
    const siege = (await settlements.get(gameId, hostId, quarterId))
      .battles![0]!.rolls[0]!;
    expect(siege.attackerDice).toHaveLength(1);
    expect(siege.attackerDice[0]).toBeGreaterThanOrEqual(1);
    expect(siege.attackerDice[0]).toBeLessThanOrEqual(14);
    expect(siege.defenderDice).toEqual([]);
    expect(siege.defenderTotal).toBeNull();
    for (const override of [
      { phase: 'Fire', sides: 6 },
      { modifierNote: '' },
      { count: 21 },
      { sides: 1 },
      { attackerModifier: 10001 },
      { phase: 'Siege', sides: 14, zeroBased: false },
    ])
      expect((await roll(input.id, 3, override)).statusCode).toBe(400);
    expect(
      (
        await roll(input.id, 3, {
          phase: 'Custom',
          count: 2,
          sides: 6,
          zeroBased: false,
        })
      ).statusCode,
    ).toBe(200);
    const custom = (await settlements.get(gameId, hostId, quarterId))
      .battles![0]!.rolls[1]!;
    expect(custom.attackerDice).toHaveLength(2);
    for (const value of [...custom.attackerDice, ...custom.defenderDice])
      expect(value >= 1 && value <= 6).toBe(true);
    expect(custom.attackerTotal).toBe(
      custom.attackerDice.reduce((a, b) => a + b, 1),
    );
    expect((await saveBattles([resolution(input)], 4)).statusCode).toBe(200);
    expect((await roll(input.id, 5)).statusCode).toBe(400);
    expect(
      (await settlements.get(gameId, hostId, quarterId)).battles![0]!.rolls,
    ).toHaveLength(2);
  });

  it('rejects invalid participants, losses, occupation and overlapping manual effects and keeps the draft unchanged', async () => {
    await settlements.begin(gameId, hostId, quarterId);
    const input = battle(),
      resolved = resolution(input);
    const invalids = [
      { ...input, tileId: randomUUID() },
      { ...input, actionId: randomUUID() },
      { ...input, attackers: [{ armyId: randomUUID(), committedStrength: 1 }] },
      { ...input, attackers: [{ armyId, committedStrength: 1001 }] },
      { ...input, defenders: input.attackers },
      {
        ...resolved,
        resolution: {
          ...resolved.resolution,
          armies: [
            { armyId, casualties: 601, destinationTileId: null },
            resolved.resolution.armies[1]!,
          ],
        },
      },
      {
        ...resolved,
        resolution: {
          ...resolved.resolution,
          armies: [resolved.resolution.armies[0]!],
        },
      },
      {
        ...resolved,
        resolution: {
          ...resolved.resolution,
          armies: resolved.resolution.armies.map((item) => ({
            ...item,
            destinationTileId: randomUUID(),
          })),
        },
      },
      {
        ...resolved,
        resolution: { ...resolved.resolution, occupyCountryId: otherCountryId },
      },
      {
        ...resolved,
        resolution: { ...resolved.resolution, outcome: 'Draw' as const },
      },
    ];
    for (const candidate of invalids)
      expect((await saveBattles([candidate])).statusCode).toBe(400);
    expect(
      (await saveBattles([input, { ...input, id: randomUUID() }])).statusCode,
    ).toBe(400);
    expect(
      (await saveBattles([resolved], 1, [changes()[1]!])).json().error.code,
    ).toBe('INVALID_STATE_CHANGE');
    expect((await settlements.get(gameId, hostId, quarterId)).version).toBe(1);
    expect((await saveBattles([input])).statusCode).toBe(200);
    expect(
      (await saveBattles([{ ...input, title: '改变参战信息' }], 2)).statusCode,
    ).toBe(400);
    expect(
      (
        await roll(input.id, 2, {
          phase: 'Siege',
          sides: 14,
          zeroBased: false,
          defenderModifier: 0,
        })
      ).statusCode,
    ).toBe(400);
    expect((await save([], 2)).statusCode).toBe(200);
    expect(
      (await settlements.get(gameId, hostId, quarterId)).battles![0]!.id,
    ).toBe(input.id);
  });

  it('rejects changed truth before rolling or publishing and never silently rebases text-only saves', async () => {
    await settlements.begin(gameId, hostId, quarterId);
    const input = battle();
    expect((await saveBattles([input])).statusCode).toBe(200);
    const oldRevision = await revision();
    await world.moveArmy({
      gameId,
      userId: hostId,
      armyId,
      tileId: tiles[2]!,
      expectedRevision: await revision(),
      correctionReason: '验收掷骰冲突：修正军队位置',
    });
    expect(
      (await roll(input.id, 2, { expectedMapRevision: oldRevision })).json()
        .error.code,
    ).toBe('MAP_VERSION_CONFLICT');
    expect((await roll(input.id, 2)).json().error.code).toBe(
      'BATTLE_STATE_CONFLICT',
    );
    expect((await save([], 2)).json().error.code).toBe('BATTLE_STATE_CONFLICT');
    expect((await saveBattles([resolution(input)], 2)).json().error.code).toBe(
      'BATTLE_STATE_CONFLICT',
    );
    expect(
      (
        await database.query(
          'SELECT count(*) AS count FROM settlement_battle_rolls WHERE game_id=$1',
          [gameId],
        )
      ).rows[0]!.count,
    ).toBe('0');
    expect((await saveBattles([], 2)).statusCode).toBe(200);
    const fresh = resolution(battle());
    expect((await saveBattles([fresh], 3)).statusCode).toBe(200);
    await world.moveArmy({
      gameId,
      userId: hostId,
      armyId,
      tileId: tiles[3]!,
      expectedRevision: await revision(),
      correctionReason: '验收发布冲突：修正军队位置',
    });
    const before = await truth();
    expect((await publish(4)).json().error.code).toBe('BATTLE_STATE_CONFLICT');
    expect(await truth()).toEqual(before);
    expect(
      (await settlements.get(gameId, hostId, quarterId)).publishedAt,
    ).toBeNull();
  });

  it('rolls back battle effects and publication if exploration cannot publish', async () => {
    await world.setup.knowledge(gameId, hostId, {
      expectedRevision: await revision(),
      countryId,
      tileIds: [tiles[1]!],
      state: 'Observed',
      note: '边城',
      sourceActionId: actionId,
    });
    await database.query("UPDATE actions SET status='Rejected' WHERE id=$1", [
      actionId,
    ]);
    await settlements.begin(gameId, hostId, quarterId);
    const input = resolution({ ...battle(), actionId: null });
    expect((await saveBattles([input])).statusCode).toBe(200);
    const before = await truth(),
      beforeRevision = await revision();
    expect((await publish()).json().error.code).toBe(
      'INVALID_EXPLORATION_RESULT',
    );
    expect(await truth()).toEqual(before);
    expect(await revision()).toBe(beforeRevision);
    expect(
      (await settlements.get(gameId, hostId, quarterId)).publishedAt,
    ).toBeNull();
  });
});
