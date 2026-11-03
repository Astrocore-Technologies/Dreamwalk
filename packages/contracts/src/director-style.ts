import { z } from 'zod';

/** Presentation only. No arbitrary prompts, authority, budgets, or actor permissions. */
export const directorStyleSchema = z
  .object({
    style: z.enum(['natural', 'cinematic', 'atmospheric']),
    pacing: z.enum(['deliberate', 'balanced', 'brisk']),
    initiative: z.enum(['reactive', 'balanced', 'proactive']),
  })
  .strict();
export type DirectorStyle = z.infer<typeof directorStyleSchema>;
export const directorStyleSettingsSchema = directorStyleSchema
  .extend({
    revision: z.number().int().min(1).max(2147483647),
  })
  .strict();
export type DirectorStyleSettings = z.infer<typeof directorStyleSettingsSchema>;
export const directorStyleUpdateSchema = directorStyleSchema
  .extend({
    expectedRevision: z.number().int().min(1).max(2147483646),
  })
  .strict();
export const DEFAULT_DIRECTOR_STYLE: DirectorStyleSettings = {
  revision: 1,
  style: 'natural',
  pacing: 'balanced',
  initiative: 'balanced',
};
export const DIRECTOR_STYLE_PRESETS = {
  coauthor: { style: 'natural', pacing: 'balanced', initiative: 'balanced' },
  storyteller: { style: 'atmospheric', pacing: 'deliberate', initiative: 'reactive' },
  director: { style: 'cinematic', pacing: 'brisk', initiative: 'proactive' },
} as const satisfies Record<string, DirectorStyle>;
