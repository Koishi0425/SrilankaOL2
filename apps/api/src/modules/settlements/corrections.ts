import { isDeepStrictEqual } from 'node:util';
import type {
  CorrectSettlementInput,
  SettlementAction,
  SettlementCorrection,
  SettlementCorrectionOptions,
} from '@srilanka/contracts';
import type { DatabaseClient, DatabasePool } from '@srilanka/database';
import { ApiFault } from '../../errors.js';
import {
  mapTransaction,
  recordMapChange,
  requireMapHost,
} from '../world/map-mutations.js';
import { insertResourceLedger, validBalance } from './resources.js';

type Queryable = DatabaseClient | DatabasePool;
type Published = { publicReport: string; actions: SettlementAction[] };

export async function readCorrections(
  db: Queryable,
  gameId: string,
  quarterId: string,
): Promise<SettlementCorrection[]> {
  const rows = await db.query<SettlementCorrection>(
    `SELECT c.id,c.sequence_number AS "sequenceNumber",c.reason,c.data AS change,
      u.display_name AS "actorName",c.created_at::text AS "createdAt",
      jsonb_build_object('id',q.id,'gameYear',q.game_year,'season',q.season) AS "appliedQuarter"
     FROM settlement_corrections c JOIN users u ON u.id=c.actor_user_id
     JOIN quarters q ON q.game_id=c.game_id AND q.id=c.applied_quarter_id
     WHERE c.game_id=$1 AND c.quarter_id=$2 ORDER BY c.sequence_number`,
    [gameId, quarterId],
  );
  return rows.rows.map((row) => ({
    ...row,
    createdAt: new Date(row.createdAt).toISOString(),
  }));
}

export function correctedText(
  published: Published,
  corrections: SettlementCorrection[],
): Published {
  let publicReport = published.publicReport;
  const actions = published.actions.map((action) => ({ ...action }));
  for (const { change } of corrections) {
    if (change.kind === 'PublicReport') publicReport = change.after;
    if (change.kind === 'ActionFeedback') {
      const action = actions.find(
        (action) => action.actionId === change.actionId,
      );
      if (action) action.feedback = change.after;
    }
  }
  return { publicReport, actions };
}

export class SettlementCorrectionService {
  constructor(private readonly database: DatabasePool) {}

  async options(
    gameId: string,
    userId: string,
    quarterId: string,
  ): Promise<SettlementCorrectionOptions> {
    return mapTransaction(this.database, async (db) => {
      await db.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      await requireMapHost(db, gameId, userId);
      await this.published(db, gameId, quarterId);
      const quarter = await this.current(db, gameId);
      const countries = await db.query<
        SettlementCorrectionOptions['countries'][number]
      >(
        `SELECT id,name,treasury::float8 AS treasury,manpower,resource_revision AS "resourceRevision" FROM countries WHERE game_id=$1 ORDER BY name,id`,
        [gameId],
      );
      const armies = await db.query<
        SettlementCorrectionOptions['armies'][number]
      >(
        `SELECT a.id,a.name,a.country_id AS "countryId",c.name AS "countryName",a.strength FROM armies a
         JOIN countries c ON c.game_id=a.game_id AND c.id=a.country_id WHERE a.game_id=$1 ORDER BY c.name,a.name,a.id`,
        [gameId],
      );
      const map = await db.query<{ asset_version: string }>(
        'SELECT asset_version FROM world_maps WHERE game_id=$1',
        [gameId],
      );
      const corrections = await readCorrections(db, gameId, quarterId);
      return {
        currentQuarter: quarter,
        correctionVersion: corrections.length,
        mapRevision: Number(map.rows[0]?.asset_version ?? 0),
        countries: countries.rows,
        armies: armies.rows,
      };
    });
  }

  private async current(db: Queryable, gameId: string, lock = false) {
    const rows = await db.query<SettlementCorrectionOptions['currentQuarter']>(
      `SELECT id,game_year AS "gameYear",season FROM quarters WHERE game_id=$1 AND is_current ${lock ? 'FOR UPDATE' : ''}`,
      [gameId],
    );
    if (!rows.rows[0])
      throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到当前回合。');
    return rows.rows[0];
  }

