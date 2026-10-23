import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { DatabasePool } from '@srilanka/database';
import type {
  SaveSettlementInput,
  SettlementAction,
  SettlementResultAudience,
} from '@srilanka/contracts';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { SettlementService } from './settlement-service.js';

const pg = new PGlite();
const client = {
  async query(sql: string, params?: unknown[]) {
    const result = await pg.query(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows };
  },
  release() {},
};
const pool = {
  ...client,
  connect: async () => client,
} as unknown as DatabasePool;
const service = new SettlementService(pool);
const gameId = randomUUID(),
  quarterId = randomUUID(),
  countryId = randomUUID(),
  otherCountryId = randomUUID();
const hostId = randomUUID(),
  playerId = randomUUID(),
  otherPlayerId = randomUUID(),
  observerId = randomUUID(),
  unassignedId = randomUUID(),
  outsiderId = randomUUID();
const playerMemberId = randomUUID();
const foreignGame = randomUUID(),
  foreignCountry = randomUUID();
let actions: SettlementAction[];

beforeAll(async () => {
  const directory = new URL(
    '../../../../../packages/database/migrations/',
    import.meta.url,
  );
  for (const file of (await readdir(directory))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    await pg.exec(await readFile(new URL(file, directory), 'utf8'));
}, 30000);
beforeEach(async () => {
  await pg.exec('TRUNCATE users, games CASCADE');
  for (const id of [
    hostId,
    playerId,
    otherPlayerId,
    observerId,
    unassignedId,
    outsiderId,
  ])
    await pg.query(
      "INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$2,'unused')",
      [id, id.slice(0, 8)],
    );
  await pg.query(
    "INSERT INTO games(id,name,host_user_id) VALUES($1,'历史游戏',$2)",
    [foreignGame, hostId],
  );
  await pg.query(
    "INSERT INTO countries(id,game_id,name) VALUES($1,$2,'历史国家')",
    [foreignCountry, foreignGame],
  );
  await pg.query("UPDATE games SET status='Completed' WHERE id=$1", [
    foreignGame,
  ]);
  await pg.query(
    "INSERT INTO games(id,name,host_user_id,status) VALUES($1,'结果可见范围测试',$2,'Running')",
    [gameId, hostId],
  );
  for (const [id, name] of [
    [countryId, '康提'],
    [otherCountryId, '海岸'],
  ])
    await pg.query('INSERT INTO countries(id,game_id,name) VALUES($1,$2,$3)', [
      id,
      gameId,
      name,
    ]);
  await pg.query(
    "INSERT INTO quarters(id,game_id,game_year,season,sequence_number,state) VALUES($1,$2,1,'Spring',1,'Resolving')",
    [quarterId, gameId],
  );
  for (const [id, user, role, country] of [
    [randomUUID(), hostId, 'Host', null],
    [playerMemberId, playerId, 'Player', countryId],
    [randomUUID(), otherPlayerId, 'Player', otherCountryId],
    [randomUUID(), observerId, 'Observer', null],
    [randomUUID(), unassignedId, 'Player', null],
  ])
    await pg.query(
      "INSERT INTO game_members(id,game_id,user_id,role,status,controlled_country_id) VALUES($1,$2,$3,$4,'Active',$5)",
      [id, gameId, user, role, country],
    );
  const audiences: Array<SettlementResultAudience | undefined> = [
    undefined,
    { kind: 'OwnerOnly' },
    { kind: 'Countries', countryIds: [otherCountryId] },
    { kind: 'Countries', countryIds: [countryId, otherCountryId] },
    { kind: 'Public' },
    { kind: 'HostOnly' },
  ];
  actions = audiences.map((audience, i) => ({
    actionId: randomUUID(),
    countryId,
    countryName: '康提',
    title: `私密标题${i}`,
    submittedText: `私密原文${i}`,
    status: 'Approved',
    reviewReason: `内部审核${i}`,
    feedback: `结果${i}`,
    refs: [
      {
        refKind: 'Target',
        objectType: 'Country',
        objectId: countryId,
        label: '私密目标',
      },
    ],
    ...(audience ? { resultAudience: audience } : {}),
  }));
  for (const action of actions) {
    await pg.query(
      "INSERT INTO actions(id,game_id,quarter_id,country_id,created_by_member_id,title,category,current_text,submitted_original_text,secrecy,status) VALUES($1,$2,$3,$4,$5,$6,'Research',$7,$7,'Public','Approved')",
      [
        action.actionId,
        gameId,
        quarterId,
        countryId,
        playerMemberId,
        action.title,
        action.submittedText,
      ],
    );
    await pg.query(
      "INSERT INTO action_status_history(id,game_id,action_id,from_status,to_status,actor_user_id,reason) VALUES($1,$2,$3,'Submitted','Approved',$4,$5)",
      [randomUUID(), gameId, action.actionId, hostId, action.reviewReason],
    );
  }
  await pg.query(
    'INSERT INTO quarter_settlements(game_id,quarter_id,updated_by_user_id) VALUES($1,$2,$3)',
    [gameId, quarterId, hostId],
  );
});
afterAll(async () => {
  await pg.close();
});

async function snapshot() {
  await pg.query(
    'UPDATE quarter_settlements SET published_snapshot=$3::jsonb,published_at=NOW() WHERE game_id=$1 AND quarter_id=$2',
    [gameId, quarterId, JSON.stringify({ publicReport: '公报', actions })],
  );
}
function input(expectedVersion = 1): SaveSettlementInput {
  return {
    expectedVersion,
    publicReport: '公报',
    results: actions.map(({ actionId, feedback, resultAudience }) => ({
      actionId,
      feedback,
      resultAudience,
    })),
  };
}
async function get(userId: string) {
  return service.get(gameId, userId, quarterId);
}

it('enforces all audiences on the server and never discloses policy internals to foreign recipients or observers', async () => {
  await snapshot();
  const owner = await get(playerId);
  expect(owner.actions.map((a) => a.feedback)).toEqual([
    '结果0',
    '结果1',
    '结果3',
    '结果4',
  ]);
  expect(
    owner.actions.every(
      (a) => a.canViewPolicy && a.submittedText.startsWith('私密原文'),
    ),
  ).toBe(true);
  const foreign = await get(otherPlayerId);
  expect(foreign.actions.map((a) => a.feedback)).toEqual([
    '结果2',
    '结果3',
    '结果4',
  ]);
  for (const user of [otherPlayerId, observerId, unassignedId]) {
    const result = await get(user);
    if (user !== otherPlayerId)
      expect(result.actions.map((a) => a.feedback)).toEqual(['结果4']);
    expect(result.resultCountries).toBeUndefined();
    for (const action of result.actions)
      expect(action).toMatchObject({
        title: '政策结算结果',
        submittedText: '',
        reviewReason: '',
        refs: [],
        canViewPolicy: false,
      });
    expect(JSON.stringify(result)).not.toMatch(/私密|内部审核|resultAudience/);
  }
  const host = await get(hostId);
  expect(host.actions).toHaveLength(6);
  expect(host.resultCountries).toHaveLength(2);
  await expect(get(outsiderId)).rejects.toMatchObject({
    code: 'OBJECT_NOT_FOUND',
  });
  await pg.query(
    "UPDATE game_members SET status='Left' WHERE game_id=$1 AND user_id=$2",
    [gameId, otherPlayerId],
  );
  await expect(get(otherPlayerId)).rejects.toMatchObject({
    code: 'OBJECT_NOT_FOUND',
  });
});

it('does not reveal public drafts, preserves omitted audiences for older clients, and freezes them at publication', async () => {
  const saved = await service.save(gameId, hostId, quarterId, input());
  expect(
    saved.actions.find((a) => a.actionId === actions[0]!.actionId)
      ?.resultAudience,
  ).toEqual({ kind: 'OwnerOnly' });
  for (const user of [playerId, otherPlayerId, observerId])
    expect((await get(user)).actions).toEqual([]);
  const legacyInput = {
    ...input(saved.version),
    results: actions.map(({ actionId, feedback }) => ({ actionId, feedback })),
  };
  const resaved = await service.save(gameId, hostId, quarterId, legacyInput);
  expect(
    resaved.actions.find((a) => a.actionId === actions[2]!.actionId)
      ?.resultAudience,
  ).toEqual({ kind: 'Countries', countryIds: [otherCountryId] });
  await expect(
    service.save(gameId, playerId, quarterId, input(resaved.version)),
  ).rejects.toMatchObject({ code: 'HOST_PERMISSION_REQUIRED' });
  const published = await service.publish(
    gameId,
    hostId,
    quarterId,
    resaved.version,
  );
  expect(published.publishedAt).toBeTruthy();
  expect(
    (await get(otherPlayerId)).actions.map((a) => a.feedback).sort(),
  ).toEqual(['结果2', '结果3', '结果4']);
  await expect(
    service.save(gameId, hostId, quarterId, input(resaved.version)),
  ).rejects.toMatchObject({ code: 'SETTLEMENT_LOCKED' });
  // An unrelated draft JSON change cannot alter the already-published audience.
  await pg.query(
    "UPDATE quarter_settlements SET results='[]'::jsonb WHERE game_id=$1 AND quarter_id=$2",
    [gameId, quarterId],
  );
  expect((await get(observerId)).actions.map((a) => a.feedback)).toEqual([
    '结果4',
  ]);
});

it('rejects empty, duplicated, unknown and cross-game targets without partially saving feedback', async () => {
  for (const countryIds of [
    [],
    [countryId, countryId],
    [randomUUID()],
    [foreignCountry],
  ]) {
    const invalid = input();
    invalid.results[0]!.resultAudience = { kind: 'Countries', countryIds };
    await expect(
      service.save(gameId, hostId, quarterId, invalid),
    ).rejects.toMatchObject({ code: 'INVALID_RESULT_AUDIENCE' });
    expect((await get(hostId)).version).toBe(1);
    expect((await get(hostId)).actions.every((a) => a.feedback === '')).toBe(
      true,
    );
  }
});

it('applies feedback corrections and correction timestamps only to their published audience', async () => {
  await snapshot();
  // Only the other country can see this result, even the author cannot.
  await service.corrections.correct(gameId, hostId, quarterId, {
    id: randomUUID(),
    expectedCurrentQuarterId: quarterId,
    expectedCorrectionVersion: 0,
    reason: '结果数字修订',
    change: {
      kind: 'ActionFeedback',
      actionId: actions[2]!.actionId,
      text: '更正后的结果',
    },
  });
  const foreign = await get(otherPlayerId);
  expect(
    foreign.actions.find((a) => a.actionId === actions[2]!.actionId)?.feedback,
  ).toBe('更正后的结果');
  expect(foreign.corrections).toHaveLength(1);
  expect(foreign.corrections![0]!.change).toMatchObject({
    title: '政策结算结果',
  });
  expect(JSON.stringify(foreign)).not.toMatch(/私密|内部审核/);
  expect(
    (await service.list(gameId, otherPlayerId))[0]!.correctedAt,
  ).toBeTruthy();
  for (const user of [playerId, observerId]) {
    expect((await get(user)).corrections).toEqual([]);
    expect((await service.list(gameId, user))[0]!.correctedAt).toBeNull();
  }
  await service.corrections.correct(gameId, hostId, quarterId, {
    id: randomUUID(),
    expectedCurrentQuarterId: quarterId,
    expectedCorrectionVersion: 1,
    reason: '公开结果修订',
    change: {
      kind: 'ActionFeedback',
      actionId: actions[4]!.actionId,
      text: '更正后的公开结果',
    },
  });
  expect((await get(observerId)).corrections).toHaveLength(1);
  expect((await service.list(gameId, observerId))[0]!.correctedAt).toBeTruthy();
});
