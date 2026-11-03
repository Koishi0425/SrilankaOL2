import type { RoundPolicySectionInput } from '@srilanka/contracts';

// Compare editable content only; formal sections also carry review metadata.
export function samePolicySections(
  left: RoundPolicySectionInput[],
  right: RoundPolicySectionInput[],
): boolean {
  const content = (sections: RoundPolicySectionInput[]) =>
    sections.map(({ id, title, text, category, secrecy, refs }) => ({
      id,
      title,
      text,
      category,
      secrecy,
      // Storage may return references in a different order. Canonicalize only
      // this collection, leaving policy section order and inputs untouched.
      refs: refs
        .map(({ refKind, objectType, objectId, label }) =>
          JSON.stringify([refKind, objectType, objectId, label]),
        )
        .sort(),
    }));
  return JSON.stringify(content(left)) === JSON.stringify(content(right));
}
