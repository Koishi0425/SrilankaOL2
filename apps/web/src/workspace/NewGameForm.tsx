import { type FormEvent, useRef, useState } from 'react';
import type { GameDetails } from '@srilanka/contracts';
import { createGame } from '../api.js';

export function NewGameForm({
  onCreated,
  onCancel,
}: {
  onCreated: (game: GameDetails) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [countries, setCountries] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  const request = useRef<{ content: string; id: string } | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    const countryNames = countries
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    if (
      !name.trim() ||
      !countryNames.length ||
      countryNames.length > 20 ||
      countryNames.some((country) => country.length > 120)
    ) {
      setError('请填写游戏名称和 1–20 个国家，每个名称最多 120 字。');
      return;
    }
    if (new Set(countryNames).size !== countryNames.length) {
      setError('国家名称不能重复。');
      return;
    }
    const content = JSON.stringify({ name: name.trim(), countryNames });
    if (request.current?.content !== content)
      request.current = { content, id: crypto.randomUUID() };
    pending.current = true;
    setSubmitting(true);
    setError('');
    try {
      onCreated(
        await createGame({
          name: name.trim(),
          countryNames,
          creationId: request.current.id,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '新建失败，请重试。');
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }
  return (
    <section className="new-game-panel" aria-label="新建一局">
      <h2>新建一局</h2>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          游戏名称
          <input
            required
            maxLength={120}
            value={name}
            disabled={submitting}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          国家名单（每行一个）
          <textarea
            required
            rows={6}
            value={countries}
            disabled={submitting}
            onChange={(event) => setCountries(event.target.value)}
          />
        </label>
        <p className="muted">创建后由你主持，再添加玩家、分配国家。</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button
            className="button button--primary"
            type="submit"
            disabled={submitting}
          >
            {submitting ? '正在创建…' : '创建游戏'}
          </button>
          <button
            className="button"
            type="button"
            disabled={submitting}
            onClick={onCancel}
          >
            取消
          </button>
        </div>
      </form>
    </section>
  );
}
