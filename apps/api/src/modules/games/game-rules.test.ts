import { describe, expect, it } from 'vitest';

import {
  actionCategorySchema,
  quarterRulesSchema,
  readGameRules,
  updateGameRulesSchema,
} from './game-rules.js';

describe('flexible scenario rules', () => {
  it('keeps existing games open ended until the host sets rules', () => {
    const rules = readGameRules('quarter-id', { unrelated: true }, {});
    expect(rules.version).toBe(1);
    expect(rules.scenario.playerPerspective).toBe('Flexible');
    expect(rules.quarter.suggestedLimits).toEqual([]);
    expect(actionCategorySchema.parse('Exploration')).toBe('Exploration');
  });

  it('accepts zero allowances but rejects conflicting or invalid allowances', () => {
    expect(
      quarterRulesSchema.parse({
        suggestedLimits: [{ category: 'Military', limit: 0 }],
      }).suggestedLimits[0]?.limit,
    ).toBe(0);
    for (const suggestedLimits of [
      [
        { category: 'Military', limit: 1 },
        { category: 'Military', limit: 2 },
      ],
      [{ category: 'Military', limit: -1 }],
      [{ category: 'Military', limit: 1.5 }],
      [{ category: 'Unknown', limit: 1 }],
    ]) {
      expect(quarterRulesSchema.safeParse({ suggestedLimits }).success).toBe(
        false,
      );
    }
  });

  it('requires a current quarter and revision when saving', () => {
    const input = {
      quarterId: '00000000-0000-4000-8000-000000000001',
      expectedVersion: 2,
      scenario: { title: '诸国时代', playerPerspective: 'CountryWill' },
      quarter: {},
    };
    expect(updateGameRulesSchema.parse(input).scenario.playerPerspective).toBe(
      'CountryWill',
    );
    expect(
      updateGameRulesSchema.safeParse({ ...input, expectedVersion: 0 }).success,
    ).toBe(false);
    expect(
      updateGameRulesSchema.safeParse({
        ...input,
        scenario: { premise: 'x'.repeat(10_001) },
      }).success,
    ).toBe(false);
  });
});
