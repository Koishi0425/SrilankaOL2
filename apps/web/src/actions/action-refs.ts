import type { ActionObjectRef } from '@srilanka/contracts';

type DraftRef = Omit<ActionObjectRef, 'id'>;

export function mergeActionRefs(
  current: DraftRef[],
  incoming: DraftRef,
): DraftRef[] {
  const duplicate = current.some(
    (ref) =>
      ref.refKind === incoming.refKind &&
      ref.objectType === incoming.objectType &&
      ref.objectId === incoming.objectId,
  );
  return duplicate ? current : [...current, incoming];
}
