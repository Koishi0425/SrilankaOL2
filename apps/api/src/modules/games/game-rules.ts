import { z } from 'zod';

import type { GameRulesData } from '@srilanka/contracts';

export const actionCategorySchema = z.enum([
  'Exploration',
  'EventResponse',
  'Policy',
  'Reform',
  'Diplomacy',
  'Construction',
  'Research',
  'Recruitment',
  'Military',
  'Intelligence',
  'Custom',
]);

export const scenarioRulesSchema = z.object({
  title: z.string().trim().max(120).default(''),
  playerPerspective: z
    .enum(['CountryWill', 'Character', 'Flexible'])
    .default('Flexible'),
  premise: z.string().max(10_000).default(''),
  commonRules: z.string().max(20_000).default(''),
});

export const quarterRulesSchema = z
  .object({
    briefing: z.string().max(10_000).default(''),
    actionGuidelines: z.string().max(20_000).default(''),
    suggestedLimits: z
      .array(
        z.object({
          category: actionCategorySchema,
          limit: z.number().int().min(0).max(100),
        }),
      )
      .max(11)
      .default([]),
  })
  .refine(
    (rules) =>
      new Set(rules.suggestedLimits.map((item) => item.category)).size ===
      rules.suggestedLimits.length,
    '同一行动类别只能设置一项建议额度。',
  );

export const updateGameRulesSchema = z.object({
  quarterId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  scenario: scenarioRulesSchema,
  quarter: quarterRulesSchema,
});

export function readGameRules(
  quarterId: string,
  config: Record<string, unknown>,
  quarterRules: unknown,
): GameRulesData {
  return {
    quarterId,
    version: z
      .number()
      .int()
      .positive()
      .parse(config.rulesVersion ?? 1),
    scenario: scenarioRulesSchema.parse(config.scenario ?? {}),
    quarter: quarterRulesSchema.parse(quarterRules ?? {}),
  };
}
