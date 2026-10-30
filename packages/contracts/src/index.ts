import { z } from 'zod';
export const idSchema = z.string().uuid();
const text = (max = 1000) => z.string().trim().max(max);
export const localeSchema = z.enum(['uk', 'en', 'ru']);
export type Locale = z.infer<typeof localeSchema>;
export const metadataTranslationSchema = z
  .object({
    title: text(120).optional(),
    synopsis: text(4000).optional(),
    tags: z
      .record(z.string().trim().min(1).max(40), text(40))
      .refine((v) => Object.keys(v).length <= 12)
      .optional(),
    sourceRevision: z.number().int().min(1),
  })
  .strict();
export const metadataTranslationsSchema = z
  .object({
    uk: metadataTranslationSchema.optional(),
    en: metadataTranslationSchema.optional(),
    ru: metadataTranslationSchema.optional(),
  })
  .strict();
export type MetadataTranslations = z.infer<typeof metadataTranslationsSchema>;
export interface AdventureMetadata {
  title: string;
  synopsis: string;
  sourceLanguage?: Locale;
  sourceRevision?: number;
  translations?: MetadataTranslations;
}
export function selectAdventureText(adventure: AdventureMetadata, locale: Locale) {
  const sourceLanguage = adventure.sourceLanguage ?? 'ru';
  const sourceRevision = adventure.sourceRevision ?? 1;
  const entry = adventure.translations?.[locale];
  const valid = entry?.sourceRevision === sourceRevision;
  const translatedTitle = valid ? entry?.title?.trim() : undefined;
  const translatedSynopsis = valid ? entry?.synopsis?.trim() : undefined;
  const translationStatus: 'disabled' | 'ready' | 'stale' =
    entry && !valid ? 'stale' : translatedTitle || translatedSynopsis ? 'ready' : 'disabled';
  return {
    title: translatedTitle || adventure.title,
    synopsis: translatedSynopsis || adventure.synopsis,
    sourceLanguage,
    translationStatus,
    isFallback: locale !== sourceLanguage && (!translatedTitle || !translatedSynopsis),
  };
}
/** Stale text stays in author storage but is never served in reader DTOs. */
export function safeAdventureMetadata(adventure: AdventureMetadata): AdventureMetadata {
  const sourceRevision = adventure.sourceRevision ?? 1;
  const translations: MetadataTranslations = {};
  for (const locale of ['uk', 'en', 'ru'] as const) {
    const entry = adventure.translations?.[locale];
    if (entry)
      translations[locale] =
        entry.sourceRevision === sourceRevision ? entry : { sourceRevision: entry.sourceRevision };
  }
  return {
    title: adventure.title,
    synopsis: adventure.synopsis,
    sourceLanguage: adventure.sourceLanguage ?? 'ru',
    sourceRevision,
    translations,
  };
}
export const controlledTagSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
    labels: z.object({ uk: text(40).min(1), en: text(40).min(1), ru: text(40).min(1) }).strict(),
    aliases: z.array(text(40).min(1)).max(20).default([]),
  })
  .strict();
export type ControlledTag = z.infer<typeof controlledTagSchema>;
export function findControlledTag(value: string, definitions: ControlledTag[]) {
  return definitions.find((tag) => tag.id === value || tag.aliases.includes(value));
}
export function selectAdventureTags(
  adventure: { tags: string[]; sourceRevision?: number; translations?: MetadataTranslations },
  locale: Locale,
  definitions: ControlledTag[],
): string[] {
  const translation = adventure.translations?.[locale];
  const valid = translation?.sourceRevision === (adventure.sourceRevision ?? 1);
  return adventure.tags.map(
    (original) =>
      findControlledTag(original, definitions)?.labels[locale] ||
      (valid ? translation?.tags?.[original]?.trim() : undefined) ||
      original,
  );
}
export const settingsSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  language: z.enum(['uk', 'en', 'ru']).default('ru'),
  timezone: text(100)
    .refine(
      (value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      },
      { message: 'INVALID_TIMEZONE' },
    )
    .default('UTC'),
  notifications: z.boolean().default(true),
  emailNotifications: z.boolean().default(false),
  reducedMotion: z.boolean().default(false),
  profilePublic: z.boolean().default(true),
  defaultVisibility: z.enum(['private', 'public']).default('private'),
  genres: z.array(text(50)).max(12).default([]),
  purpose: z.enum(['play', 'create', 'both']).default('both'),
  replyLength: z.enum(['short', 'balanced', 'long']).default('balanced'),
  animationSpeed: z.enum(['normal', 'slow', 'none']).default('normal'),
  costHints: z.boolean().default(true),
  confirmExpensive: z.boolean().default(true),
  publicationNotifications: z.boolean().default(true),
  reportNotifications: z.boolean().default(true),
});
export type Settings = z.infer<typeof settingsSchema>;
export interface User {
  emailVerified: boolean;
  id: string;
  email: string;
  name: string;
  handle: string;
  bio: string;
  avatarAssetId: string | null;
  role: 'user' | 'admin';
  onboarded: boolean;
  settings: Settings;
  createdAt: string;
}
export const registerSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    password: z.string().min(10).max(128),
    name: text(60).min(2),
    handle: z.string().regex(/^[a-z0-9_]{3,30}$/),
  })
  .strict();
