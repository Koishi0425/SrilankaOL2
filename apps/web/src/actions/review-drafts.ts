import { useMemo, useReducer } from 'react';
import type { RoundPolicy } from '@srilanka/contracts';
import { DraftSession, useDraftKey } from '../drafts/local-drafts.js';

type ReviewText = { revision: string; reason: string; interpretation: string };
type ReviewRecord = {
  session: DraftSession<ReviewText>;
  buffer: ReviewText | null;
  updatedAt: string;
};
const valid = (value: unknown): value is ReviewText => {
  if (!value || typeof value !== 'object') return false;
  const v = value as ReviewText;
  return (
    typeof v.revision === 'string' &&
    typeof v.reason === 'string' &&
    typeof v.interpretation === 'string'
  );
};
const hasText = (v: ReviewText | null | undefined) =>
  !!(v?.reason || v?.interpretation);

export function useReviewDrafts(
  gameId: string,
  policy: RoundPolicy | null,
  allowed: boolean,
) {
  const scope = useDraftKey(gameId, '', 'round-review', '');
  const key = useDraftKey(
    gameId,
    policy?.quarterId ?? '',
    'round-review',
    policy ? `${policy.memberId}:${policy.countryId}` : '',
  );
  // Cache sessions across policy switches so another tab's newer token is not adopted silently.
  const records = useMemo(
    () => new Map<string, ReviewRecord>(),
    [scope, allowed],
  );
  const [, update] = useReducer((n) => n + 1, 0);
  let record: ReviewRecord | null = null;
  if (allowed && policy) {
    const identity =
      key ??
      `${gameId}:${policy.quarterId}:${policy.memberId}:${policy.countryId}`;
    record = records.get(identity) ?? null;
    if (!record) {
      record = {
        session: new DraftSession(key, valid),
        buffer: null,
        updatedAt: '',
      };
      records.set(identity, record);
    }
  }
  const candidate = record?.session.pending
    ? record.session.saved
    : record?.buffer && record.buffer.revision !== policy?.revision
      ? { value: record.buffer, savedAt: record.updatedAt }
      : null;
  const note = (!candidate && record?.buffer) || {
    revision: policy?.revision ?? '',
    reason: '',
    interpretation: '',
  };

  function store(next: ReviewText) {
    if (!record) return;
    record.buffer = next;
    record.updatedAt = new Date().toISOString();
    if (hasText(next)) record.session.write(next);
    else record.session.clear();
    update();
  }
  return {
    note,
    candidate,
    error: record?.session.error ?? '',
    savedAt:
      record?.buffer && record.session.saved?.value === record.buffer
        ? record.session.saved.savedAt
        : null,
    hasCurrentText: hasText(record?.buffer) || !!candidate,
    hasUnsubmitted:
      allowed &&
      [...records.values()].some(
        (r) => hasText(r.buffer) || hasText(r.session.saved?.value),
      ),
    change(field: 'reason' | 'interpretation', text: string) {
      if (!policy || !record || candidate) return;
      store({ ...note, revision: policy.revision, [field]: text });
    },
    restore() {
      if (
        !record ||
        !policy ||
        !candidate ||
        candidate.value.revision !== policy.revision
      )
        return;
      record.session.resume();
      record.buffer = candidate.value;
      record.updatedAt = candidate.savedAt;
      update();
    },
    discard() {
      if (!record) return;
      record.session.clear();
      if (!record.session.saved) record.buffer = null;
      update();
    },
    submitted(field: 'reason' | 'interpretation', revision: string) {
      // A successful opinion must not discard an unsent explanation, and vice versa.
      store({ ...note, revision, [field]: '' });
    },
  };
}
