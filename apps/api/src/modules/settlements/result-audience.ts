import type {
  GameRole,
  SaveSettlementInput,
  SettlementAction,
  SettlementResultAudience,
} from '@srilanka/contracts';
import type { DatabaseClient } from '@srilanka/database';
import { ApiFault } from '../../errors.js';

export function canReadResult(
  action: SettlementAction,
  role: GameRole,
  countryId: string | null,
) {
  const audience = action.resultAudience ?? { kind: 'OwnerOnly' };
  if (audience.kind === 'Public') return true;
  if (role !== 'Player' || !countryId) return false;
  if (audience.kind === 'OwnerOnly') return action.countryId === countryId;
  return (
    audience.kind === 'Countries' && audience.countryIds.includes(countryId)
  );
}

export function projectResult(
  action: SettlementAction,
  role: GameRole,
  countryId: string | null,
): SettlementAction {
  const { resultAudience: _audience, ...result } = action;
  const own = role === 'Player' && action.countryId === countryId;
  return {
    ...result,
    canViewPolicy: own,
    ...(own
      ? {}
      : {
          title: '政策结算结果',
          submittedText: '',
          reviewReason: '',
          refs: [],
        }),
  };
}

export async function prepareResultAudiences(
  db: DatabaseClient,
  gameId: string,
  results: SaveSettlementInput['results'],
  previous: SaveSettlementInput['results'],
) {
  const countries = new Set(
    (
      await db.query<{ id: string }>(
        'SELECT id FROM countries WHERE game_id=$1',
        [gameId],
      )
    ).rows.map((c) => c.id),
  );
  const saved = new Map(previous.map((r) => [r.actionId, r.resultAudience]));
  return results.map((result) => {
    const audience: SettlementResultAudience = result.resultAudience ??
      saved.get(result.actionId) ?? { kind: 'OwnerOnly' };
    if (
      !['OwnerOnly', 'Public', 'HostOnly', 'Countries'].includes(
        audience.kind,
      ) ||
      (audience.kind === 'Countries' &&
        (!Array.isArray(audience.countryIds) ||
          !audience.countryIds.length ||
          audience.countryIds.some((id) => !countries.has(id)) ||
          new Set(audience.countryIds).size !== audience.countryIds.length))
    )
      throw new ApiFault(
        400,
        'INVALID_RESULT_AUDIENCE',
        '请选择本局内有效且不重复的可见国家。',
      );
    return {
      ...result,
      resultAudience:
        audience.kind === 'Countries'
          ? { kind: 'Countries' as const, countryIds: [...audience.countryIds] }
          : { kind: audience.kind },
    };
  });
}
