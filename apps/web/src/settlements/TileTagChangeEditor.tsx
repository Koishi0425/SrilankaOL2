import { validTileTag } from '@srilanka/contracts';
import { useEffect, useState } from 'react';
import type {
  SettlementStateChange,
  SettlementStateOptions,
  ActionObjectRef,
} from '@srilanka/contracts';
import { TileTagFields, emptyTileTag } from '../map/TileTags.js';
import { fetchSettlementStateOptions } from '../api.js';
export function TileTagChangeEditor({
  gameId,
  quarterId,
  actionId,
  changes,
  busy,
  onChange,
  onRevision,
  revision,
  refs = [],
}: {
  gameId: string;
  quarterId: string;
  actionId: string | null;
  changes: SettlementStateChange[];
  busy: boolean;
  onChange: (changes: SettlementStateChange[]) => void;
  onRevision: (revision: number) => void;
  revision?: number;
  refs?: Array<Omit<ActionObjectRef, 'id'>>;
}) {
  const [open, setOpen] = useState(false),
    [options, setOptions] = useState<SettlementStateOptions | null>(null),
    [error, setError] = useState('');
  const [tag, setTag] = useState({ ...emptyTileTag }),
    [remove, setRemove] = useState(false);
  const [rect, setRect] = useState({ minQ: '', maxQ: '', minR: '', maxR: '' }),
    [targets, setTargets] = useState(
      refs.some(
        (r) =>
          r.refKind === 'Target' && ['Tile', 'Province'].includes(r.objectType),
      ),
    ),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setError('');
    void fetchSettlementStateOptions(gameId, quarterId)
      .then((data) => {
        if (live) setOptions(data);
      })
      .catch((cause) => {
        if (live) setError(cause instanceof Error ? cause.message : '读取失败');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [open, gameId, quarterId]);
  const scoped = changes.filter(
    (c) => c.kind === 'TileTag' && c.actionId === actionId,
  );
  function add() {
    if (!options || busy || loading) return;
    if (changes.length && options.mapRevision !== revision) {
      setError('地图已变化，请保存或移除原有变化并重新检查。');
      return;
    }
    const tileIds = targets
      ? [
          ...new Set(
            refs
              .filter((r) => r.refKind === 'Target')
              .flatMap((r) =>
                r.objectType === 'Tile'
                  ? [r.objectId]
                  : r.objectType === 'Province'
                    ? options.tiles
                        .filter((t) => t.provinceId === r.objectId)
                        .map((t) => t.id)
                    : [],
              ),
          ),
        ]
      : Object.values(rect).some(
            (v) => !v.trim() || !Number.isInteger(Number(v)),
          )
        ? []
        : options.tiles
            .filter(
              (t) =>
                t.q >= Number(rect.minQ) &&
                t.q <= Number(rect.maxQ) &&
                t.r >= Number(rect.minR) &&
                t.r <= Number(rect.maxR),
            )
            .map((t) => t.id);
    if (!tileIds.length || tileIds.length > 2500 || !validTileTag(tag)) {
      setError(
        '请填写状态名称，并选择政策关联地块或有效矩形（最多 2500 格）。',
      );
      return;
    }
    if (
      changes.some(
        (c) =>
          c.kind === 'TileTag' &&
          c.tag.name.trim() === tag.name.trim() &&
          c.tileIds.some((id) => tileIds.includes(id)),
      )
    ) {
      setError('已有同名状态变化涉及这些地块，请合并后添加。');
      return;
    }
    onRevision(options.mapRevision);
    onChange([
      ...changes,
      {
        id: crypto.randomUUID(),
        actionId,
        kind: 'TileTag',
        operation: remove ? 'Remove' : 'Set',
        tileIds,
        tag: { ...tag, name: tag.name.trim() },
        summary: `${tileIds.length} 格：${remove ? '移除' : '设置'} ${tag.name.trim()}${remove ? '' : '（下回合生效）'}`,
      },
    ]);
    setError('');
  }
  return (
    <details
      className="settlement-state-editor"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>地块状态{scoped.length ? `（${scoped.length}）` : ''}</summary>
      {scoped.map((c) => (
        <p key={c.id}>
          {c.summary}
          <button
            disabled={busy}
            onClick={() => onChange(changes.filter((item) => item.id !== c.id))}
          >
            移除此状态变化
          </button>
        </p>
      ))}
      {open && (
        <>
          <p>
            设置随结算发布，从下一回合起持续指定回合；移除在发布时生效。不会回算本回合已冻结的经济账单。
          </p>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          {loading && <p role="status">读取地块…</p>}
          <fieldset disabled={busy || loading} className="draft-fields">
            <label className="check-row">
              <input
                type="checkbox"
                checked={targets}
                onChange={(e) => setTargets(e.target.checked)}
              />
              使用政策关联的地块／省份目标
            </label>
            {!targets && (
              <div className="map-fields">
                {(['minQ', 'maxQ', 'minR', 'maxR'] as const).map((key, i) => (
                  <label key={key}>
                    {['起始列', '结束列', '起始行', '结束行'][i]}
                    <input
                      type="number"
                      value={rect[key]}
                      onChange={(e) =>
                        setRect({ ...rect, [key]: e.target.value })
                      }
                    />
                  </label>
                ))}
              </div>
            )}
            <label className="check-row">
              <input
                type="checkbox"
                checked={remove}
                onChange={(e) => setRemove(e.target.checked)}
              />
              移除同名状态
            </label>
            <TileTagFields value={tag} onChange={setTag} />
            <button disabled={!options} onClick={add}>
              添加地块状态计划
            </button>
          </fieldset>
        </>
      )}
    </details>
  );
}
