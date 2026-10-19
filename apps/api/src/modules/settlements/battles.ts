import { randomInt, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { toStateChangeInput } from '@srilanka/contracts';
import type {
  BattleRoll,
  BattleRollInput,
  SettlementBattle,
  SettlementBattleInput,
  SettlementStateChangeInput,
} from '@srilanka/contracts';
import type { DatabaseClient } from '@srilanka/database';
import { ApiFault } from '../../errors.js';
import { lockMap } from '../world/map-mutations.js';
import {
  prepareStateChanges,
  stateOptions,
  type StoredStateChange,
} from './state-changes.js';

export interface StoredBattle {
  battle: Omit<SettlementBattle, 'rolls'>;
  effects: StoredStateChange[];
  battlefield: Record<string, unknown>;
}
function invalid(message: string) {
  return new ApiFault(400, 'INVALID_BATTLE', message);
}
export function battleInput(
  battle: SettlementBattleInput,
): SettlementBattleInput {
  const {
    id,
    actionId,
    title,
    kind,
    tileId,
    attackers,
    defenders,
    resolution,
  } = battle;
  return {
    id,
    actionId,
    title,
    kind,
    tileId,
    attackers,
    defenders,
    resolution,
  };
}
function context(battle: SettlementBattleInput) {
  const { resolution: _resolution, ...fields } = battleInput(battle);
  void _resolution;
  return fields;
}
export async function readBattles(
  db: DatabaseClient,
  gameId: string,
  quarterId: string,
  stored: StoredBattle[],
): Promise<SettlementBattle[]> {
  const rows = await db.query<{ battle_id: string; result: BattleRoll }>(
    'SELECT battle_id,result FROM settlement_battle_rolls WHERE game_id=$1 AND quarter_id=$2 ORDER BY sequence_number',
    [gameId, quarterId],
  );
  return stored.map(({ battle }) => ({
    ...battle,
    rolls: rows.rows
      .filter((row) => row.battle_id === battle.id)
      .map((row) => row.result),
  }));
}
export async function prepareBattles(
  db: DatabaseClient,
  gameId: string,
  quarterId: string,
  inputs: SettlementBattleInput[],
  previous: StoredBattle[],
  approved: Set<string>,
  expectedRevision?: number,
) {
  if (!inputs.length) return [];
  const existing = new Map(previous.map((item) => [item.battle.id, item]));
  const modified = inputs.some(
    (input) =>
      !isDeepStrictEqual(
        battleInput(existing.get(input.id)?.battle ?? input),
        input,
      ) || !existing.has(input.id),
  );
  if (modified && expectedRevision === undefined)
    throw new ApiFault(
      409,
      'MAP_VERSION_CONFLICT',
      '请先读取当前地图，再保存战斗。',
    );
  await lockMap(db, gameId, modified ? expectedRevision : undefined);
  const options = await stateOptions(db, gameId);
  const ids = new Set<string>(),
    usedArmies = new Set<string>();
  const stored: StoredBattle[] = [];
  for (const input of inputs) {
    if (ids.has(input.id)) throw invalid('战斗标识重复。');
    ids.add(input.id);
    if (input.actionId && !approved.has(input.actionId))
      throw invalid('战斗只能关联本回合已批准的政策。');
    const old = existing.get(input.id);
    if (old && !isDeepStrictEqual(context(old.battle), context(input)))
      throw invalid(
        '参战信息已保存；更换战场或参战军队时，请移除后重新添加战斗。',
      );
    if (!old) {
      const retired = await db.query(
        'SELECT 1 FROM settlement_battle_rolls WHERE game_id=$1 AND quarter_id=$2 AND battle_id=$3 LIMIT 1',
        [gameId, quarterId, input.id],
      );
      if (retired.rows.length)
        throw invalid('已移除的战斗标识不能复用，请新建战斗。');
    }
    const tile = options.tiles.find((item) => item.id === input.tileId);
    if (!tile || !tile.passable)
      throw invalid('战场必须是当前地图的可通行地块。');
    if (!input.attackers.length || !input.defenders.length)
      throw invalid('请指定双方参战军队。');
    const participants: SettlementBattle['participants'] = [];
    for (const participant of [...input.attackers, ...input.defenders]) {
      if (usedArmies.has(participant.armyId))
        throw invalid(
          '同一军队本回合只能参与一场战斗，请合并战斗或分回合处理。',
        );
      usedArmies.add(participant.armyId);
      const army = options.armies.find(
        (item) => item.id === participant.armyId,
      );
      if (
        !army ||
        !Number.isInteger(participant.committedStrength) ||
        participant.committedStrength < 1 ||
        participant.committedStrength > army.strength
      )
        throw invalid('参战人数必须是正整数，且不能超过该军队当前兵力。');
      const saved = old?.battle.participants.find(
        (item) => item.armyId === army.id,
      );
      if (
        saved &&
        (saved.originalStrength !== army.strength ||
          saved.originalTileId !== army.tileId ||
          saved.countryId !== army.countryId)
      )
        throw new ApiFault(
          409,
          'BATTLE_STATE_CONFLICT',
          `“${input.title}”的参战军队状态已变化，请移除战斗、重读状态后重新添加。`,
          { battleId: input.id },
        );
      participants.push({
        ...participant,
        name: army.name,
        countryId: army.countryId,
        countryName: army.countryName,
        originalStrength: army.strength,
        originalTileId: army.tileId,
        q: army.q,
        r: army.r,
      });
    }
    const battlefield = (
      await db.query<Record<string, unknown>>(
        `SELECT t.controller_country_id,t.legal_owner_country_id,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'controllerCountryId',c.controller_country_id) ORDER BY c.id) FROM cities c WHERE c.game_id=t.game_id AND c.tile_id=t.id),'[]'::jsonb) AS cities
       FROM hex_tiles t WHERE t.game_id=$1 AND t.id=$2`,
        [gameId, tile.id],
      )
    ).rows[0]!;
    if (old && !isDeepStrictEqual(old.battlefield, battlefield))
      throw new ApiFault(
        409,
        'BATTLE_STATE_CONFLICT',
        `“${input.title}”的战场归属已变化，请移除战斗、重读状态后重新添加。`,
        { battleId: input.id },
      );
    const changes: SettlementStateChangeInput[] = [];
    const effectId = (kind: string, targetId: string) =>
      old?.effects.find(
        ({ change }) =>
          change.kind === kind &&
          (change.kind === 'Territory'
            ? change.tileIds[0] === targetId
            : 'armyId' in change && change.armyId === targetId),
      )?.change.id ?? randomUUID();
    if (input.resolution) {
      const resolution = input.resolution;
      if (!resolution.narrative.trim()) throw invalid('请填写战斗裁决说明。');
      const resultIds = new Set(resolution.armies.map((item) => item.armyId));
      if (
        resultIds.size !== participants.length ||
        resolution.armies.length !== participants.length ||
        participants.some((item) => !resultIds.has(item.armyId))
      )
        throw invalid('裁决必须包含每支参战军队，且不能重复或加入其他军队。');
      for (const result of resolution.armies) {
        const participant = participants.find(
          (item) => item.armyId === result.armyId,
        )!;
        if (
          !Number.isInteger(result.casualties) ||
          result.casualties < 0 ||
          result.casualties > participant.committedStrength
        )
          throw invalid('伤亡必须为非负整数，且不能超过参战人数。');
        if (result.casualties)
          changes.push({
            id: effectId('ArmyStrength', result.armyId),
            actionId: input.actionId,
            kind: 'ArmyStrength',
            armyId: result.armyId,
            strength: participant.originalStrength - result.casualties,
          });
        if (
          result.destinationTileId &&
          result.destinationTileId !== participant.originalTileId
        )
          changes.push({
            id: effectId('ArmyMove', result.armyId),
            actionId: input.actionId,
            kind: 'ArmyMove',
            armyId: result.armyId,
            destinationTileId: result.destinationTileId,
          });
        else if (
          result.destinationTileId &&
          !options.tiles.some((item) => item.id === result.destinationTileId)
        )
          throw invalid('战后位置不属于当前地图。');
      }
      if (resolution.occupyCountryId) {
        const allowedSide =
          resolution.outcome === 'AttackerVictory'
            ? input.attackers
            : resolution.outcome === 'DefenderVictory'
              ? input.defenders
              : [];
        if (
          !allowedSide.some(
            (item) =>
              participants.find((p) => p.armyId === item.armyId)?.countryId ===
              resolution.occupyCountryId,
          )
        )
          throw invalid('占领国必须属于获胜一方；平局或未分胜负时保持控制权。');
        changes.push({
          id: effectId('Territory', tile.id),
          actionId: input.actionId,
          kind: 'Territory',
          tileIds: [tile.id],
          controllerCountryId: resolution.occupyCountryId,
        });
      }
    }
    const effects = await prepareStateChanges(
      db,
      gameId,
      changes,
      old?.effects ?? [],
      approved,
      expectedRevision,
    );
    stored.push({
      battle: {
        ...input,
        q: tile.q,
        r: tile.r,
        participants,
        effects: effects.map((item) => item.change),
      },
      effects,
      battlefield,
    });
  }
  return stored;
}
export async function validateCombinedEffects(
  db: DatabaseClient,
  gameId: string,
  changes: StoredStateChange[],
  battles: StoredBattle[],
  approved: Set<string>,
) {
  const combined = [...changes, ...battles.flatMap((item) => item.effects)];
  await prepareStateChanges(
    db,
    gameId,
    combined.map((item) => toStateChangeInput(item.change)),
    combined,
    approved,
  );
  return combined;
}
export async function rollBattle(
  db: DatabaseClient,
  gameId: string,
  quarterId: string,
  userId: string,
  battle: StoredBattle,
  input: BattleRollInput,
) {
  if (battle.battle.resolution)
    throw invalid('该战斗已有裁决；需要继续掷骰时请先清除裁决并保存。');
  if (input.phase === 'Siege' && battle.battle.kind !== 'Siege')
    throw invalid('野战不能使用围城阶段。');
  if (
    input.phase !== 'Custom' &&
    (input.count !== 1 ||
      input.sides !== (input.phase === 'Siege' ? 14 : 10) ||
      input.zeroBased !== (input.phase !== 'Siege'))
  )
    throw invalid('火力与冲击使用 0—9 单骰；围城使用 1—14 单骰。');
  if (input.phase === 'Siege' && input.defenderModifier !== 0)
    throw invalid('围城阶段仅掷进攻方骰子。');
  if (
    (input.attackerModifier || input.defenderModifier) &&
    !input.modifierNote.trim()
  )
    throw invalid('请说明修正值的依据。');
  const count = Number(
    (
      await db.query<{ count: string }>(
        'SELECT count(*) AS count FROM settlement_battle_rolls WHERE game_id=$1 AND quarter_id=$2 AND battle_id=$3',
        [gameId, quarterId, battle.battle.id],
      )
    ).rows[0]!.count,
  );
  if (count >= 100) throw invalid('每场战斗最多记录 100 次掷骰。');
  const dice = () =>
    Array.from({ length: input.count }, () =>
      randomInt(
        input.zeroBased ? 0 : 1,
        input.sides + (input.zeroBased ? 0 : 1),
      ),
    );
  const attackerDice = dice(),
    defenderDice = input.phase === 'Siege' ? [] : dice();
  const {
    expectedVersion: _version,
    expectedMapRevision: _revision,
    idempotencyKey,
    ...request
  } = input;
  void _version;
  void _revision;
  const result: BattleRoll = {
    ...request,
    id: idempotencyKey,
    sequence: count + 1,
    createdAt: new Date().toISOString(),
    attackerDice,
    defenderDice,
    attackerTotal: attackerDice.reduce(
      (sum, value) => sum + value,
      input.attackerModifier,
    ),
    defenderTotal: defenderDice.length
      ? defenderDice.reduce((sum, value) => sum + value, input.defenderModifier)
      : null,
  };
  await db.query(
    'INSERT INTO settlement_battle_rolls (game_id,quarter_id,battle_id,idempotency_key,sequence_number,request,result,actor_user_id) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)',
    [
      gameId,
      quarterId,
      battle.battle.id,
      idempotencyKey,
      result.sequence,
      JSON.stringify(request),
      JSON.stringify(result),
      userId,
    ],
  );
}
