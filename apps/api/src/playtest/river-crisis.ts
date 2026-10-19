import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { nationalPolicyStatus, treatyStatus } from '@srilanka/contracts';
import type {
  ActionCategory,
  ActionObjectRef,
  SaveSettlementInput,
} from '@srilanka/contracts';
import type { DatabasePool } from '@srilanka/database';
import { AuthService } from '../modules/auth/auth-service.js';
import { GameService } from '../modules/games/game-service.js';
import { WorldService } from '../modules/world/world-service.js';
import { ActionService } from '../modules/actions/action-service.js';
import { CommunicationService } from '../modules/communications/communication-service.js';
import { SettlementService } from '../modules/settlements/settlement-service.js';
import { economicBillInput } from '../modules/settlements/economy.js';

export interface RiverCrisisReport {
  gameId: string;
  firstQuarterId: string;
  currentQuarterId: string;
  accounts: { username: string; role: string }[];
  checks: string[];
  riverProduction: { firstQuarter: number; secondQuarter: number };
  occupation: { tileId: string; q: number; r: number };
}

/** Replays a host-led round in an empty, isolated database without bypassing game services. */
export async function runRiverCrisis(
  database: DatabasePool,
  password: string,
): Promise<RiverCrisisReport> {
  const existing = (
    await database.query<{ report: RiverCrisisReport }>(
      "SELECT config->'riverCrisisReport' AS report FROM games WHERE config ? 'riverCrisisReport' LIMIT 1",
    )
  ).rows[0];
  if (existing) return existing.report;
  assert.equal(
    (await database.query('SELECT id FROM games LIMIT 1')).rowCount,
    0,
    '试局需要空数据库，已有游戏不会被覆盖。',
  );
  assert(
    password.length >= 8,
    '请通过 PLAYTEST_PASSWORD 设置至少 8 位的本地演示口令。',
  );
  const auth = new AuthService(database),
    games = new GameService(database),
    world = new WorldService(database),
    actions = new ActionService(database),
    communications = new CommunicationService(database),
    settlements = new SettlementService(database);
  const accounts = [
    { username: 'trial-host', role: '主持人', displayName: '试局主持人' },
    { username: 'trial-river', role: '河谷王国', displayName: '河谷玩家' },
    { username: 'trial-coast', role: '海岸公国', displayName: '海岸玩家' },
    { username: 'trial-observer', role: '观察者', displayName: '试局观察者' },
  ];
  const users = [];
  for (const account of accounts)
    users.push(
      await auth.createDevelopmentUser({
        username: account.username,
        displayName: account.displayName,
        password,
      }),
    );
  const [host, river, coast, observer] = users;
  assert(host && river && coast && observer);
  const game = await games.create({
    userId: host.id,
    name: '界河危机 · 试玩',
    countryNames: ['河谷王国', '海岸公国'],
  });
  const gameId = game.id,
    quarterId = game.currentQuarter.id;
  const countries = await games.listCountries(gameId, host.id);
  const riverCountry = countries.find((c) => c.name === '河谷王国')!,
    coastCountry = countries.find((c) => c.name === '海岸公国')!;
  const memberships = [];
  for (const [index, user] of users.slice(1).entries()) {
    const member = await games.addMember({
      gameId,
      actorUserId: host.id,
      username: user.username,
      role: index === 2 ? 'Observer' : 'Player',
    });
    if (index < 2)
      await games.assignCountry({
        gameId,
        actorUserId: host.id,
        memberId: member.id,
        countryId: index === 0 ? riverCountry.id : coastCountry.id,
      });
    memberships.push(member);
  }
  const rules = await games.getRules(gameId, host.id);
  const scenario = {
    title: '界河危机',
    playerPerspective: 'CountryWill' as const,
    premise:
      '春汛冲毁界河水渠。河谷王国要求修复旧水道，海岸公国担心贸易受损，边防军在旧渡口对峙。玩家扮演国家意志，也可以借君主、使节和地方行会展开故事。',
    commonRules:
      '一季一回合，全体提交后由主持人统一审核结算。每国建议提出一项内政、一项外交、一项军事行动，可按剧情自由发挥；建议额度不是硬性上限。重要信息通过关联政策讨论补充。金额与部队变化须由主持人确认后统一发布。占领只改变实际控制，割让才改变法理归属；行军纠纷、战果和故事均由主持人裁决。本剧本的战果是演练预设，不代表已经确定通用战斗规则。',
  };
  await games.updateRules({
    gameId,
    userId: host.id,
    quarterId,
    expectedVersion: rules.version,
    scenario,
    quarter: {
      briefing: '第一季：水渠、商路与边境争端。',
      actionGuidelines: '写明目标、做法、人员和预算；可以提出自定义行动。',
      suggestedLimits: [
        { category: 'Construction', limit: 1 },
        { category: 'Diplomacy', limit: 1 },
        { category: 'Military', limit: 1 },
      ],
    },
  });
  await world.setup.create(gameId, host.id, {
    name: '界河与南海',
    width: 12,
    height: 8,
  });
  const revision = async () => (await world.getMap(gameId, host.id)).revision!;
  const allTiles = (
    await world.getViewport({
      gameId,
      userId: host.id,
      minQ: 0,
      maxQ: 11,
      minR: 0,
      maxR: 7,
    })
  ).tiles;
  const tileAt = (q: number, r: number) => {
    const tile = allTiles.find((t) => t.q === q && t.r === r);
    assert(tile);
    return tile;
  };
  const edit = async (
    tileIds: string[],
    input: Omit<
      Parameters<typeof world.setup.batch>[2],
      'tileIds' | 'expectedRevision'
    >,
  ) =>
    world.setup.batch(gameId, host.id, {
      expectedRevision: await revision(),
      tileIds,
      ...input,
    });
  for (const [name, country, min, max] of [
    ['河谷省', riverCountry, 0, 4],
    ['界河省', coastCountry, 5, 6],
    ['滨海省', coastCountry, 7, 11],
  ] as const) {
    await edit(
      allTiles
        .filter((t) => t.r < 6 && t.q >= min && t.q <= max)
        .map((t) => t.id),
      {
        regionName: name,
        provinceName: name,
        legalOwnerCountryId: country.id,
        controllerCountryId: country.id,
      },
    );
  }
  const terrains = (await world.setup.get(gameId, host.id)).terrains;
  for (const [name, predicate] of [
    ['水域', (q: number, r: number) => r >= 6],
    ['丘陵', (q: number, r: number) => r < 2 && q >= 5],
    ['森林', (q: number, r: number) => r < 2 && q >= 1 && q <= 2],
    ['山地', (q: number, r: number) => r === 0 && q >= 9],
  ] as const)
    await edit(
      allTiles.filter((t) => predicate(t.q, t.r)).map((t) => t.id),
      { terrainTypeId: terrains.find((t) => t.name === name)!.id },
    );
  const provinceData = await world.provinces.list(gameId, host.id);
  for (const [name, tax, production, manpower, autonomy] of [
    ['河谷省', 8, 6, 5, 10],
    ['界河省', 3, 2, 2, 0],
    ['滨海省', 7, 5, 4, 5],
  ] as const) {
    const province = provinceData.provinces.find((p) => p.name === name)!;
    await world.provinces.set(gameId, host.id, province.id, {
      name,
      description:
        name === '河谷省' ? '沿河农田与水车工坊。' : '商路、渡口与沿海村镇。',
      taxBase: tax,
      productionBase: production,
      manpowerBase: manpower,
      autonomy,
      unrest: 0,
      expectedRevision: province.revision!,
      expectedMapRevision: await revision(),
      reason: '试局开场资料',
    });
  }
  const riverProvince = provinceData.provinces.find(
    (p) => p.name === '河谷省',
  )!;
  for (const country of countries)
    await settlements.countries.setBalances(gameId, host.id, country.id, {
      expectedRevision: 0,
      treasury: 1000,
      manpower: 5000,
      reason: '试局开场资源',
    });
  for (const [name, q, r, country] of [
    ['河畔城', 2, 3, riverCountry],
    ['海门港', 9, 3, coastCountry],
    ['界河堡', 6, 2, coastCountry],
  ] as const)
    await world.createCity({
      gameId,
      userId: host.id,
      tileId: tileAt(q, r).id,
      name,
      countryId: country.id,
    });
  await world.createArmy({
    gameId,
    userId: host.id,
    tileId: tileAt(4, 2).id,
    countryId: riverCountry.id,
    name: '河谷第一军',
    strength: 1200,
  });
  await world.createArmy({
    gameId,
    userId: host.id,
    tileId: tileAt(6, 2).id,
    countryId: coastCountry.id,
    name: '海岸守备军',
    strength: 900,
  });
  const armies = (
    await settlements.countries.status(gameId, host.id)
  ).countries.flatMap((c) => c.armies);
  const riverArmy = armies.find((a) => a.name === '河谷第一军')!,
    coastArmy = armies.find((a) => a.name === '海岸守备军')!;
  await games.economics.set(gameId, host.id, {
    expectedVersion: 0,
    rules: {
      enabled: true,
      taxCoefficient: 10,
      productionCoefficient: 10,
      manpowerCoefficient: 100,
      armyMaintenancePer100: 1,
      administrationCost: 5,
      tradeCoefficient: 3,
    },
    reason: '试局简化季度经济',
  });
  await games.trade.set(gameId, host.id, randomUUID(), {
    expectedRevision: null,
    expectedMapRevision: await revision(),
    name: '界河贸易区',
    provinceIds: provinceData.provinces.map((p) => p.id),
    influences: [
      { countryId: riverCountry.id, power: 6 },
      { countryId: coastCountry.id, power: 4 },
    ],
    reason: '试局共同商路',
  });
  await games.government.setup(
    gameId,
    host.id,
    countries.map((country) => ({
      id: randomUUID(),
      actionId: null,
      expectedRevision: 0,
      expectedQuarterSequence: 1,
      reason: '剧本政府',
      kind: 'Government',
      countryId: country.id,
      regime: country.id === riverCountry.id ? '王国' : '公国',
      authority: country.id === riverCountry.id ? '河谷议事会' : '海岸公爵',
      description: '地方议会与王室共同处理国家事务。',
    })),
  );
  const tradeTreatyId = randomUUID();
  await games.diplomacy.setup(gameId, host.id, [
    {
      id: randomUUID(),
      actionId: null,
      expectedRevision: 0,
      expectedQuarterSequence: 1,
      reason: '剧本开场关系',
      kind: 'Treaty',
      treatyId: tradeTreatyId,
      title: '界河通商约定',
      type: 'Trade',
      countryIds: [riverCountry.id, coastCountry.id],
      visibility: 'Public',
      terms: '两国商队正常往来，争端由使节交涉。',
      durationQuarters: null,
      grantorCountryId: null,
    },
  ]);
  for (const country of countries)
    await world.setup.initializeKnowledge(gameId, host.id, {
      expectedRevision: await revision(),
      countryId: country.id,
      mode: 'Geography',
    });
  for (const country of countries)
    await world.setup.knowledge(gameId, host.id, {
      expectedRevision: await revision(),
      countryId: country.id,
      tileIds: allTiles
        .filter((t) => t.q >= 4 && t.q <= 7 && t.r >= 2 && t.r <= 3)
        .map((t) => t.id),
      state: 'Observed',
      note: '边境使节与巡逻队的开场记录。',
      armyErrorPercent: 20,
    });
  await games.transitionCurrentQuarter({
    gameId,
    userId: host.id,
    state: 'ActionSubmission',
  });
  const ref = (
    objectType: ActionObjectRef['objectType'],
    objectId: string,
    label: string,
  ): Omit<ActionObjectRef, 'id'> => ({
    refKind: 'Target',
    objectType,
    objectId,
    label,
  });
  const policies = [];
  for (const [user, title, category, text, refs] of [
    [
      river,
      '修复河谷水渠',
      'Construction',
      '拨款 120，组织农户修复水渠，设立水利维护制度。',
      [ref('Province', riverProvince.id, '省份：河谷省')],
    ],
    [
      river,
      '界河争端与宣战',
      'Diplomacy',
      '要求海岸公国交出旧渡口，交涉失败则宣战并中止通商约定。',
      [ref('Country', coastCountry.id, coastCountry.name)],
    ],
    [
      river,
      '夺取界河北岸',
      'Military',
      '第一军向界河渡口推进，目标为 5,2；战果与损失交由主持人裁决。',
      [
        ref('Tile', tileAt(5, 2).id, '旧渡口（5,2）'),
        ref('Army', riverArmy.id, '河谷第一军'),
      ],
    ],
    [
      coast,
      '行会寻找旧水道',
      'Custom',
      '资助界河行会寻找不经旧渡口的水道，尝试与当地向导合作。',
      [ref('Tile', tileAt(6, 3).id, '界河行会驻地（6,3）')],
    ],
  ] as const) {
    const action = await actions.create({
      gameId,
      userId: user.id,
      quarterId,
      title,
      originalText: text,
      category: category as ActionCategory,
      secrecy: 'OwnerOnly',
      refs: [...refs],
    });
    await actions.submit({
      gameId,
      userId: user.id,
      actionId: action.id,
      idempotencyKey: randomUUID(),
    });
    policies.push(action);
  }
  const [build, diplomacy, military, custom] = policies;
  assert(build && diplomacy && military && custom);
  await games.transitionCurrentQuarter({
    gameId,
    userId: host.id,
    state: 'Locked',
  });
  await games.transitionCurrentQuarter({
    gameId,
    userId: host.id,
    state: 'HostReview',
  });
  await actions.hostTransition({
    gameId,
    userId: host.id,
    actionId: custom.id,
    target: 'NeedPlayerInput',
    reason: '请补充人员、预算，以及发生危险时是否撤回。',
  });
  const conversation = await communications.openPolicy(
    gameId,
    coast.id,
    custom.id,
  );
  await communications.send({
    gameId,
    userId: coast.id,
    conversationId: conversation.id,
    content: '派 5 名向导，预算 40，遇到武装冲突立即撤回。',
    clientMessageId: randomUUID(),
  });
  const pending = await actions.get(gameId, coast.id, custom.id);
  await actions.update({
    gameId,
    userId: coast.id,
    actionId: custom.id,
    expectedVersion: pending.version,
    title: custom.title,
    originalText: `${custom.currentText}\n投入 5 名向导和 40 预算，发生武装冲突立即撤回。`,
    category: 'Custom',
    secrecy: 'OwnerOnly',
    refs: pending.refs,
  });
  await actions.submit({
    gameId,
    userId: coast.id,
    actionId: custom.id,
    idempotencyKey: randomUUID(),
  });
  for (const action of policies)
    await actions.hostTransition({
      gameId,
      userId: host.id,
      actionId: action.id,
      target: 'Approved',
      reason: '试局裁决：方案可执行，具体收益和战果统一结算。',
    });
  await assert.rejects(
    communications.messages({
      gameId,
      userId: river.id,
      conversationId: conversation.id,
      limit: 20,
    }),
    { code: 'OBJECT_NOT_FOUND' },
  );
  const discussion = await communications.messages({
    gameId,
    userId: host.id,
    conversationId: conversation.id,
    limit: 20,
  });
  assert(discussion.items.some((m) => m.content.includes('预算')));
  await settlements.begin(gameId, host.id, quarterId);
  const draft = await settlements.get(gameId, host.id, quarterId);
  const economy = await settlements.economicPreview(
    gameId,
    host.id,
    quarterId,
    draft.version,
  );
  const firstProduction = economy.lines.find(
    (l) => l.countryId === riverCountry.id && l.kind === 'Production',
  )!.calculatedAmount;
  const balance = await settlements.countries.status(gameId, host.id);
  const input: SaveSettlementInput = {
    expectedVersion: draft.version,
    expectedMapRevision: await revision(),
    publicReport:
      '春汛后的水渠重新通水，界河争端却演变为战争。河谷军占据旧渡口，海岸守军退往海门。商队暂时停运，新的水道传闻开始流传。',
    results: [
      {
        actionId: build.id,
        feedback:
          '水渠修复，河谷省生产基础由 6 提升至 8。120 已列入国库支出。水利维护制度从下季起生效，持续两季。',
      },
      {
        actionId: diplomacy.id,
        feedback:
          '交涉失败，宣战与中止通商约定同时发布；其他协议和贸易影响力不会自动消失。',
      },
      {
        actionId: military.id,
        feedback:
          '试局预设战果：第一军占领旧渡口，损失 220 人；海岸守军损失 120 人并退至 7,2。此地法理仍属于海岸公国。',
      },
      {
        actionId: custom.id,
        feedback:
          '行会带回半张旧水道图。40 已列入支出；线索将开启下季的探索事件，暂未获得可直接通行的新航路。',
      },
    ],
    stateChanges: [
      {
        id: randomUUID(),
        actionId: build.id,
        kind: 'Province',
        provinceId: riverProvince.id,
        expectedProfileRevision: 1,
        values: { productionBase: 8 },
        reason: '修复水渠',
      },
      {
        id: randomUUID(),
        actionId: military.id,
        kind: 'ArmyMove',
        armyId: riverArmy.id,
        destinationTileId: tileAt(5, 2).id,
      },
      {
        id: randomUUID(),
        actionId: military.id,
        kind: 'ArmyStrength',
        armyId: riverArmy.id,
        strength: 980,
      },
      {
        id: randomUUID(),
        actionId: military.id,
        kind: 'ArmyMove',
        armyId: coastArmy.id,
        destinationTileId: tileAt(7, 2).id,
      },
      {
        id: randomUUID(),
        actionId: military.id,
        kind: 'ArmyStrength',
        armyId: coastArmy.id,
        strength: 780,
      },
      {
        id: randomUUID(),
        actionId: military.id,
        kind: 'Territory',
        tileIds: [tileAt(5, 2).id],
        controllerCountryId: riverCountry.id,
      },
    ],
    resourceChanges: [
      { country: riverCountry, action: build, amount: -120 },
      { country: coastCountry, action: custom, amount: -40 },
    ].map(({ country, action, amount }) => ({
      id: randomUUID(),
      actionId: action.id,
      countryId: country.id,
      expectedResourceRevision: balance.countries.find(
        (c) => c.id === country.id,
      )!.resourceRevision,
      resource: 'Treasury',
      amount,
      reason: action.title,
    })),
    diplomacyChanges: [
      {
        id: randomUUID(),
        actionId: diplomacy.id,
        expectedRevision: 1,
        expectedQuarterSequence: 1,
        reason: '界河交涉失败',
        kind: 'WarStatus',
        countryIds: [riverCountry.id, coastCountry.id],
        state: 'War',
      },
      {
        id: randomUUID(),
        actionId: diplomacy.id,
        expectedRevision: 1,
        expectedQuarterSequence: 1,
        reason: '战时中止通商',
        kind: 'EndTreaty',
        treatyId: tradeTreatyId,
      },
    ],
    governmentChanges: [
      {
        id: randomUUID(),
        actionId: build.id,
        expectedRevision: 1,
        expectedQuarterSequence: 1,
        reason: '建立水利维护制度',
        kind: 'Policy',
        policyId: randomUUID(),
        countryId: riverCountry.id,
        title: '水利维护制度',
        type: 'Reform',
        text: '地方负责持续维护水渠，生产收入提高 10%，持续两季。',
        effects: { Production: 10 },
        durationQuarters: 2,
      },
    ],
    economicBill: economicBillInput(economy),
  };
  const saved = await settlements.save(gameId, host.id, quarterId, input);
  assert.equal(
    (await world.getTileContext(gameId, river.id, tileAt(2, 3).id)).province
      ?.values?.productionBase,
    6,
  );
  assert.equal(
    (await world.getTile(gameId, host.id, tileAt(5, 2).id)).controllerCountryId,
    coastCountry.id,
  );
  await settlements.publish(
    gameId,
    host.id,
    quarterId,
    saved.version,
    saved.mapRevision,
  );
  const result = await settlements.get(gameId, river.id, quarterId);
  assert.equal(result.actions.length, 3);
  assert.equal(
    (await settlements.get(gameId, coast.id, quarterId)).actions.length,
    1,
  );
  assert.equal(
    (await settlements.get(gameId, observer.id, quarterId)).actions.length,
    0,
  );
  assert.equal(result.stateChanges, undefined);
  const occupied = await world.getTile(gameId, host.id, tileAt(5, 2).id);
  assert.equal(occupied.legalOwnerCountryId, coastCountry.id);
  assert.equal(occupied.controllerCountryId, riverCountry.id);
  const observedOccupation = await world.getTile(gameId, river.id, occupied.id);
  assert.equal(observedOccupation.controllerCountryId, riverCountry.id);
  assert.equal(observedOccupation.legalOwnerCountryId, coastCountry.id);
  assert.deepEqual(
    await world.getTileContext(
      gameId,
      host.id,
      occupied.id,
      memberships[0]!.id,
    ),
    await world.getTileContext(gameId, river.id, occupied.id),
  );
  const dipl = await games.diplomacy.get(gameId, river.id);
  assert.equal(dipl.relations[0]?.state, 'War');
  assert.equal(
    treatyStatus(
      dipl.treaties.find((t) => t.id === tradeTreatyId)!,
      1,
    ),
    'Ended',
  );
  const next = await settlements.advance(gameId, host.id, quarterId);
  const nextRules = await games.getRules(gameId, host.id);
  await games.updateRules({
    gameId,
    userId: host.id,
    quarterId: next.id,
    expectedVersion: nextRules.version,
    scenario,
    quarter: {
      ...nextRules.quarter,
      briefing:
        '第二季：旧渡口已被占领。决定继续战争、恢复贸易或追查旧水道图。第一季的结果可在回合结果中切换查看。',
    },
  });
  await games.transitionCurrentQuarter({
    gameId,
    userId: host.id,
    state: 'ActionSubmission',
  });
  const context = await world.getTileContext(gameId, river.id, tileAt(2, 3).id);
  assert.equal(context.province?.values?.productionBase, 8);
  assert.equal(context.economy?.production, 79.2);
  const government = await games.government.get(gameId, river.id);
  assert.equal(nationalPolicyStatus(government.policies[0]!, 2), 'Active');
  await assert.rejects(
    games.government.get(gameId, coast.id, riverCountry.id),
    { code: 'COUNTRY_PERMISSION_REQUIRED' },
  );
  const report: RiverCrisisReport = {
    gameId,
    firstQuarterId: quarterId,
    currentQuarterId: next.id,
    accounts: accounts.map(({ username, role }) => ({ username, role })),
    riverProduction: {
      firstQuarter: firstProduction,
      secondQuarter: context.economy!.production,
    },
    occupation: { tileId: occupied.id, q: occupied.q, r: occupied.r },
    checks: [
      '两国政策提交与正式版本',
      '主持人要求补充及关联私聊权限',
      '发布前世界状态保持不变',
      '建设费用与省份发展统一发布',
      '宣战与通商条约终止',
      '军队损失、退守与保留法理归属的占领',
      '本国反馈与观察者隔离',
      '主持人玩家预览与实际玩家一致',
      '下一季度生产估算 54 → 79.2、长期改革生效',
    ],
  };
  await database.query(
    "UPDATE games SET config=jsonb_set(config,'{riverCrisisReport}',$2::jsonb) WHERE id=$1",
    [gameId, JSON.stringify(report)],
  );
  return report;
}
