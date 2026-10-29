import { afterAll, beforeEach, expect, it } from 'vitest';
import { loadServiceConfig } from '@srilanka/config';
import { createDatabasePool } from '@srilanka/database';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { WorldService } from './modules/world/world-service.js';

const database = createDatabasePool(
  loadServiceConfig({ ...process.env, NODE_ENV: 'test' }).databaseUrl,
);
const auth = new AuthService(database),
  games = new GameService(database),
  world = new WorldService(database);
let gameId: string,
  host: string,
  player: string,
  country: string,
  enemy: string,
  preview: string;
let tiles: Array<{ id: string; q: number; r: number }>;
const at = (q: number, r: number) => tiles.find((t) => t.q === q && t.r === r)!;
const revision = async () => (await world.getMap(gameId, host)).revision!;
const details = (q: number, r: number) =>
  world.getTile(gameId, player, at(q, r).id);
beforeEach(async () => {
  await database.query(
    'TRUNCATE auth_sessions,game_members,quarters,countries,games,users CASCADE',
  );
  const users = [];
  for (const username of ['vision-host', 'vision-player', 'vision-enemy'])
    users.push(
      await auth.createDevelopmentUser({
        username,
        displayName: username,
        password: 'vision-test-password',
      }),
    );
  host = users[0]!.id;
  player = users[1]!.id;
  const game = await games.create({
    userId: host,
    name: '视野验证',
    countryNames: ['北国', '南国'],
  });
  gameId = game.id;
  const countries = await games.listCountries(gameId, host);
  country = countries.find((c) => c.name === '北国')!.id;
  enemy = countries.find((c) => c.name === '南国')!.id;
  for (const [i, user] of users.slice(1).entries()) {
    const member = await games.addMember({
      gameId,
      actorUserId: host,
      username: user.username,
      role: 'Player',
    });
    await games.assignCountry({
      gameId,
      actorUserId: host,
      memberId: member.id,
      countryId: i === 0 ? country : enemy,
    });
    if (i === 0) preview = member.id;
  }
  await world.setup.create(gameId, host, {
    name: '远近视野',
    width: 14,
    height: 8,
  });
  tiles = (
    await world.getViewport({
      gameId,
      userId: host,
      minQ: 0,
      maxQ: 13,
      minR: 0,
      maxR: 7,
    })
  ).tiles;
  await world.setup.batch(gameId, host, {
    expectedRevision: await revision(),
    tileIds: tiles.filter((t) => t.q >= 4).map((t) => t.id),
    regionName: '南地',
    provinceName: '南省',
    legalOwnerCountryId: enemy,
    controllerCountryId: enemy,
  });
  await world.setup.batch(gameId, host, {
    expectedRevision: await revision(),
    tileIds: [at(2, 3).id],
    regionName: '北地',
    provinceName: '北省',
    legalOwnerCountryId: country,
    controllerCountryId: country,
  });
  await world.setup.initializeKnowledge(gameId, host, {
    expectedRevision: await revision(),
    countryId: country,
    mode: 'Geography',
  });
});
afterAll(async () => {
  await database.end();
});

it('keeps the homeland current, observes two hexes beyond the border, and does not disclose foreign administration through geography or targeting', async () => {
  expect(await details(4, 3)).toMatchObject({
    discoveryState: 'Observed',
    controllerCountryId: enemy,
    provinceName: null,
    regionId: null,
    regionName: null,
  });
  expect(await details(5, 3)).toMatchObject({
    discoveryState: 'Mapped',
    terrainName: '平原',
    provinceName: null,
    regionId: null,
    controllerCountryId: null,
  });
  const far = await world.getTileContext(gameId, player, at(10, 3).id);
  expect(far.province).toBeNull();
  expect(await world.search(gameId, player, '南地')).toEqual([]);
  const foreign = (await world.provinces.list(gameId, host)).provinces.find(
    (p) => p.name === '南省',
  )!;
  await expect(
    world.locateReference(gameId, player, 'Province', foreign.id),
  ).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' });
  await world.setup.knowledge(gameId, host, {
    expectedRevision: await revision(),
    countryId: country,
    tileIds: [at(4, 3).id],
    state: 'Observed',
    note: '使节提供本地行政资料',
  });
  const context = await world.getTileContext(gameId, player, at(4, 3).id);
  expect(context.province!.tiles.map((t) => t.id)).toEqual([at(4, 3).id]);
  expect(
    (await world.locateReference(gameId, player, 'Province', foreign.id)).scope,
  ).toEqual([{ id: at(4, 3).id, q: 4, r: 3 }]);
  await world.createCity({
    gameId,
    userId: host,
    tileId: at(2, 3).id,
    name: '本土新城',
  });
  const home = await details(2, 3);
  expect(home.discoveryState).toBe('Observed');
  expect(home.observedWorldVersion).toBe(
    (await world.getMap(gameId, host)).currentWorldVersion,
  );
  expect(home.cities.map((c) => c.name)).toContain('本土新城');
  expect(await world.getTile(gameId, host, at(2, 3).id, preview)).toEqual(home);
  expect(
    await world.getTileContext(gameId, host, at(4, 3).id, preview),
  ).toEqual(await world.getTileContext(gameId, player, at(4, 3).id));
});