  private async published(db: Queryable, gameId: string, quarterId: string) {
    const rows = await db.query<{ published_snapshot: Published | null }>(
      'SELECT published_snapshot FROM quarter_settlements WHERE game_id=$1 AND quarter_id=$2',
      [gameId, quarterId],
    );
    if (!rows.rows[0]?.published_snapshot)
      throw new ApiFault(
        409,
        'SETTLEMENT_NOT_PUBLISHED',
        '只能更正已发布的结算。',
      );
    return rows.rows[0].published_snapshot;
  }

  async correct(
    gameId: string,
    userId: string,
    quarterId: string,
    input: CorrectSettlementInput,
  ) {
    await mapTransaction(this.database, async (db) => {
      await requireMapHost(db, gameId, userId);
      // Same lock order as publication: current quarter → map → game → country.
      const current = await this.current(db, gameId, true);
      await db.query('SELECT id FROM world_maps WHERE game_id=$1 FOR UPDATE', [
        gameId,
      ]);
      await db.query('SELECT id FROM games WHERE id=$1 FOR UPDATE', [gameId]);
      await db.query('SELECT require_writable_game($1)', [gameId]);
      const duplicate = await db.query<{
        game_id: string;
        quarter_id: string;
        request: CorrectSettlementInput;
      }>(
        'SELECT game_id,quarter_id,request FROM settlement_corrections WHERE id=$1',
        [input.id],
      );
      if (duplicate.rows[0]) {
        if (
          duplicate.rows[0].game_id !== gameId ||
          duplicate.rows[0].quarter_id !== quarterId ||
          !isDeepStrictEqual(duplicate.rows[0].request, input)
        )
          throw new ApiFault(
            409,
            'CORRECTION_ID_CONFLICT',
            '该更正标识已用于其他内容，请刷新后重新填写。',
          );
        return;
      }
      const original = await this.published(db, gameId, quarterId);
      const previous = await readCorrections(db, gameId, quarterId);
      if (
        current.id !== input.expectedCurrentQuarterId ||
        previous.length !== input.expectedCorrectionVersion
      )
        throw new ApiFault(
          409,
          'CORRECTION_VERSION_CONFLICT',
          '回合或更正记录已变化，请刷新并重新核对。',
        );
      if (!input.reason.trim() || input.reason.length > 2000)
        throw new ApiFault(400, 'INVALID_CORRECTION', '请填写更正原因。');
      const effective = correctedText(original, previous),
        change = input.change;
      let record: SettlementCorrection['change'];
      let countryId: string | null = null;
      if (change.kind === 'PublicReport') {
        if (change.text === effective.publicReport)
          throw new ApiFault(400, 'INVALID_CORRECTION', '公报内容没有变化。');
        record = {
          kind: change.kind,
          before: effective.publicReport,
          after: change.text,
        };
      } else if (change.kind === 'ActionFeedback') {
        const action = effective.actions.find(
          (action) => action.actionId === change.actionId,
        );
        if (!action || !change.text.trim() || change.text === action.feedback)
          throw new ApiFault(
            400,
            'INVALID_CORRECTION',
            '请选择本回合的政策，并填写有变化的反馈。',
          );
        countryId = action.countryId;
        record = {
          kind: change.kind,
          actionId: action.actionId,
          title: action.title,
          countryId,
          before: action.feedback,
          after: change.text,
        };
      } else if (change.kind === 'Resource') {
        const rows = await db.query<{
          id: string;
          name: string;
          treasury: string;
          manpower: number;
          resource_revision: number;
        }>(
          'SELECT id,name,treasury,manpower,resource_revision FROM countries WHERE game_id=$1 AND id=$2 FOR UPDATE',
          [gameId, change.countryId],
        );
        const country = rows.rows[0];
        if (!country)
          throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该国家。');
        if (country.resource_revision !== change.expectedResourceRevision)
          throw new ApiFault(
            409,
            'RESOURCE_VERSION_CONFLICT',
            '国家余额已变化，请刷新后重新核对。',
          );
        const before =
          change.resource === 'Treasury'
            ? Number(country.treasury)
            : country.manpower;
        const scale = change.resource === 'Treasury' ? 100 : 1;
        const after =
          (Math.round(before * scale) + Math.round(change.amount * scale)) /
          scale;
        if (
          !change.amount ||
          !Number.isFinite(change.amount) ||
          (change.resource === 'Treasury'
            ? !validBalance('Treasury', change.amount)
            : !Number.isInteger(change.amount) ||
              Math.abs(change.amount) > 2147483647) ||
          !validBalance(change.resource, after)
        )
          throw new ApiFault(
            400,
            'INVALID_CORRECTION',
            '补正数值超出范围；国库最多两位小数，人力为非负整数。',
          );
        countryId = country.id;
        record = {
          kind: change.kind,
          countryId,
          countryName: country.name,
          resource: change.resource,
          amount: change.amount,
          before,
          after,
        };
        await insertResourceLedger(
          db,
          { gameId, quarterId: current.id, userId, kind: 'Correction' },
          {
            id: input.id,
            countryId,
            resource: change.resource,
            amount: change.amount,
            before,
            after,
            reason: input.reason.trim(),
          },
        );
        await db.query(
          `UPDATE countries SET ${change.resource === 'Treasury' ? 'treasury' : 'manpower'}=$3,resource_revision=resource_revision+1 WHERE game_id=$1 AND id=$2`,
          [gameId, countryId, after],
        );
        await db.query(
          'UPDATE games SET current_world_version=current_world_version+1 WHERE id=$1',
          [gameId],
        );
      } else {
        const map = await db.query<{ asset_version: string }>(
          'SELECT asset_version FROM world_maps WHERE game_id=$1',
          [gameId],
        );
        const army = await db.query<{
          id: string;
          name: string;
          country_id: string;
          country_name: string;
          strength: number;
          tile_id: string;
        }>(
          `SELECT a.*,c.name AS country_name FROM armies a JOIN countries c ON c.game_id=a.game_id AND c.id=a.country_id WHERE a.game_id=$1 AND a.id=$2 FOR UPDATE OF a`,
          [gameId, change.armyId],
        );
        const row = army.rows[0];
        if (!row) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该军队。');
        if (
          Number(map.rows[0]?.asset_version) !== change.expectedMapRevision ||
          row.strength !== change.expectedStrength
        )
          throw new ApiFault(
            409,
            'MAP_VERSION_CONFLICT',
            '军队或地图已变化，请刷新后重新核对。',
          );
        if (
          !Number.isInteger(change.strength) ||
          change.strength < 0 ||
          change.strength > 2147483647 ||
          change.strength === row.strength
        )
          throw new ApiFault(
            400,
            'INVALID_CORRECTION',
            '请填写有变化的有效兵力。',
          );
        countryId = row.country_id;
        record = {
          kind: change.kind,
          countryId,
          countryName: row.country_name,
          armyId: row.id,
          armyName: row.name,
          before: row.strength,
          after: change.strength,
        };
        await db.query(
          'UPDATE armies SET strength=$3 WHERE game_id=$1 AND id=$2',
          [gameId, row.id, change.strength],
        );
        const game = await db.query<{ current_world_version: string }>(
          'SELECT current_world_version FROM games WHERE id=$1',
          [gameId],
        );
        await recordMapChange(db, {
          gameId,
          userId,
          kind: 'Correction',
          truth: true,
          worldVersion: Number(game.rows[0]!.current_world_version),
          tileIds: [row.tile_id],
          countryId,
          note: input.reason.trim(),
          details: {
            correctionId: input.id,
            sourceQuarterId: quarterId,
            ...record,
          },
        });
      }
      await db.query(
        `INSERT INTO settlement_corrections (id,game_id,quarter_id,applied_quarter_id,sequence_number,kind,country_id,reason,data,request,actor_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
        [
          input.id,
          gameId,
          quarterId,
          current.id,
          previous.length + 1,
          change.kind,
          countryId,
          input.reason.trim(),
          JSON.stringify(record),
          JSON.stringify(input),
          userId,
        ],
      );
    });
  }
}
