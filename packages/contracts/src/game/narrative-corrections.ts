import { z } from 'zod';

/** Presentation preferences are not executable instructions or changes to world canon. */
export const narrativeSettingsSchema = z
  .object({
    detail: z.enum(['concise', 'balanced', 'descriptive']).default('balanced'),
    formOfAddress: z.enum(['character', 'she', 'he', 'they']).default('character'),
    dialogueFormat: z.enum(['natural', 'quoted']).default('natural'),
  })
  .strict();
export type NarrativeSettings = z.infer<typeof narrativeSettingsSchema>;
export const narrativePreferencesSchema = z
  .object({
    revision: z.number().int().min(0),
    settings: narrativeSettingsSchema,
  })
  .strict();
export type NarrativePreferences = z.infer<typeof narrativePreferencesSchema>;
export const narrativePreferencesUpdateSchema = z
  .object({
    operationId: z.uuid(),
    expectedRevision: z.number().int().min(0),
    settings: narrativeSettingsSchema,
  })
  .strict();
export type NarrativePreferencesUpdate = z.infer<typeof narrativePreferencesUpdateSchema>;
export function readNarrativePreferences(
  state: { narrativePreferences?: Record<string, NarrativePreferences> },
  actorId: string,
): NarrativePreferences {
  return narrativePreferencesSchema.parse(
    state.narrativePreferences?.[actorId] ?? { revision: 0, settings: {} },
  );
}
