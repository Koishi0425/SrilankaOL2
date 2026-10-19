import { useState } from 'react';
import type { ActionObjectRef } from '@srilanka/contracts';
export type MapActionReference = Omit<ActionObjectRef, 'id'>;
export function ActionMapLinks({
  refs = [],
  onLocate,
}: {
  refs?: MapActionReference[];
  onLocate?: (ref: MapActionReference) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const targets = refs.filter(
    (ref) => ref.objectType === 'Province' || ref.objectType === 'Tile',
  );
  if (!targets.length || !onLocate) return null;
  async function locate(ref: MapActionReference) {
    setPending(true);
    setError('');
    try {
      await onLocate?.(ref);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '地图定位失败');
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="action-map-links" aria-label="关联地图目标">
      {targets.map((ref) => (
        <button
          type="button"
          disabled={pending}
          key={`${ref.refKind}:${ref.objectType}:${ref.objectId}`}
          title="在地图上查看"
          onClick={() => void locate(ref)}
        >
          {ref.label ||
            (ref.objectType === 'Province' ? '关联省份' : '关联地块')}
        </button>
      ))}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
