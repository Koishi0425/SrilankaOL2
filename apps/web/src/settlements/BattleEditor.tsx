import { useEffect, useRef, useState } from 'react';
import type {
  BattleParticipantInput,
  BattleResolution,
  BattleRollInput,
  SettlementBattle,
  SettlementBattleInput,
  SettlementStateOptions,
} from '@srilanka/contracts';
import { ApiRequestError, fetchSettlementStateOptions } from '../api.js';

export const outcomeNames = {
  AttackerVictory: '进攻方获胜',
  DefenderVictory: '防守方获胜',
  Draw: '平局',
  Inconclusive: '未分胜负',
};
const phaseNames = {
  Fire: '火力',
  Shock: '冲击',
  Siege: '围城',
  Custom: '自定',
};
export function toBattleInput(battle: SettlementBattle): SettlementBattleInput {
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
export function BattleRecord({ battle }: { battle: SettlementBattle }) {
  return (
    <div className="battle-record">
      <p>
        {battle.kind === 'Field' ? '野战' : '攻城'} · 战场 ({battle.q},{' '}
        {battle.r}) ·{' '}
        {battle.resolution ? outcomeNames[battle.resolution.outcome] : '待裁决'}
      </p>
      {(['attackers', 'defenders'] as const).map((side) => (
        <p key={side}>
          {side === 'attackers' ? '进攻方' : '防守方'}：
          {battle[side]
            .map((item) => {
              const participant = battle.participants.find(
                (p) => p.armyId === item.armyId,
              );
              const result = battle.resolution?.armies.find(
                (p) => p.armyId === item.armyId,
              );
              return `${participant?.countryName ?? ''} ${participant?.name ?? ''} ${item.committedStrength} 人${result ? `，伤亡 ${result.casualties}` : ''}`;
            })
            .join('；')}
        </p>
      ))}
      {!!battle.rolls.length && (
        <ol className="battle-rolls">
          {battle.rolls.map((roll) => (
            <li key={roll.id}>
              {phaseNames[roll.phase]}（
              {roll.count > 1 ? `${roll.count} × ` : ''}
              {roll.zeroBased ? `0—${roll.sides - 1}` : `1—${roll.sides}`}） ·
              进攻 {roll.attackerDice.join(' + ')}{' '}
              {roll.attackerModifier >= 0 ? '+' : '−'}{' '}
              {Math.abs(roll.attackerModifier)} = {roll.attackerTotal}
              {roll.defenderTotal !== null &&
                `；防守 ${roll.defenderDice.join(' + ')} ${roll.defenderModifier >= 0 ? '+' : '−'} ${Math.abs(roll.defenderModifier)} = ${roll.defenderTotal}`}
              {(roll.modifierNote || roll.note) && (
                <p className="rules-text">
                  {[roll.modifierNote, roll.note].filter(Boolean).join(' · ')}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      {battle.resolution && (
        <p className="rules-text">{battle.resolution.narrative}</p>
      )}
      {!!battle.effects.length && (
        <ul>
          {battle.effects.map((item) => (
            <li key={item.id}>{item.summary}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BattleDetails({
  battle,
  options,
  busy,
  onChange,
  onRoll,
}: {
  battle: SettlementBattle;
  options: SettlementStateOptions | null;
  busy: boolean;
  onChange: (battle: SettlementBattle) => void;
  onRoll: (
    battleId: string,
    input: Omit<BattleRollInput, 'expectedVersion' | 'expectedMapRevision'>,
  ) => Promise<void>;
}) {
  const [phase, setPhase] = useState<BattleRollInput['phase']>(
    battle.kind === 'Siege' ? 'Siege' : 'Fire',
  );
  const [count, setCount] = useState(1),
    [sides, setSides] = useState(6),
    [zeroBased, setZeroBased] = useState(false);
  const [attackerModifier, setAttackerModifier] = useState(0),
    [defenderModifier, setDefenderModifier] = useState(0);
  const [modifierNote, setModifierNote] = useState(''),
    [note, setNote] = useState(''),
    [error, setError] = useState('');
  const [pending, setPending] = useState<Omit<
    BattleRollInput,
    'expectedVersion' | 'expectedMapRevision'
  > | null>(null);
  const inFlight = useRef(false);
  const resolution: BattleResolution = battle.resolution ?? {
    outcome: 'Inconclusive',
    narrative: '',
    occupyCountryId: null,
    armies: battle.participants.map((item) => ({
      armyId: item.armyId,
      casualties: 0,
      destinationTileId: null,
    })),
  };
  function resolve(next: BattleResolution) {
    onChange({ ...battle, resolution: next, effects: [] });
  }
  async function roll() {
    if (busy || inFlight.current) return;
    setError('');
    const input = pending ?? {
      idempotencyKey: crypto.randomUUID(),
      phase,
      count: phase === 'Custom' ? count : 1,
      sides: phase === 'Custom' ? sides : phase === 'Siege' ? 14 : 10,
      zeroBased: phase === 'Custom' ? zeroBased : phase !== 'Siege',
      attackerModifier,
      defenderModifier: phase === 'Siege' ? 0 : defenderModifier,
      modifierNote,
      note,
    };
    if (
      !Number.isInteger(input.count) ||
      input.count < 1 ||
      input.count > 20 ||
      !Number.isInteger(input.sides) ||
      input.sides < 2 ||
      input.sides > 1000 ||
      !Number.isInteger(input.attackerModifier) ||
      !Number.isInteger(input.defenderModifier) ||
      Math.abs(input.attackerModifier) > 10000 ||
      Math.abs(input.defenderModifier) > 10000
    ) {
      setError(
        '骰子数量为 1—20，面数为 2—1000，修正值为 −10000—10000 的整数。',
      );
      return;
    }
    if (
      (input.attackerModifier || input.defenderModifier) &&
      !input.modifierNote.trim()
    ) {
      setError('请说明修正值的依据。');
      return;
    }
    setPending(input);
    inFlight.current = true;
    try {
      await onRoll(battle.id, input);
      setPending(null);
      if (phase === 'Fire') setPhase('Shock');
      else if (phase === 'Shock') setPhase('Fire');
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status < 500) {
        setPending(null);
        setError(cause.message);
      } else setError('掷骰结果未确认，请重试同一次掷骰。');
    } finally {
      inFlight.current = false;
    }
  }
  return (
    <details className="battle-details">
      <summary>
        {battle.title} ·{' '}
        {battle.resolution ? outcomeNames[battle.resolution.outcome] : '待裁决'}
      </summary>
      <BattleRecord battle={battle} />
      {!battle.resolution && (
        <fieldset disabled={busy || !!pending} className="battle-form">
          <legend>掷骰</legend>
          <label>
            阶段
            <select
              value={phase}
              onChange={(event) => setPhase(event.target.value as typeof phase)}
            >
              <option value="Fire">火力（0—9）</option>
              <option value="Shock">冲击（0—9）</option>
              {battle.kind === 'Siege' && (
                <option value="Siege">围城（1—14，仅进攻方）</option>
              )}
              <option value="Custom">自定骰子</option>
            </select>
          </label>
          {phase === 'Custom' && (
            <>
              <label>
                每方骰子数量
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={count}
                  onChange={(event) => setCount(Number(event.target.value))}
                />
              </label>
              <label>
                骰子面数
                <input
                  type="number"
                  min={2}
                  max={1000}
                  value={sides}
                  onChange={(event) => setSides(Number(event.target.value))}
                />
              </label>
              <label className="battle-check">
                <input
                  type="checkbox"
                  checked={zeroBased}
                  onChange={(event) => setZeroBased(event.target.checked)}
                />
                从 0 起算
              </label>
            </>
          )}
          <label>
            进攻修正
            <input
              type="number"
              value={attackerModifier}
              onChange={(event) =>
                setAttackerModifier(Number(event.target.value))
              }
            />
          </label>
          {phase !== 'Siege' && (
            <label>
              防守修正
              <input
                type="number"
                value={defenderModifier}
                onChange={(event) =>
                  setDefenderModifier(Number(event.target.value))
                }
              />
            </label>
          )}
          <label className="battle-wide">
            修正依据
            <input
              maxLength={2000}
              value={modifierNote}
              onChange={(event) => setModifierNote(event.target.value)}
              placeholder="例如：进攻方渡河 −1，将领 +2"
            />
          </label>
          <label className="battle-wide">
            本轮说明
            <input
              maxLength={2000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
        </fieldset>
      )}
      {!battle.resolution && (
        <button disabled={busy} onClick={() => void roll()}>
          {pending ? '重试同一次掷骰' : '保存并掷骰'}
        </button>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <fieldset
        disabled={busy || !!pending || !options}
        className="battle-form"
      >
        <legend>主持人裁决</legend>
        <label>
          战斗结果
          <select
            value={resolution.outcome}
            onChange={(event) =>
              resolve({
                ...resolution,
                outcome: event.target.value as BattleResolution['outcome'],
                occupyCountryId: null,
              })
            }
          >
            {Object.entries(outcomeNames).map(([value, name]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          战场控制权
          <select
            value={resolution.occupyCountryId ?? ''}
            onChange={(event) =>
              resolve({
                ...resolution,
                occupyCountryId: event.target.value || null,
              })
            }
          >
            <option value="">保持原控制权</option>
            {options?.countries
              .filter((country) =>
                (resolution.outcome === 'AttackerVictory'
                  ? battle.attackers
                  : resolution.outcome === 'DefenderVictory'
                    ? battle.defenders
                    : []
                ).some(
                  (item) =>
                    battle.participants.find((p) => p.armyId === item.armyId)
                      ?.countryId === country.id,
                ),
              )
              .map((country) => (
                <option key={country.id} value={country.id}>
                  {country.name}
                </option>
              ))}
          </select>
        </label>
        {resolution.armies.map((result) => {
          const participant = battle.participants.find(
            (item) => item.armyId === result.armyId,
          )!;
          const update = (fields: Partial<typeof result>) =>
            resolve({
              ...resolution,
              armies: resolution.armies.map((item) =>
                item.armyId === result.armyId ? { ...item, ...fields } : item,
              ),
            });
          return (
            <div className="battle-army-result battle-wide" key={result.armyId}>
              <strong>
                {participant.countryName} · {participant.name}（参战{' '}
                {participant.committedStrength}，全军{' '}
                {participant.originalStrength}）
              </strong>
              <label>
                {participant.countryName} · {participant.name}伤亡
                <input
                  type="number"
                  min={0}
                  max={participant.committedStrength}
                  value={result.casualties}
                  onChange={(event) =>
                    update({ casualties: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                {participant.countryName} · {participant.name}全军战后位置
                <select
                  value={result.destinationTileId ?? ''}
                  onChange={(event) =>
                    update({ destinationTileId: event.target.value || null })
                  }
                >
                  <option value="">
                    保持原位 ({participant.q}, {participant.r})
                  </option>
                  {options?.tiles
                    .filter(
                      (tile) =>
                        tile.passable && tile.id !== participant.originalTileId,
                    )
                    .map((tile) => (
                      <option value={tile.id} key={tile.id}>
                        ({tile.q}, {tile.r})
                        {tile.id === battle.tileId ? ' · 战场' : ''}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          );
        })}
        <label className="battle-wide">
          裁决说明
          <textarea
            rows={3}
            maxLength={5000}
            value={resolution.narrative}
            onChange={(event) =>
              resolve({ ...resolution, narrative: event.target.value })
            }
          />
        </label>
      </fieldset>
      {battle.resolution && (
        <button
          disabled={busy}
          onClick={() => onChange({ ...battle, resolution: null, effects: [] })}
        >
          清除裁决
        </button>
      )}
    </details>
  );
}

export function BattleEditor({
  gameId,
  quarterId,
  actionId,
  battles,
  revision,
  busy,
  active,
  onChange,
  onRevision,
  onRoll,
}: {
  gameId: string;
  quarterId: string;
  actionId: string | null;
  battles: SettlementBattle[];
  revision?: number;
  busy: boolean;
  active: boolean;
  onChange: (battles: SettlementBattle[]) => void;
  onRevision: (revision: number) => void;
  onRoll: (
    battleId: string,
    input: Omit<BattleRollInput, 'expectedVersion' | 'expectedMapRevision'>,
  ) => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [options, setOptions] = useState<SettlementStateOptions | null>(null);
  const [loading, setLoading] = useState(false),
    [reload, setReload] = useState(0),
    [error, setError] = useState('');
  const [title, setTitle] = useState(''),
    [kind, setKind] = useState<'Field' | 'Siege'>('Field');
  const [q, setQ] = useState(''),
    [r, setR] = useState('');
  const [adding, setAdding] = useState(false);
  const [attackers, setAttackers] = useState<BattleParticipantInput[]>([
    { armyId: '', committedStrength: 1 },
  ]);
  const [defenders, setDefenders] = useState<BattleParticipantInput[]>([
    { armyId: '', committedStrength: 1 },
  ]);
  const callback = useRef(onRevision);
  callback.current = onRevision;
  const scoped = battles.filter((item) => item.actionId === actionId);
  useEffect(() => {
    if (!open || !active) return;
    let live = true;
    setLoading(true);
    setError('');
    void fetchSettlementStateOptions(gameId, quarterId)
      .then((data) => {
        if (live) {
          setOptions(data);
          callback.current(data.mapRevision);
        }
      })
      .catch((cause: unknown) => {
        if (live) {
          setOptions(null);
          setError(cause instanceof Error ? cause.message : '参战信息读取失败');
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [gameId, quarterId, open, active, reload, revision]);
  function add() {
    if (!options || loading || busy) return;
    setError('');
    if (battles.length && options.mapRevision !== revision) {
      setError('地图已变化，请先保存或移除已有战斗，再重新添加。');
      return;
    }
    const tile = options.tiles.find(
      (item) => item.q === Number(q) && item.r === Number(r),
    );
    if (
      !title.trim() ||
      !q.trim() ||
      !r.trim() ||
      !Number.isInteger(Number(q)) ||
      !Number.isInteger(Number(r)) ||
      !tile?.passable
    ) {
      setError('请填写战斗名称和地图内的可通行战场坐标。');
      return;
    }
    const entries = [...attackers, ...defenders];
    if (
      new Set(entries.map((item) => item.armyId)).size !== entries.length ||
      entries.some((item) =>
        battles.some((battle) =>
          battle.participants.some((p) => p.armyId === item.armyId),
        ),
      )
    ) {
      setError('参战军队重复；同一军队本回合只能参与一场战斗。');
      return;
    }
    if (
      entries.some((item) => {
        const army = options.armies.find((army) => army.id === item.armyId);
        return (
          !army ||
          !Number.isInteger(item.committedStrength) ||
          item.committedStrength < 1 ||
          item.committedStrength > army.strength
        );
      })
    ) {
      setError('请指定双方军队，参战人数不能超过军队当前兵力。');
      return;
    }
    const battle: SettlementBattle = {
      id: crypto.randomUUID(),
      actionId,
      title: title.trim(),
      kind,
      tileId: tile.id,
      q: tile.q,
      r: tile.r,
      attackers,
      defenders,
      resolution: null,
      effects: [],
      rolls: [],
      participants: entries.map((item) => {
        const army = options.armies.find((army) => army.id === item.armyId)!;
        return {
          ...item,
          name: army.name,
          countryId: army.countryId,
          countryName: army.countryName,
          originalStrength: army.strength,
          originalTileId: army.tileId,
          q: army.q,
          r: army.r,
        };
      }),
    };
    onChange([...battles, battle]);
    setTitle('');
    setAdding(false);
  }
  return (
    <details
      className="state-change-editor battle-editor"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>战斗{scoped.length ? `（${scoped.length}）` : ''}</summary>
      {open && (
        <>
          {scoped.map((battle) => (
            <div className="battle-item" key={battle.id}>
              <BattleDetails
                battle={battle}
                options={options}
                busy={busy || loading}
                onChange={(next) =>
                  onChange(
                    battles.map((item) => (item.id === next.id ? next : item)),
                  )
                }
                onRoll={onRoll}
              />
              <button
                disabled={busy}
                onClick={() =>
                  onChange(battles.filter((item) => item.id !== battle.id))
                }
              >
                移除战斗
              </button>
            </div>
          ))}
          {!!scoped.length && !adding && (
            <button disabled={busy} onClick={() => setAdding(true)}>
              新建战斗
            </button>
          )}
          {(adding || !scoped.length) && (
            <fieldset
              className="battle-form"
              disabled={busy || loading || !options}
            >
              <legend>添加战斗</legend>
              <label>
                战斗名称
                <input
                  maxLength={200}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label>
                战斗类型
                <select
                  value={kind}
                  onChange={(event) =>
                    setKind(event.target.value as typeof kind)
                  }
                >
                  <option value="Field">野战</option>
                  <option value="Siege">攻城</option>
                </select>
              </label>
              <label>
                战场列
                <input
                  type="number"
                  value={q}
                  onChange={(event) => setQ(event.target.value)}
                />
              </label>
              <label>
                战场行
                <input
                  type="number"
                  value={r}
                  onChange={(event) => setR(event.target.value)}
                />
              </label>
              {(
                [
                  ['进攻方', attackers, setAttackers],
                  ['防守方', defenders, setDefenders],
                ] as const
              ).map(([name, entries, setEntries]) => (
                <fieldset className="battle-wide battle-side" key={name}>
                  <legend>{name}</legend>
                  {entries.map((entry, index) => (
                    <div className="battle-participant" key={index}>
                      <label>
                        {name}军队 {index + 1}
                        <select
                          value={entry.armyId}
                          onChange={(event) => {
                            const army = options?.armies.find(
                              (item) => item.id === event.target.value,
                            );
                            setEntries(
                              entries.map((item, i) =>
                                i === index
                                  ? {
                                      armyId: event.target.value,
                                      committedStrength: army?.strength ?? 1,
                                    }
                                  : item,
                              ),
                            );
                          }}
                        >
                          <option value="">选择军队</option>
                          {options?.armies
                            .filter((army) => army.strength > 0)
                            .map((army) => (
                              <option value={army.id} key={army.id}>
                                {army.countryName} · {army.name}（
                                {army.strength}，{army.q}, {army.r}）
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        {name}参战人数 {index + 1}
                        <input
                          type="number"
                          min={1}
                          value={entry.committedStrength}
                          onChange={(event) =>
                            setEntries(
                              entries.map((item, i) =>
                                i === index
                                  ? {
                                      ...item,
                                      committedStrength: Number(
                                        event.target.value,
                                      ),
                                    }
                                  : item,
                              ),
                            )
                          }
                        />
                      </label>
                      {entries.length > 1 && (
                        <button
                          onClick={() =>
                            setEntries(entries.filter((_, i) => i !== index))
                          }
                        >
                          移除
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    disabled={entries.length >= 10}
                    onClick={() =>
                      setEntries([
                        ...entries,
                        { armyId: '', committedStrength: 1 },
                      ])
                    }
                  >
                    增加{name}军队
                  </button>
                </fieldset>
              ))}
              <button onClick={add}>添加战斗</button>
            </fieldset>
          )}
          <button
            disabled={busy || loading}
            onClick={() => setReload((value) => value + 1)}
          >
            重读参战状态
          </button>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </details>
  );
}
