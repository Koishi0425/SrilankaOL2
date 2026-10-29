import type { RoundPolicySectionInput } from '@srilanka/contracts';
import { categories, categoryName } from './action-labels.js';

export type RemovedPolicySection = {
  section: RoundPolicySectionInput;
  index: number;
  beforeId?: string;
  afterId?: string;
};
export type LocalPolicy = {
  revision: string;
  countryId: string;
  sections: RoundPolicySectionInput[];
  removedSections?: RemovedPolicySection[];
};
function isSection(value: unknown): value is RoundPolicySectionInput {
  if (!value || typeof value !== 'object') return false;
  const s = value as RoundPolicySectionInput;
  return (
    typeof s.id === 'string' &&
    typeof s.title === 'string' &&
    typeof s.text === 'string' &&
    categories.some(([key]) => key === s.category) &&
    ['OwnerOnly', 'Participants', 'Public'].includes(s.secrecy) &&
    Array.isArray(s.refs) &&
    s.refs.every(
      (r) =>
        r &&
        typeof r.objectId === 'string' &&
        typeof r.label === 'string' &&
        ['Actor', 'Target', 'Context'].includes(r.refKind) &&
        [
          'Tile',
          'City',
          'Army',
          'Country',
          'Character',
          'Region',
          'Province',
        ].includes(r.objectType),
    )
  );
}
export function isLocalPolicy(value: unknown): value is LocalPolicy {
  if (!value || typeof value !== 'object') return false;
  const v = value as LocalPolicy;
  return (
    typeof v.revision === 'string' &&
    typeof v.countryId === 'string' &&
    Array.isArray(v.sections) &&
    v.sections.every(isSection) &&
    (v.removedSections === undefined ||
      (Array.isArray(v.removedSections) &&
        v.removedSections.every(
          (r) =>
            r &&
            Number.isInteger(r.index) &&
            r.index >= 0 &&
            isSection(r.section) &&
            (r.beforeId === undefined || typeof r.beforeId === 'string') &&
            (r.afterId === undefined || typeof r.afterId === 'string'),
        )))
  );
}
export function policyDraftPreview(value: LocalPolicy) {
  const text = (s: RoundPolicySectionInput) =>
    [
      s.title || '未命名分项',
      `参考分类：${categoryName(s.category)}`,
      s.text,
      ...s.refs.map((r) => `关联：${r.label}`),
    ].join('\n');
  return [
    ...value.sections.map(text),
    ...(value.removedSections ?? []).map(
      (r) => `已移除、尚可撤销的分项：\n${text(r.section)}`,
    ),
  ].join('\n\n');
}
