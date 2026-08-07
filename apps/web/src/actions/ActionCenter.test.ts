import { describe, expect, it } from 'vitest';

import {
  applyMapSeedToDraft,
  editableFieldsFromVersion,
  mergeActionRefs,
  type ActionDraftSeed,
} from './ActionCenter.js';

const firstTarget: ActionDraftSeed['ref'] = {
  refKind: 'Target',
  objectType: 'Tile',
  objectId: '00000000-0000-4000-8000-000000000101',
  label: '北部平原（坐标 4,7 · 平原 · 由康提控制）',
};

describe('map action draft helpers', () => {
  it('keeps existing policy text when a map target is added', () => {
    const result = applyMapSeedToDraft(
      {
        title: '北境屯田政策',
        text: '先修复灌溉设施，再逐步迁入农户。',
        category: 'Policy',
        refs: [],
      },
      { key: 1, title: '地图默认标题', ref: firstTarget },
    );

    expect(result.title).toBe('北境屯田政策');
    expect(result.text).toBe('先修复灌溉设施，再逐步迁入农户。');
    expect(result.refs).toEqual([firstTarget]);
  });

  it('does not add the same map target twice', () => {
    const current = [firstTarget];

    expect(mergeActionRefs(current, firstTarget)).toBe(current);
  });

  it('uses map context for an empty custom draft', () => {
    const result = applyMapSeedToDraft(
      { title: '', text: '', category: 'Custom', refs: [] },
      { key: 2, title: '关于北部平原的政策 / 行动', ref: firstTarget },
    );

    expect(result.title).toBe('关于北部平原的政策 / 行动');
    expect(result.category).toBe('Policy');
    expect(result.refs[0]?.label).toContain('坐标 4,7');
  });

  it('loads editable fields from an earlier version', () => {
    expect(
      editableFieldsFromVersion({
        version: 2,
        title: '旧版屯田政策',
        originalText: '保留旧版正文。',
        category: 'Policy',
        secrecy: 'OwnerOnly',
        createdAt: '2026-08-07T00:00:00.000Z',
      }),
    ).toEqual({
      title: '旧版屯田政策',
      text: '保留旧版正文。',
      category: 'Policy',
      secrecy: 'OwnerOnly',
    });
  });
});
