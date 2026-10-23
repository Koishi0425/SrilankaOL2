import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { DatabasePool } from '@srilanka/database';
import type { RoundPolicy, RoundPolicySectionInput } from '@srilanka/contracts';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { ActionService } from './action-service.js';
import { registerActionRoutes } from './action-routes.js';
import type { AuthService } from '../auth/auth-service.js';
import { ApiFault } from '../../errors.js';

// Execute the real migrations and service SQL in an isolated PostgreSQL engine.
// PGlite has one connection: cross-connection lock races still need server integration tests.
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
const service = new ActionService(pool).roundPolicies;
const gameId = randomUUID(),
  quarterId = randomUUID(),
  countryId = randomUUID(),
  otherCountryId = randomUUID();
const hostId = randomUUID(),
  playerId = randomUUID(),
  enemyId = randomUUID(),
  observerId = randomUUID();
const memberId = randomUUID(),
  hostMemberId = randomUUID();
const key = { gameId, quarterId, memberId, countryId };
const section = (
  text = '政策正文',
  category: RoundPolicySectionInput['category'] = 'Research',
): RoundPolicySectionInput => ({
  id: randomUUID(),
  title: '自拟分类标题',
  text,
  category,
  secrecy: 'OwnerOnly',
  refs: [],
});
async function save(
  policy: RoundPolicy,
  sections: RoundPolicySectionInput[],
  submit = true,
  requestId = randomUUID(),
) {
  return service.save(gameId, playerId, quarterId, {
    requestId,
    expectedRevision: policy.revision,
    sections,
    submit,
  });
}
async function review(
  policy: RoundPolicy,
  target: 'Approved' | 'Rejected' | 'NeedPlayerInput' | 'Interpretation',
  reason = '整份意见',
) {
  return service.review(key, hostId, {
    requestId: randomUUID(),
    expectedRevision: policy.revision,
    target,
    reason,
  });
}
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
  for (const [id, name] of [
    [hostId, '主持人'],
    [playerId, '玩家甲'],
    [enemyId, '玩家乙'],
    [observerId, '旁观者'],
  ])
    await pg.query(
      "INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$2,'unused')",
      [id, name],
    );
  await pg.query(
    "INSERT INTO games(id,name,host_user_id,status) VALUES($1,'政策测试',$2,'Running')",
    [gameId, hostId],
  );
  for (const id of [countryId, otherCountryId])
    await pg.query('INSERT INTO countries(id,game_id,name) VALUES($1,$2,$3)', [
      id,
      gameId,
      id,
    ]);
  await pg.query(
    "INSERT INTO quarters(id,game_id,game_year,season,sequence_number,state) VALUES($1,$2,1,'Spring',1,'ActionSubmission')",
    [quarterId, gameId],
  );
  for (const [id, user, role, country] of [
    [hostMemberId, hostId, 'Host', null],
    [memberId, playerId, 'Player', countryId],
    [randomUUID(), enemyId, 'Player', otherCountryId],
    [randomUUID(), observerId, 'Observer', null],
  ])
    await pg.query(
      "INSERT INTO game_members(id,game_id,user_id,role,status,controlled_country_id) VALUES($1,$2,$3,$4,'Active',$5)",
      [id, gameId, user, role, country],
    );
});
afterAll(async () => {
  await pg.close();
});

