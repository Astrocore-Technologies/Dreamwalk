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

export const directorProfileIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const directorProfileSchema = directorStyleSchema
  .extend({
    id: directorProfileIdSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300),
    enabled: z.boolean(),
  })
  .strict();
export type DirectorProfile = z.infer<typeof directorProfileSchema>;
const catalogFields = {
  defaultProfileId: directorProfileIdSchema,
  profiles: z.array(directorProfileSchema).min(1).max(24),
};
function validCatalog(value: { defaultProfileId: string; profiles: DirectorProfile[] }) {
  return (
    new Set(value.profiles.map((profile) => profile.id)).size === value.profiles.length &&
    value.profiles.some((profile) => profile.id === value.defaultProfileId && profile.enabled)
  );
}
export const directorCatalogSchema = z
  .object({
    ...catalogFields,
    revision: z.number().int().min(1).max(2147483647),
  })
  .strict()
  .refine(validCatalog, 'Unique profiles and an enabled default are required');
export const directorCatalogUpdateSchema = z
  .object({
    ...catalogFields,
    expectedRevision: z.number().int().min(1).max(2147483646),
  })
  .strict()
  .refine(validCatalog, 'Unique profiles and an enabled default are required');
export type DirectorCatalog = z.infer<typeof directorCatalogSchema>;
export type CampaignDirectorSelection = {
  profileId: string;
  revision: number;
  profile: DirectorProfile;
  canChange: boolean;
};
export const campaignDirectorUpdateSchema = z
  .object({
    profileId: directorProfileIdSchema,
    expectedRevision: z.number().int().min(1).max(2147483646),
  })
  .strict();
export function defaultDirectorCatalog(
  style: DirectorStyleSettings = DEFAULT_DIRECTOR_STYLE,
): DirectorCatalog {
  return {
    revision: style.revision,
    defaultProfileId: 'coauthor',
    profiles: [
      {
        id: 'coauthor',
        name: 'Соавтор',
        description: '',
        enabled: true,
        style: style.style,
        pacing: style.pacing,
        initiative: style.initiative,
      },
      {
        id: 'storyteller',
        name: 'Рассказчик',
        description: '',
        enabled: true,
        ...DIRECTOR_STYLE_PRESETS.storyteller,
      },
      {
        id: 'director',
        name: 'Режиссёр',
        description: '',
        enabled: true,
        ...DIRECTOR_STYLE_PRESETS.director,
      },
    ],
  };
}
