import { z } from 'zod';
/** Explicit author choice only; never infer a gender from names or descriptions. */
export const npcPlaceholderSchema = z.enum(['neutral', 'male', 'female', 'crowd']);
export type NpcPlaceholder = z.infer<typeof npcPlaceholderSchema>;