it('saves repeated categories as one document and formally submits all sections once', async () => {
  const empty = await service.mine(gameId, playerId, quarterId);
  const sections = [
    section('研究兼外交'),
    section('研究兼内政'),
    section('自拟跨领域内容', 'Custom'),
  ];
  const draft = await save(empty, sections, false);
  expect(draft.draftSections).toEqual(sections);
  expect(draft.sections).toEqual([]);
  expect(await service.list(gameId, hostId, quarterId)).toEqual([]);
  const requestId = randomUUID();
  const input = {
    requestId,
    expectedRevision: draft.revision,
    sections,
    submit: true,
  };
  const formal = await service.save(gameId, playerId, quarterId, input);
  expect(formal.sections).toHaveLength(3);
  expect(formal.history).toHaveLength(1);
  expect(formal.history[0]?.whole).toBe(true);
  expect(formal.history[0]?.sections).toHaveLength(3);
  expect(await service.list(gameId, hostId, quarterId)).toMatchObject([
    { memberId, sectionCount: 3, status: 'Submitted' },
  ]);
  await service.save(gameId, playerId, quarterId, input);
  expect(
    (await service.mine(gameId, playerId, quarterId)).history,
  ).toHaveLength(1);
  await expect(
    service.save(gameId, playerId, quarterId, {
      ...input,
      sections: [section()],
    }),
  ).rejects.toMatchObject({ code: 'POLICY_REQUEST_CONFLICT' });
});

it('keeps unsubmitted edits, removals and new sections out of the host formal document', async () => {
  const sections = [section('原研究'), section('原外交', 'Diplomacy')];
  const formal = await save(
    await service.mine(gameId, playerId, quarterId),
    sections,
  );
  const edited = [
    { ...sections[0]!, title: '尚未交出的标题', text: '尚未交出的正文' },
    section('秘密草稿', 'Policy'),
  ];
  const draft = await save(formal, edited, false);
  const host = await service.get(
    gameId,
    hostId,
    quarterId,
    memberId,
    countryId,
  );
  expect(host.draftSections).toBeUndefined();
  expect(host.sections.map((s) => s.text)).toEqual(['原研究', '原外交']);
  expect(JSON.stringify(host)).not.toContain('尚未交出');
  expect(JSON.stringify(host)).not.toContain('秘密草稿');
  const next = await save(draft, edited);
  expect(next.sections.map((s) => s.text)).toEqual([
    '尚未交出的正文',
    '秘密草稿',
  ]);
  expect(next.history).toHaveLength(2);
  expect(
    (
      await pg.query<{ status: string }>(
        'SELECT status FROM actions WHERE id=$1',
        [sections[1]!.id],
      )
    ).rows[0]?.status,
  ).toBe('Withdrawn');
});

it('reviews the entire document and sends one supplement message, then accepts one whole response', async () => {
  const formal = await save(await service.mine(gameId, playerId, quarterId), [
    section(),
    section('外交正文', 'Diplomacy'),
  ]);
  await pg.query("UPDATE quarters SET state='HostReview' WHERE id=$1", [
    quarterId,
  ]);
  const needed = await review(formal, 'NeedPlayerInput', '请统一说明各项投入');
  expect(needed.sections.every((s) => s.status === 'NeedPlayerInput')).toBe(
    true,
  );
  expect((await pg.query('SELECT * FROM messages')).rows).toHaveLength(1);
  expect((await service.mine(gameId, playerId, quarterId)).canSubmit).toBe(
    true,
  );
  await expect(review(needed, 'Approved')).rejects.toMatchObject({
    code: 'POLICY_AWAITING_INPUT',
  });
  const response = await save(needed, [
    ...formal.sections.map((s) => ({ ...s, text: `补充${s.text}` })),
    section('新增说明', 'Custom'),
  ]);
  expect(response.pendingInputRequest).toBeNull();
  expect(response.status).toBe('HostReview');
  expect(
    (
      await pg.query(
        "SELECT * FROM action_input_requests WHERE status='Pending'",
      )
    ).rows,
  ).toHaveLength(0);
  const approved = await review(response, 'Approved');
  expect(approved.sections.every((s) => s.status === 'Approved')).toBe(true);
  expect((await service.mine(gameId, playerId, quarterId)).canEdit).toBe(false);
  const explained = await review(
    approved,
    'Interpretation',
    '全部按此投入解释',
  );
  expect(explained.interpretation).toBe('全部按此投入解释');
});