export const loginSchema = registerSchema.pick({ email: true, password: true });
export const profileSchema = z
  .object({
    name: text(60).min(2).optional(),
    handle: z
      .string()
      .regex(/^[a-z0-9_]{3,30}$/)
      .optional(),
    bio: text(2000).optional(),
    avatarAssetId: idSchema.nullable().optional(),
  })
  .strict();
export const heroSchema = z
  .object({
    name: text(80).min(2),
    portraitAssetId: idSchema.nullable().default(null),
    backstory: text(6000).default(''),
    notes: text(6000).default(''),
    traits: z.array(text(80)).max(12).default([]),
  })
  .strict();
export type Hero = z.infer<typeof heroSchema> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};
export const npcTextFields = [
  'name',
  'description',
  'role',
  'personality',
  'appearance',
  'greeting',
] as const;
export const npcTranslationSchema = z
  .object({
    name: text(80).optional(),
    description: text(4000).optional(),
    role: text(120).optional(),
    personality: text(4000).optional(),
    appearance: text(4000).optional(),
    greeting: text(2000).optional(),
    sourceRevision: z.number().int().min(1),
  })
  .strict();
export const npcTranslationsSchema = z
  .object({
    uk: npcTranslationSchema.optional(),
    en: npcTranslationSchema.optional(),
    ru: npcTranslationSchema.optional(),
  })
  .strict();
export interface NpcMetadata {
  name: string;
  description?: string;
  role?: string;
  personality?: string;
  appearance?: string;
  greeting?: string;
  sourceLanguage?: Locale;
  sourceRevision?: number;
  translations?: z.infer<typeof npcTranslationsSchema>;
}
export function selectNpcText(npc: NpcMetadata, locale: Locale) {
  const entry = npc.translations?.[locale],
    valid = entry?.sourceRevision === (npc.sourceRevision ?? 1);
  const result = Object.fromEntries(
    npcTextFields.map((field) => [
      field,
      (valid ? entry?.[field]?.trim() : undefined) || npc[field] || '',
    ]),
  ) as Record<(typeof npcTextFields)[number], string>;
  return {
    ...result,
    sourceLanguage: npc.sourceLanguage ?? 'ru',
    translationStatus:
      entry && !valid
        ? 'stale'
        : valid && npcTextFields.some((f) => entry?.[f]?.trim())
          ? 'ready'
          : 'disabled',
    isFallback:
      locale !== (npc.sourceLanguage ?? 'ru') &&
      npcTextFields.some((f) => npc[f] && (!valid || !entry?.[f]?.trim())),
  };
}
export function safeNpcMetadata(npc: NpcMetadata): NpcMetadata {
  const translations: z.infer<typeof npcTranslationsSchema> = {};
  for (const locale of ['uk', 'en', 'ru'] as const) {
    const entry = npc.translations?.[locale];
    if (entry)
      translations[locale] =
        entry.sourceRevision === (npc.sourceRevision ?? 1)
          ? entry
          : { sourceRevision: entry.sourceRevision };
  }
  return {
    ...Object.fromEntries(npcTextFields.map((field) => [field, npc[field] ?? ''])),
    name: npc.name,
    sourceLanguage: npc.sourceLanguage ?? 'ru',
    sourceRevision: npc.sourceRevision ?? 1,
    translations,
  };
}
export const npcSchema = z
  .object({
    description: text(4000).default(''),
    sourceLanguage: localeSchema.default('ru'),
    sourceRevision: z.number().int().min(1).default(1),
    translations: npcTranslationsSchema.default({}),
    name: text(80).min(2),
    age: z.number().int().min(18).max(10000).default(25),
    role: text(120).default(''),
    personality: text(4000).default(''),
    appearance: text(4000).default(''),
    biography: text(6000).default(''),
    secrets: text(6000).default(''),
    greeting: text(2000).default(''),
    modelProfileId: idSchema.nullable().default(null),
    visibility: z.literal('private').default('private'),
    portraitAssetId: idSchema.nullable().default(null),
  })
  .strict();
