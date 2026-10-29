import { useEffect, useRef, useState } from 'react';
import type { RoundPolicy } from '@srilanka/contracts';
import { fetchRoundPolicy } from '../api.js';
import {
  DraftSession,
  priorRoundPolicyDraftKeys,
  useDraftKey,
} from '../drafts/local-drafts.js';
import { LoadingSkeleton } from '../ui/LoadingSkeleton.js';
import { isLocalPolicy, policyDraftPreview } from './policy-draft-data.js';

type OldDraft = { key: string; label: string; savedAt: string; text: string };
export function PriorPolicyDrafts({
  gameId,
  policy,
  active,
}: {
  gameId: string;
  policy: RoundPolicy;
  active: boolean;
}) {
  const key = useDraftKey(
    gameId,
    policy.quarterId,
    'round-policy',
    `${policy.memberId}:${policy.countryId}`,
  );
  const [keys, setKeys] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<OldDraft[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [displayKey, setDisplayKey] = useState(key);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setDisplayKey(key);
    setKeys([]);
    setOpen(false);
    setDrafts([]);
    setLoading(false);
    setError('');
    setCopied('');
    if (active) {
      try {
        setKeys(priorRoundPolicyDraftKeys(key));
      } catch {
        setError('无法读取旧回合本地草稿，请检查浏览器存储权限。');
      }
    } else setKeys([]);
    return () => request.current?.abort();
  }, [key, active]);

  async function show() {
    if (open) {
      request.current?.abort();
      setOpen(false);
      setLoading(false);
      setDrafts([]);
      return;
    }
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setOpen(true);
    setLoading(true);
    setDrafts([]);
    setError('');
    setCopied('');
    const verified: OldDraft[] = [];
    let unavailable = false;
    for (const oldKey of keys) {
      if (controller.signal.aborted) return;
      try {
        const scope = JSON.parse(
          oldKey.slice('srilanka:draft:v1:'.length),
        ) as string[];
        const quarterId = scope[2]!;
        // Never expose stored text based only on possession of a browser storage key.
        const original = await fetchRoundPolicy(
          gameId,
          { ...policy, quarterId },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (
          original.quarterId !== quarterId ||
          original.memberId !== policy.memberId ||
          original.countryId !== policy.countryId
        )
          throw new Error('草稿归属不匹配');
        const session = new DraftSession(oldKey, isLocalPolicy);
        if (session.error) throw new Error(session.error);
        const draft = session.saved;
        if (!draft) continue;
        if (draft.value.countryId !== original.countryId)
          throw new Error('草稿国家不匹配');
        const text = policyDraftPreview(draft.value);
        if (!text.trim()) continue;
        verified.push({
          key: oldKey,
          label: `第 ${original.quarter.gameYear} 年 · 第 ${original.quarter.sequenceNumber} 回合`,
          savedAt: draft.savedAt,
          text,
        });
      } catch {
        if (controller.signal.aborted) return;
        unavailable = true;
      }
    }
    if (controller.signal.aborted) return;
    verified.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    setDrafts(verified);
    setLoading(false);
    if (unavailable)
      setError(
        '部分旧稿因权限变化、连接失败或格式异常未展示，可稍后重新打开。',
      );
  }
  async function copy(draft: OldDraft) {
    try {
      await navigator.clipboard.writeText(draft.text);
      setCopied(draft.key);
    } catch {
      setCopied('failed');
    }
  }
  if (displayKey !== key || !active || (!keys.length && !error)) return null;
  return (
    <section className="draft-recovery" aria-label="旧回合本地草稿">
      {!!keys.length && (
        <>
          <p>
            此设备有旧回合本地草稿。可查看或复制，不会自动覆盖当前回合的政策。
          </p>
          <button type="button" onClick={() => void show()}>
            {open ? '收起旧回合草稿' : `查看旧回合草稿（${keys.length} 份）`}
          </button>
        </>
      )}
      {loading && <LoadingSkeleton label="正在核对旧回合草稿权限…" />}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {open && !loading && !error && !drafts.length && (
        <p>没有可查看的旧回合草稿。</p>
      )}
      {open &&
        drafts.map((draft) => (
          <div key={draft.key} className="prior-policy-draft">
            <h5>{draft.label}</h5>
            <p>
              本地暂存于{' '}
              <time>{new Date(draft.savedAt).toLocaleString('zh-CN')}</time>
            </p>
            <textarea
              aria-label={`${draft.label}本地草稿全文`}
              value={draft.text}
              rows={6}
              readOnly
            />
            <button type="button" onClick={() => void copy(draft)}>
              复制此回合草稿
            </button>
            {copied === draft.key && <p role="status">已复制旧回合草稿。</p>}
          </div>
        ))}
      {copied === 'failed' && (
        <p role="alert">无法自动复制，请在草稿全文中选中文字复制。</p>
      )}
    </section>
  );
}