it('rolls back every section and the request record when a later section fails validation', async () => {
  const empty = await service.mine(gameId, playerId, quarterId);
  const requestId = randomUUID();
  await expect(
    save(
      empty,
      [
        section('第一项有效'),
        {
          ...section('第二项无效'),
          refs: [
            {
              refKind: 'Target',
              objectType: 'Tile',
              objectId: randomUUID(),
              label: '不存在',
            },
          ],
        },
      ],
      true,
      requestId,
    ),
  ).rejects.toThrow();
  expect((await pg.query('SELECT * FROM actions')).rows).toHaveLength(0);
  expect(
    (await pg.query('SELECT * FROM round_policy_requests')).rows,
  ).toHaveLength(0);
  expect((await service.mine(gameId, playerId, quarterId)).revision).toBe(
    empty.revision,
  );
  await save(empty, [section()], true, requestId);
});

it('rejects stale writes, forbidden viewers, locked edits and expired ordinary submissions', async () => {
  const empty = await service.mine(gameId, playerId, quarterId);
  const formal = await save(empty, [section()]);
  await expect(save(empty, [section()])).rejects.toMatchObject({
    code: 'ROUND_POLICY_CHANGED',
  });
  await expect(
    service.get(gameId, enemyId, quarterId, memberId, countryId),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    service.get(gameId, observerId, quarterId, memberId, countryId),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    service.review(key, playerId, {
      requestId: randomUUID(),
      expectedRevision: formal.revision,
      target: 'Approved',
      reason: '自批',
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  await pg.query("UPDATE quarters SET state='Locked' WHERE id=$1", [quarterId]);
  expect((await service.mine(gameId, playerId, quarterId)).canEdit).toBe(false);
  await expect(save(formal, [section()])).rejects.toMatchObject({
    code: 'ACTION_SUBMISSION_LOCKED',
  });
  await pg.query(
    "UPDATE quarters SET state='ActionSubmission',action_deadline=NOW()-INTERVAL '1 hour' WHERE id=$1",
    [quarterId],
  );
  expect((await service.mine(gameId, playerId, quarterId)).canSubmit).toBe(
    false,
  );
});

it('aggregates legacy individual submissions automatically and preserves their IDs and history', async () => {
  const actions = new ActionService(pool);
  for (const category of ['Research', 'Diplomacy'] as const) {
    const a = await actions.create({
      gameId,
      userId: playerId,
      quarterId,
      title: category,
      originalText: `旧${category}`,
      category,
      secrecy: 'OwnerOnly',
      refs: [],
    });
    await actions.submit({
      gameId,
      userId: playerId,
      actionId: a.id,
      idempotencyKey: randomUUID(),
    });
  }
  const list = await service.list(gameId, hostId, quarterId);
  expect(list).toHaveLength(1);
  const grouped = await service.get(
    gameId,
    hostId,
    quarterId,
    memberId,
    countryId,
  );
  expect(grouped.sections).toHaveLength(2);
  expect(grouped.history.every((h) => !h.whole)).toBe(true);
  const ids = grouped.sections.map((s) => s.id);
  const approved = await review(grouped, 'Approved');
  expect(approved.sections.map((s) => s.id)).toEqual(ids);
  expect(approved.sections.every((s) => s.status === 'Approved')).toBe(true);
  expect(approved.history).toEqual(grouped.history);
});

it('keeps completed games read only, including the request ledger', async () => {
  const formal = await save(await service.mine(gameId, playerId, quarterId), [
    section(),
  ]);
  await pg.query("UPDATE games SET status='Completed' WHERE id=$1", [gameId]);
  expect((await service.mine(gameId, playerId, quarterId)).canEdit).toBe(false);
  await expect(review(formal, 'Approved')).rejects.toThrow();
  expect(
    (await pg.query('SELECT * FROM round_policy_requests')).rows,
  ).toHaveLength(1);
});

it('keeps separate authors separate even when they control the same country, and hides prior-country content', async () => {
  await save(await service.mine(gameId, playerId, quarterId), [section()]);
  await pg.query(
    'UPDATE game_members SET controlled_country_id=$1 WHERE user_id=$2',
    [countryId, enemyId],
  );
  const other = await service.mine(gameId, enemyId, quarterId);
  await service.save(gameId, enemyId, quarterId, {
    requestId: randomUUID(),
    expectedRevision: other.revision,
    sections: [section('另一位玩家')],
    submit: true,
  });
  const list = await service.list(gameId, hostId, quarterId);
  expect(list).toHaveLength(2);
  expect(new Set(list.map((p) => p.memberId)).size).toBe(2);
  expect(
    (await service.get(gameId, playerId, quarterId, other.memberId, countryId))
      .canEdit,
  ).toBe(false);
  await pg.query(
    'UPDATE game_members SET controlled_country_id=$1 WHERE user_id=$2',
    [otherCountryId, playerId],
  );
  await expect(
    service.get(gameId, playerId, quarterId, memberId, countryId),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect((await service.mine(gameId, playerId, quarterId)).sections).toEqual(
    [],
  );
});

it('does not reorder the last formal document or its history when only draft order changes', async () => {
  const sections = [section('第一项'), section('第二项'), section('第三项')];
  const formal = await save(
    await service.mine(gameId, playerId, quarterId),
    sections,
  );
  await save(formal, [...sections].reverse(), false);
  const host = await service.get(
    gameId,
    hostId,
    quarterId,
    memberId,
    countryId,
  );
  expect(host.sections.map((s) => s.text)).toEqual([
    '第一项',
    '第二项',
    '第三项',
  ]);
  expect(host.history[0]?.sections.map((s) => s.text)).toEqual([
    '第一项',
    '第二项',
    '第三项',
  ]);
});

it('serves the whole-document HTTP flow with authentication and request validation', async () => {
  const app = Fastify();
  await app.register(cookie);
  // Identity verification itself has dedicated tests; use synthetic sessions here.
  const auth = {
    authenticate: async (token?: string) => (token ? { id: token } : null),
  } as unknown as AuthService;
  await registerActionRoutes(app, auth, new ActionService(pool));
  app.setErrorHandler((error, _request, reply) =>
    reply.code(error instanceof ApiFault ? error.statusCode : 500).send({
      error: {
        message: error instanceof Error ? error.message : 'Request failed',
      },
    }),
  );
  const path = `/api/v1/games/${gameId}/quarters/${quarterId}`;
  const headers = { cookie: `srilanka_session=${playerId}` };
  try {
    expect(
      (await app.inject({ method: 'GET', url: `${path}/my-policy` }))
        .statusCode,
    ).toBe(401);
    const initial = await app.inject({
      method: 'GET',
      url: `${path}/my-policy`,
      headers,
    });
    expect(initial.statusCode).toBe(200);
    const payload = {
      requestId: randomUUID(),
      expectedRevision: initial.json().data.revision,
      submit: true,
      sections: [section('研究'), section('跨领域研究')],
    };
    const submitted = await app.inject({
      method: 'PUT',
      url: `${path}/my-policy`,
      headers,
      payload,
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().data.sections).toHaveLength(2);
    const list = await app.inject({
      method: 'GET',
      url: `${path}/policy-submissions`,
      headers: { cookie: `srilanka_session=${hostId}` },
    });
    expect(list.json().data).toHaveLength(1);
    const reviewed = await app.inject({
      method: 'POST',
      url: `${path}/policy-submissions/${memberId}/review?countryId=${countryId}`,
      headers: { cookie: `srilanka_session=${hostId}` },
      payload: {
        requestId: randomUUID(),
        expectedRevision: submitted.json().data.revision,
        target: 'Approved',
        reason: '统一批准',
      },
    });
    expect(reviewed.statusCode).toBe(200);
    expect(
      reviewed
        .json()
        .data.sections.every(
          (s: { status: string }) => s.status === 'Approved',
        ),
    ).toBe(true);
    const invalid = await app.inject({
      method: 'PUT',
      url: `${path}/my-policy`,
      headers,
      payload: {
        ...payload,
        sections: [{ ...payload.sections[0], category: 'unsupported' }],
      },
    });
    expect(invalid.statusCode).toBe(400);
  } finally {
    await app.close();
  }
});
