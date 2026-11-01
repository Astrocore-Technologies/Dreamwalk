import { z } from 'zod';
import { controlledTagSchema } from './index';

export const genreDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
    value: z.string().trim().min(2).max(40),
    labels: z
      .object({
        uk: z.string().trim().min(1).max(40),
        en: z.string().trim().min(1).max(40),
        ru: z.string().trim().min(1).max(40),
      })
      .strict(),
  })
  .strict();
export type GenreDefinition = z.infer<typeof genreDefinitionSchema>;
const fields = {
  genres: z.array(z.string().trim().min(2).max(40)).min(1).max(50),
  tags: z.array(controlledTagSchema).max(100),
  genreDefinitions: z.array(genreDefinitionSchema).max(1000),
  revision: z.number().int().nonnegative(),
};
export const taxonomySchema = z
  .object(fields)
  .strict()
  .superRefine((data, ctx) => {
    const ids = new Set(data.genreDefinitions.map((g) => g.id));
    const values = new Set(data.genreDefinitions.map((g) => g.value));
    if (ids.size !== data.genreDefinitions.length || values.size !== data.genreDefinitions.length)
      ctx.addIssue({
        code: 'custom',
        path: ['genreDefinitions'],
        message: 'Genre IDs and values must be unique.',
      });
    if (
      new Set(data.genres).size !== data.genres.length ||
      data.genres.some((value) => !values.has(value))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['genres'],
        message: 'Every distinct active genre requires a definition.',
      });
  });
export type Taxonomy = z.infer<typeof taxonomySchema>;
export const taxonomyUpdateSchema = z
  .object({
    ...fields,
    genreDefinitions: fields.genreDefinitions.optional(),
    revision: fields.revision.optional(),
    expectedRevision: fields.revision.optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.genreDefinitions === undefined ||
      data.expectedRevision !== undefined ||
      data.revision !== undefined,
    {
      path: ['expectedRevision'],
      message: 'Genre metadata updates require a revision precondition.',
    },
  );
export type TaxonomyUpdate = z.infer<typeof taxonomyUpdateSchema>;
