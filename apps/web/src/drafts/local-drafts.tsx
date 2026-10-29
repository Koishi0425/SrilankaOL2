import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
} from 'react';
import type { ReactNode } from 'react';

const DraftAccount = createContext<string | null>(null);
export function DraftAccountProvider({
  userId,
  children,
}: {
  userId: string;
  children: ReactNode;
}) {
  return (
    <DraftAccount.Provider value={userId}>{children}</DraftAccount.Provider>
  );
}
export function useDraftKey(
  gameId: string,
  quarterId: string,
  kind: string,
  objectId: string,
) {
  const account = useContext(DraftAccount);
  return account
    ? `srilanka:draft:v1:${JSON.stringify([account, gameId, quarterId, kind, objectId])}`
    : null;
}
export interface LocalDraft<T> {
  format: 1;
  token: string;
  savedAt: string;
  value: T;
}
/** Only discover keys in the current account/game/author scope; reading needs server authorization. */
export function priorRoundPolicyDraftKeys(key: string | null): string[] {
  if (!key) return [];
  const prefix = 'srilanka:draft:v1:';
  if (!key.startsWith(prefix)) return [];
  const scope = JSON.parse(key.slice(prefix.length)) as string[];
  if (
    !Array.isArray(scope) ||
    scope.length !== 5 ||
    scope.some((v) => typeof v !== 'string') ||
    scope[3] !== 'round-policy'
  )
    return [];
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const candidate = localStorage.key(index);
    if (!candidate?.startsWith(prefix)) continue;
    try {
      const other: unknown = JSON.parse(candidate.slice(prefix.length));
      if (
        Array.isArray(other) &&
        other.length === 5 &&
        other.every((v) => typeof v === 'string') &&
        other[0] === scope[0] &&
        other[1] === scope[1] &&
        other[2] !== scope[2] &&
        other[3] === 'round-policy' &&
        other[4] === scope[4]
      )
        keys.push(candidate);
    } catch {
      /* An unrelated corrupt key must not hide valid drafts. */
    }
  }
  return keys;
}
export function priorPolicyDraftKey(key: string | null) {
  if (!key) return key;
  try {
    if (localStorage.getItem(key)) return key;
    const prefix = 'srilanka:draft:v1:',
      scope = JSON.parse(key.slice(prefix.length)) as string[];
    let latest: { key: string; time: string } | null = null;
    for (let i = 0; i < localStorage.length; i++) {
      const candidate = localStorage.key(i);
      if (!candidate?.startsWith(prefix)) continue;
      let other: unknown;
      try {
        other = JSON.parse(candidate.slice(prefix.length));
      } catch {
        continue;
      }
      if (
        !Array.isArray(other) ||
        other.length !== 5 ||
        other[0] !== scope[0] ||
        other[1] !== scope[1] ||
        other[2] === scope[2] ||
        other[3] !== 'policy' ||
        other[4] !== 'new'
      )
        continue;
      try {
        const draft = JSON.parse(
          localStorage.getItem(candidate) ?? 'null',
        ) as LocalDraft<unknown> | null;
        if (
          draft?.format === 1 &&
          typeof draft.savedAt === 'string' &&
          (!latest || draft.savedAt > latest.time)
        )
          latest = { key: candidate, time: draft.savedAt };
      } catch {
        continue;
      }
    }
    return latest?.key ?? key;
  } catch {
    return key;
  }
}
export class DraftSession<T> {
  saved: LocalDraft<T> | null = null;
  pending = false;
  error = '';
  private token: string | null = null;
  constructor(
    readonly key: string | null,
    validate: (value: unknown) => value is T,
  ) {
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const value: unknown = JSON.parse(raw);
      if (
        !value ||
        typeof value !== 'object' ||
        !('format' in value) ||
        value.format !== 1 ||
        !('token' in value) ||
        typeof value.token !== 'string' ||
        !('savedAt' in value) ||
        typeof value.savedAt !== 'string' ||
        !('value' in value) ||
        !validate(value.value)
      )
        throw new Error('invalid');
      this.saved = value as LocalDraft<T>;
      this.token = value.token;
      this.pending = true;
    } catch {
      this.error = '无法读取本地草稿；现有文字不会自动覆盖。';
    }
  }
  write(value: T) {
    if (!this.key || this.pending || this.error) return false;
    try {
      const raw = localStorage.getItem(this.key);
      const current = raw ? (JSON.parse(raw) as LocalDraft<T>) : null;
      if ((current?.token ?? null) !== this.token) {
        this.error =
          '另一页面已更新本地草稿，当前文字仍保留在此页。请先复制当前文字。';
        return false;
      }
      const next: LocalDraft<T> = {
        format: 1,
        token: crypto.randomUUID(),
        savedAt: new Date().toISOString(),
        value,
      };
      localStorage.setItem(this.key, JSON.stringify(next));
      this.saved = next;
      this.token = next.token;
      return true;
    } catch {
      this.error = '本地暂存失败，请先复制文字；仍可尝试保存到服务器。';
      return false;
    }
  }
  clear() {
    if (!this.key) return;
    try {
      const raw = localStorage.getItem(this.key);
      if (raw && (JSON.parse(raw) as LocalDraft<T>).token !== this.token) {
        this.error = '另一页面已更新本地草稿，未删除其内容。';
        return;
      }
      localStorage.removeItem(this.key);
      this.saved = null;
      this.token = null;
      this.pending = false;
    } catch {
      this.error = '无法清除本地草稿，请保留当前文字。';
    }
  }
  resume() {
    this.pending = false;
  }
  hold() {
    this.pending = !!this.saved;
  }
}

export function useLocalDraft<T>(
  key: string | null,
  validate: (value: unknown) => value is T,
) {
  const session = useMemo(
    () => new DraftSession(key, validate),
    [key, validate],
  );
  const [, update] = useReducer((n: number) => n + 1, 0);
  const write = useCallback(
    (value: T) => {
      session.write(value);
      update();
    },
    [session],
  );
  const clear = useCallback(() => {
    session.clear();
    update();
  }, [session]);
  const resume = useCallback(() => {
    session.resume();
    update();
  }, [session]);
  const hold = useCallback(() => {
    session.hold();
    update();
  }, [session]);
  return {
    candidate: session.pending ? session.saved : null,
    session,
    write,
    clear,
    resume,
    hold,
    error: session.error,
  };
}

export function DraftRecovery({
  label = '草稿',
  savedAt,
  canRestore,
  preview,
  onRestore,
  onDiscard,
}: {
  label?: string;
  savedAt: string;
  canRestore: boolean;
  preview: string;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="draft-recovery" role="status">
      <p>
        {canRestore
          ? `此设备有未保存的${label}。`
          : '服务器内容或阶段已变化，本地稿仅供复制。'}{' '}
        <time>{new Date(savedAt).toLocaleString('zh-CN')}</time>
      </p>
      {canRestore && (
        <button type="button" onClick={onRestore}>
          继续编写本地稿
        </button>
      )}
      <details>
        <summary>查看本地稿</summary>
        <textarea aria-label="本地草稿全文" rows={8} readOnly value={preview} />
      </details>
      <button type="button" onClick={onDiscard}>
        丢弃本地稿
      </button>
    </div>
  );
}
