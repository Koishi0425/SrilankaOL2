import { validTileTag } from '@srilanka/contracts';
import { useEffect, useState } from 'react';
import type {
  CountrySummary,
  DiscoveryState,
  GameSummary,
  MapMetadata,
  MapSetupData,
} from '@srilanka/contracts';
import {
  batchMapTiles,
  changeTileTags,
  fetchMapReveal,
  fetchMapSetup,
  initializeMapKnowledge,
  removeMapReveal,
  revealMapKnowledge,
} from '../api.js';

import { TileTagFields, emptyTileTag } from './TileTags.js';
import { MapGenerator } from './MapGenerator.js';

export interface MapRevealSeed {
  key: number;
  actionId: string;
  title: string;
  countryId: string;
  tileIds: string[];
}
export const discoveryNames: Record<DiscoveryState, string> = {
  Unknown: '清除记录',
  Mapped: '地理信息',
  Observed: '侦察情报',
};

export function MapSetupPanel({
  correctionReason,
  game,
  countries,
  selectedIds,
  onSelection,
  onRectangle,
  onChanged,
  seed,
  onReturn,
}: {
  correctionReason?: string;
  game: GameSummary;
  countries: CountrySummary[];
  selectedIds: string[];
  onSelection: (ids: string[]) => void;
  onRectangle: (bounds: {
    minQ: number;
    maxQ: number;
    minR: number;
    maxR: number;
  }) => Promise<void>;
  onChanged: (map: MapMetadata) => void;
  seed?: MapRevealSeed;
  onReturn?: () => void;
}) {
  const [setup, setSetup] = useState<MapSetupData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState('tiles');
  const [tag, setTag] = useState({ ...emptyTileTag });
  const [terrain, setTerrain] = useState('');
  const [control, setControl] = useState('keep');
  const [legal, setLegal] = useState('keep');
  const [region, setRegion] = useState('');
  const [province, setProvince] = useState('');
  const [countryId, setCountryId] = useState(countries[0]?.id ?? '');
  const [state, setState] = useState<DiscoveryState>('Mapped');
  const [note, setNote] = useState('');
  const [reportArmy, setReportArmy] = useState(false);
  const [armyError, setArmyError] = useState(25);
  const [initialMode, setInitialMode] = useState<
    'OwnTerritory' | 'Geography' | 'Unknown'
  >('OwnTerritory');
  const [source, setSource] = useState<MapRevealSeed>();
  const [hasPlan, setHasPlan] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [rect, setRect] = useState({ minQ: 0, maxQ: 3, minR: 0, maxR: 3 });
  useEffect(() => {
    if (seed) return;
    let live = true;
    void fetchMapSetup(game.id)
      .then((data) => {
        if (live) setSetup(data);
      })
      .catch((cause: unknown) => {
        if (live)
          setError(cause instanceof Error ? cause.message : '地图准备加载失败');
      });
    return () => {
      live = false;
    };
  }, [game.id, seed]);
  useEffect(() => {
    if (!seed) {
      setSource(undefined);
      setHasPlan(false);
      return;
    }
    let live = true;
    setBusy(true);
    setSource(seed);
    setCountryId(seed.countryId);
    setMode('knowledge');
    setConfirm(false);
    setError('');
    setMessage('');
    void Promise.all([
      fetchMapSetup(game.id),
      fetchMapReveal(game.id, seed.actionId),
    ])
      .then(([data, plan]) => {
        if (!live) return;
        setSetup(data);
        setHasPlan(!!plan);
        setState(plan?.state ?? 'Mapped');
        setNote(plan?.note ?? '');
        setReportArmy(plan?.armyErrorPercent !== undefined);
        setArmyError(plan?.armyErrorPercent ?? 25);
        onSelection(plan?.tileIds ?? seed.tileIds);
      })
      .catch((cause: unknown) => {
        if (live)
          setError(cause instanceof Error ? cause.message : '探索结果加载失败');
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [game.id, seed, onSelection]);
  useEffect(() => {
    setConfirm(false);
    setClearing(false);
  }, [
    selectedIds,
    countryId,
    state,
    note,
    reportArmy,
    armyError,
    initialMode,
    mode,
  ]);

  async function perform(
    operation: () => Promise<MapSetupData>,
    success: string,
  ) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    setConfirm(false);
    try {
      const data = await operation();
      setSetup(data);
      if (data.map) onChanged(data.map);
      setMessage(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '地图操作失败');
      // Keep inputs and selection; use the fresh revision only after the host checks again.
      try {
        setSetup(await fetchMapSetup(game.id));
      } catch {
        /* Original error remains visible. */
      }
    } finally {
      setBusy(false);
    }
  }
  const revision = setup?.map?.revision ?? 1;
  const country = countries.find((item) => item.id === countryId)?.name ?? '';
  const changed =
    !!terrain || control !== 'keep' || legal !== 'keep' || !!region.trim();
  const canInitialize =
    game.currentQuarter.sequenceNumber === 1 &&
    game.currentQuarter.state === 'Preparing';
  return (
    <div className="map-setup">
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!setup ? (
        <p>加载中…</p>
      ) : !setup.map ? (
        <MapGenerator
          gameId={game.id}
          onRefresh={(data) => {
            setSetup(data);
            if (data.map) onChanged(data.map);
          }}
          countries={countries}
          map={null}
          blockedReason={
            !canInitialize || game.status !== 'Preparing'
              ? '仅开局准备阶段可创建自动地图。'
              : undefined
          }
          onSelection={onSelection}
          onChanged={(data) => {
            setSetup(data);
            if (data.map) onChanged(data.map);
            setMessage('地图已创建，可用笔刷与批量工具微调。');
          }}
        />
      ) : (
        <>
          {canInitialize && game.status === 'Preparing' && !seed && (
            <details>
              <summary>自动生成地形</summary>
              <MapGenerator
                onRefresh={(data) => {
                  setSetup(data);
                  if (data.map) onChanged(data.map);
                }}
                key={setup.map.id}
                gameId={game.id}
                countries={countries}
                map={setup.map}
                blockedReason={setup.generationBlockedReason}
                onSelection={onSelection}
                onChanged={(data) => {
                  setSetup(data);
                  if (data.map) onChanged(data.map);
                  setMessage('地形已生成');
                }}
              />
            </details>
          )}
          <div className="map-setup-tabs">
            <button
              disabled={busy}
              aria-pressed={mode === 'tiles'}
              onClick={() => setMode('tiles')}
            >
              布置地块
            </button>
            <button
              disabled={busy}
              aria-pressed={mode === 'knowledge'}
              onClick={() => setMode('knowledge')}
            >
              揭示信息
            </button>
            {!seed && (
              <button
                disabled={busy}
                aria-pressed={mode === 'tags'}
                onClick={() => setMode('tags')}
              >
                地块状态
              </button>
            )}
            {canInitialize && (
              <button
                disabled={busy}
                aria-pressed={mode === 'initial'}
                onClick={() => setMode('initial')}
              >
                初始范围
              </button>
            )}
          </div>
          {mode !== 'initial' && (
            <div className="map-selection">
              <strong>已选 {selectedIds.length} 个地块</strong>
              <button
                disabled={busy || !selectedIds.length}
                onClick={() => onSelection([])}
              >
                清空选区
              </button>
              <details>
                <summary>按坐标选择矩形</summary>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    setBusy(true);
                    setError('');
                    void onRectangle(rect)
                      .catch((cause: unknown) =>
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : '选区读取失败',
                        ),
                      )
                      .finally(() => setBusy(false));
                  }}
                >
                  <div className="map-fields">
                    {(['minQ', 'maxQ', 'minR', 'maxR'] as const).map(
                      (key, index) => (
                        <label key={key}>
                          {['起始列', '结束列', '起始行', '结束行'][index]}
                          <input
                            type="number"
                            required
                            min={0}
                            max={
                              (key.endsWith('Q')
                                ? setup.map!.width
                                : setup.map!.height) - 1
                            }
                            value={rect[key]}
                            onChange={(event) =>
                              setRect({
                                ...rect,
                                [key]: Number(event.target.value),
                              })
                            }
                          />
                        </label>
                      ),
                    )}
                  </div>
                  <button disabled={busy}>选择矩形</button>
                </form>
              </details>
            </div>
          )}
          <fieldset disabled={busy} className="map-setup-fields">
            {mode === 'tiles' ? (
              <>
                <div className="map-fields">
                  <label>
                    地形
                    <select
                      value={terrain}
                      onChange={(event) => setTerrain(event.target.value)}
                    >
                      <option value="">保持原样</option>
                      {setup.terrains.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    控制国家
                    <select
                      value={control}
                      onChange={(event) => setControl(event.target.value)}
                    >
                      <option value="keep">保持原样</option>
                      <option value="">无国家</option>
                      {countries.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    法定归属
                    <select
                      value={legal}
                      onChange={(event) => setLegal(event.target.value)}
                    >
                      <option value="keep">保持原样</option>
                      <option value="">无国家</option>
                      {countries.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    地区名称
                    <input
                      maxLength={120}
                      list="map-regions"
                      placeholder="不填则保持原样"
                      value={region}
                      onChange={(event) => setRegion(event.target.value)}
                    />
                  </label>
                  <label>
                    省份名称
                    <input
                      maxLength={120}
                      placeholder="填写地区时可设置"
                      list="map-provinces"
                      value={province}
                      onChange={(event) => setProvince(event.target.value)}
                    />
                  </label>
                  <datalist id="map-regions">
                    {setup.regions.map((item) => (
                      <option key={item.id} value={item.name} />
                    ))}
                  </datalist>
                  <datalist id="map-provinces">
                    {setup.provinces?.map((item) => (
                      <option key={item.id} value={item.name} />
                    ))}
                  </datalist>
                </div>
                <button
                  disabled={
                    ((game.currentQuarter.state !== 'Preparing' ||
                      game.status !== 'Preparing') &&
                      !correctionReason?.trim()) ||
                    !selectedIds.length ||
                    !changed ||
                    (!!province.trim() && !region.trim())
                  }
                  onClick={() =>
                    void perform(
                      () =>
                        batchMapTiles(game.id, {
                          ...(correctionReason?.trim()
                            ? { correctionReason: correctionReason.trim() }
                            : {}),
                          expectedRevision: revision,
                          tileIds: selectedIds,
                          ...(terrain ? { terrainTypeId: terrain } : {}),
                          ...(control !== 'keep'
                            ? { controllerCountryId: control || null }
                            : {}),
                          ...(legal !== 'keep'
                            ? { legalOwnerCountryId: legal || null }
                            : {}),
                          ...(region.trim()
                            ? { regionName: region.trim() }
                            : {}),
                          ...(province.trim()
                            ? { provinceName: province.trim() }
                            : {}),
                        }),
                      '地块已更新',
                    )
                  }
                >
                  应用到所选地块
                </button>
              </>
            ) : mode === 'tags' ? (
              <>
                <TileTagFields value={tag} onChange={setTag} />
                <p>
                  立即设置从本回合起生效；普通回合变化请在结算的“地块状态”中发布。
                </p>
                <button
                  disabled={
                    !selectedIds.length ||
                    !validTileTag(tag) ||
                    ((game.status !== 'Preparing' ||
                      game.currentQuarter.state !== 'Preparing') &&
                      !correctionReason?.trim())
                  }
                  onClick={() =>
                    void perform(
                      () =>
                        changeTileTags(game.id, {
                          expectedRevision: revision,
                          tileIds: selectedIds,
                          operation: 'Set',
                          tag,
                          ...(correctionReason?.trim()
                            ? { correctionReason: correctionReason.trim() }
                            : {}),
                        }),
                      '地块状态已设置',
                    )
                  }
                >
                  设置所选地块状态
                </button>
                <button
                  disabled={
                    !selectedIds.length ||
                    !validTileTag(tag) ||
                    ((game.status !== 'Preparing' ||
                      game.currentQuarter.state !== 'Preparing') &&
                      !correctionReason?.trim())
                  }
                  onClick={() =>
                    void perform(
                      () =>
                        changeTileTags(game.id, {
                          expectedRevision: revision,
                          tileIds: selectedIds,
                          operation: 'Remove',
                          tag,
                          ...(correctionReason?.trim()
                            ? { correctionReason: correctionReason.trim() }
                            : {}),
                        }),
                      '同名地块状态已移除',
                    )
                  }
                >
                  移除所选地块的同名状态
                </button>
              </>
            ) : (
              <>
                {source && mode === 'knowledge' && (
                  <div className="map-source">
                    <strong>探索结果：{source.title}</strong>
                    {onReturn && <button onClick={onReturn}>返回结算</button>}
                    <button
                      onClick={() => {
                        setSource(undefined);
                        setHasPlan(false);
                        setNote('');
                      }}
                    >
                      改为直接揭示
                    </button>
                  </div>
                )}
                <div className="map-fields">
                  <label>
                    接收国家
                    <select
                      disabled={mode === 'knowledge' && !!source}
                      value={countryId}
                      onChange={(event) => setCountryId(event.target.value)}
                    >
                      {countries.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {mode === 'initial' ? (
                    <label>
                      初始已知范围
                      <select
                        value={initialMode}
                        onChange={(event) =>
                          setInitialMode(
                            event.target.value as typeof initialMode,
                          )
                        }
                      >
                        <option value="OwnTerritory">本国与周边视野</option>
                        <option value="Geography">
                          全图地理，外国行政区划保密
                        </option>
                        <option value="Unknown">清除记录，保留当前视野</option>
                      </select>
                    </label>
                  ) : (
                    <label>
                      揭示内容
                      <select
                        value={state}
                        onChange={(event) =>
                          setState(event.target.value as DiscoveryState)
                        }
                      >
                        <option value="Mapped">地理信息</option>
                        <option value="Observed">侦察情报</option>
                      </select>
                    </label>
                  )}
                </div>
                {mode === 'knowledge' && !source && (
                  <details>
                    <summary>高级操作</summary>
                    <button
                      disabled={!selectedIds.length || !countryId}
                      onClick={() => {
                        setClearing(true);
                        setConfirm(true);
                      }}
                    >
                      清除所选地块已知记录
                    </button>
                  </details>
                )}
                {mode === 'knowledge' && (
                  <>
                    <p>
                      揭示保存本次获知的信息，不赋予永久实时视野；标签随侦察情报更新。
                    </p>
                    <label>
                      给玩家的信息
                      <textarea
                        rows={3}
                        maxLength={2000}
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                      />
                    </label>
                    {state === 'Observed' && (
                      <div className="map-army-report">
                        <label>
                          <input
                            type="checkbox"
                            checked={reportArmy}
                            onChange={(event) =>
                              setReportArmy(event.target.checked)
                            }
                          />
                          同时报告选区内的敌军
                        </label>
                        {reportArmy && (
                          <label>
                            兵力误差 ±%
                            <input
                              type="number"
                              min={0}
                              max={100}
                              value={armyError}
                              onChange={(event) =>
                                setArmyError(Number(event.target.value))
                              }
                            />
                          </label>
                        )}
                      </div>
                    )}
                  </>
                )}
                {source && mode === 'knowledge' ? (
                  <>
                    <p>随本回合结算发布。</p>
                    <button
                      disabled={!selectedIds.length || !countryId}
                      onClick={() =>
                        void perform(async () => {
                          const data = await revealMapKnowledge(game.id, {
                            expectedRevision: revision,
                            countryId,
                            tileIds: selectedIds,
                            state: clearing ? 'Unknown' : state,
                            note,
                            ...(!clearing && reportArmy && state === 'Observed'
                              ? { armyErrorPercent: armyError }
                              : {}),
                            sourceActionId: source.actionId,
                          });
                          setHasPlan(true);
                          return data;
                        }, '探索结果已保存，尚未发布')
                      }
                    >
                      保存探索结果
                    </button>
                    {hasPlan && (
                      <button
                        onClick={() =>
                          void perform(async () => {
                            const data = await removeMapReveal(
                              game.id,
                              source.actionId,
                              revision,
                            );
                            setHasPlan(false);
                            return data;
                          }, '探索结果已移除')
                        }
                      >
                        移除探索结果
                      </button>
                    )}
                  </>
                ) : (
                  <button
                    disabled={
                      !countryId ||
                      (mode === 'knowledge' && !selectedIds.length) ||
                      (mode === 'initial' && !canInitialize)
                    }
                    onClick={() => {
                      setClearing(false);
                      setConfirm(true);
                    }}
                  >
                    {mode === 'initial' ? '设置初始范围' : '发布所选信息'}
                  </button>
                )}
              </>
            )}
          </fieldset>
          {confirm && (
            <div className="map-confirm">
              <p>
                {mode === 'initial'
                  ? `将重新设置${country}的全图已知范围，覆盖现有情报。`
                  : clearing
                    ? `清除${country}对所选 ${selectedIds.length} 个地块的已知记录；实际视野内的信息仍会恢复。`
                    : `向${country}立即发布 ${selectedIds.length} 个地块的${discoveryNames[state]}。`}
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  void perform(
                    () =>
                      mode === 'initial'
                        ? initializeMapKnowledge(game.id, {
                            expectedRevision: revision,
                            countryId,
                            mode: initialMode,
                          })
                        : revealMapKnowledge(game.id, {
                            expectedRevision: revision,
                            countryId,
                            tileIds: selectedIds,
                            state: clearing ? 'Unknown' : state,
                            note,
                            ...(!clearing && reportArmy && state === 'Observed'
                              ? { armyErrorPercent: armyError }
                              : {}),
                          }),
                    '已知范围已更新',
                  )
                }
              >
                确认{mode === 'initial' ? '设置' : '发布'}
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  setConfirm(false);
                  setClearing(false);
                }}
              >
                取消
              </button>
            </div>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
