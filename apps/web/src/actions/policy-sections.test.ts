import { expect, it } from 'vitest';
import type { RoundPolicySectionInput } from '@srilanka/contracts';
import { samePolicySections } from './policy-sections.js';

const section: RoundPolicySectionInput = {
  id: 'one',
  title: '探索计划',
  text: '沿河调查',
  category: 'Exploration',
  secrecy: 'OwnerOnly',
  refs: [
    { refKind: 'Target', objectType: 'Tile', objectId: 'east', label: '东岸' },
    {
      refKind: 'Context',
      objectType: 'Province',
      objectId: 'west',
      label: '西省',
    },
  ],
};

it('ignores reference order while preserving both inputs and reference multiplicity', () => {
  const reversed = { ...section, refs: [...section.refs].reverse() };
  const before = JSON.stringify([section, reversed]);
  expect(samePolicySections([section], [reversed])).toBe(true);
  expect(JSON.stringify([section, reversed])).toBe(before);
  expect(
    samePolicySections(
      [section],
      [{ ...reversed, refs: [...reversed.refs, reversed.refs[0]!] }],
    ),
  ).toBe(false);
});

it('keeps policy section order meaningful even when the same sections and targets are present', () => {
  const second = { ...section, id: 'two', title: '第二项' };
  expect(samePolicySections([section, second], [second, section])).toBe(false);
});

it.each([
  { refKind: 'Actor' as const },
  { objectType: 'Province' as const },
  { objectId: 'another-tile' },
  { label: '重新命名的目标' },
])('still detects a reference content change: %j', (patch) => {
  const changed = {
    ...section,
    refs: [{ ...section.refs[0]!, ...patch }, section.refs[1]!],
  };
  expect(samePolicySections([section], [changed])).toBe(false);
});