it('retains old geography after a remote homeland enclave is occupied, and refreshes it when friendly forces return', async () => {
  await world.setup.batch(gameId, host, {
    expectedRevision: await revision(),
    tileIds: [at(11, 3).id],
    regionName: '北方飞地',
    provinceName: '北省',
    legalOwnerCountryId: country,
    controllerCountryId: country,
  });
  await world.createCity({
    gameId,
    userId: host,
    tileId: at(11, 3).id,
    name: '飞地旧城',
  });
  expect((await details(11, 3)).discoveryState).toBe('Observed');
  await world.setup.batch(gameId, host, {
    expectedRevision: await revision(),
    tileIds: [at(11, 3).id],
    controllerCountryId: enemy,
  });
  await world.createCity({
    gameId,
    userId: host,
    tileId: at(11, 3).id,
    name: '敌占后新城',
  });
  expect(await details(11, 3)).toMatchObject({
    discoveryState: 'Mapped',
    controllerCountryId: country,
  });
  expect((await details(11, 3)).cities.map((c) => c.name)).toEqual([
    '飞地旧城',
  ]);
  const observed = await world.createArmy({
    gameId,
    userId: host,
    tileId: at(11, 3).id,
    countryId: country,
    name: '返回的侦察队',
    strength: 100,
  });
  const army = observed.armies.find((a) => a.countryId === country)!;
  expect(await details(11, 3)).toMatchObject({
    discoveryState: 'Observed',
    controllerCountryId: enemy,
    legalOwnerCountryId: country,
  });
  expect((await details(11, 3)).cities.map((c) => c.name)).toContain(
    '敌占后新城',
  );
  await world.moveArmy({
    gameId,
    userId: host,
    armyId: army.id,
    tileId: at(2, 3).id,
  });
  expect((await details(11, 3)).discoveryState).toBe('Mapped');
});

it('shows only estimates of nearby enemies, keeps old reports after scouts withdraw, and clears sightings when an observed position is empty', async () => {
  await world.createArmy({
    gameId,
    userId: host,
    tileId: at(9, 6).id,
    countryId: enemy,
    name: '南军',
    strength: 500,
  });
  const enemyArmy = (
    await world.getTile(gameId, host, at(9, 6).id)
  ).armies.find((a) => a.countryId === enemy)!;
  expect((await details(9, 6)).armies).toEqual([]);
  const army = await world.createArmy({
    gameId,
    userId: host,
    tileId: at(7, 6).id,
    countryId: country,
    name: '北国侦察队',
    strength: 100,
  });
  const scout = army.armies.find((a) => a.countryId === country)!;
  expect((await details(9, 6)).armies).toContainEqual(
    expect.objectContaining({
      id: enemyArmy.id,
      strength: { kind: 'Range', min: 400, max: 600 },
      outdated: false,
    }),
  );
  await world.moveArmy({
    gameId,
    userId: host,
    armyId: scout.id,
    tileId: at(2, 3).id,
  });
  expect((await details(9, 6)).armies).toContainEqual(
    expect.objectContaining({ id: enemyArmy.id, outdated: true }),
  );
  await world.moveArmy({
    gameId,
    userId: host,
    armyId: enemyArmy.id,
    tileId: at(13, 6).id,
  });
  expect((await details(9, 6)).armies[0]?.outdated).toBe(true);
  expect((await details(13, 6)).armies).toEqual([]);
  await world.moveArmy({
    gameId,
    userId: host,
    armyId: scout.id,
    tileId: at(7, 6).id,
  });
  expect((await details(9, 6)).armies).toEqual([]);
  expect(await world.search(gameId, player, '南军')).toEqual([]);
});