export type Npc = z.infer<typeof npcSchema> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};
export const locationSchema = z.object({
  id: text(80).min(1),
  name: text(120).min(1),
  description: text(6000).default(''),
});
export const sceneSchema = z.object({
  id: text(80).min(1),
  name: text(120).min(1),
  locationId: text(80).min(1),
  description: text(6000).default(''),
});
export const contentSchema = z.object({
  world: text(12000).default(''),
  rules: text(8000).default(''),
  locations: z.array(locationSchema).max(30).default([]),
  npcIds: z.array(idSchema).max(30).default([]),
  scenes: z.array(sceneSchema).max(50).default([]),
  startSceneId: text(80).default(''),
  boundaries: z.array(text(120)).max(20).default([]),
});
export const adventureSchema = z
  .object({
    title: text(120).min(2),
    sourceLanguage: localeSchema.default('ru'),
    sourceRevision: z.number().int().min(1).default(1),
    translations: metadataTranslationsSchema.default({}),
    synopsis: text(4000).default(''),
    genre: text(50).default('Тайна'),
    tags: z.array(text(40)).max(12).default([]),
    cover: z.enum(['observatory', 'forest', 'sea', 'city']).default('observatory'),
    coverAssetId: idSchema.nullable().default(null),
    playersMin: z.number().int().min(1).max(4).default(1),
    playersMax: z.number().int().min(1).max(4).default(4),
    duration: text(80).default('1–2 часа'),
    difficulty: z.enum(['Легко', 'Средне', 'Сложно']).default('Средне'),
    status: z.enum(['draft', 'pending_review', 'published', 'archived']).default('draft'),
    visibility: z.enum(['private', 'public']).default('private'),
    content: contentSchema.default(() => contentSchema.parse({})),
  })
  .strict();
export type Adventure = z.infer<typeof adventureSchema> & {
  access?: 'owner' | 'invited' | 'public' | 'reviewer';
  readOnly?: boolean;
  id: string;
  ownerId: string;
  slug: string;
  version: number;
  author: {
    name: string;
    handle: string;
  };
  createdAt: string;
  updatedAt: string;
  favoriteCount: number;
  versions?: {
    id: string;
    version: number;
    createdAt: string;
  }[];
  npcs?: Omit<Npc, 'secrets'>[];
};
export const modelSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9_]{2,40}$/),
    name: text(80).min(2),
    description: text(2000),
    instructions: text(8000),
    enabled: z.boolean().default(true),
  })
  .strict();
export type ModelProfile = z.infer<typeof modelSchema> & {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};
export const runtimeSchema = z
  .object({
    name: text(80).min(2),
    provider: z.enum(['mock', 'openai', 'local']),
    model: text(120).min(1),
    enabled: z.boolean().default(false),
    endpointId: z.enum(['mock', 'openai', 'local']),
    maxInputTokens: z.number().int().min(128).max(200000).default(16000),
    maxOutputTokens: z.number().int().min(64).max(16000).default(2000),
    timeoutMs: z.number().int().min(1000).max(120000).default(30000),
    concurrency: z.number().int().min(1).max(10).default(1),
  })
  .strict();
export type RuntimeProfile = z.infer<typeof runtimeSchema> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};
export interface LedgerEntry {
  id: string;
  amount: number;
  reason: string;
  sourceKey: string;
  createdAt: string;
}
export interface Wallet {
  balance: number;
  mode: 'demo';
  ledger: LedgerEntry[];
}
export interface Asset {
  id: string;
  url: string;
  width: number;
  height: number;
  mime: string;
  createdAt: string;
}
export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
}
/** Zod defaults are intentional on create, never on PATCH. Preserve only supplied keys. */
export function parsePatch<T extends Record<string, unknown>>(
  schema: z.ZodType<T>,
  input: unknown,
): Partial<T> {
  const parsed = schema.parse(input);
  const supplied = input as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(parsed).filter(([key]) => Object.prototype.hasOwnProperty.call(supplied, key)),
  ) as Partial<T>;
}

export interface Invitation {
  id: string;
  adventureId: string;
  adventureSlug: string;
  adventureTitle: string;
  adventureMetadata?: AdventureMetadata;
  owner: { id: string; name: string; handle: string };
  recipient: { id: string; name: string; handle: string };
  status: 'pending' | 'accepted' | 'declined' | 'revoked';
  createdAt: string;
  updatedAt: string;
}
