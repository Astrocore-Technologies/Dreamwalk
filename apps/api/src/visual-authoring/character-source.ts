import type { PoolClient } from 'pg';
import { z } from 'zod';
import { fail } from '../errors';
import { visualDigest } from './fingerprint';
export const characterTargetSchema = z
  .object({ kind: z.enum(['npc', 'hero']), id: z.uuid() })
  .strict();
/** Deliberate visual allowlist. Biography, secrets, backstory and notes never enter the image brief. */
export async function readCharacterVisualSource(
  c: PoolClient,
  owner: string,
  target: { kind: 'npc' | 'hero'; id: string },
) {
  const table = target.kind === 'npc' ? 'npcs' : 'heroes';
  const row = (
    await c.query('SELECT data FROM ' + table + ' WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
      z.uuid().parse(target.id),
      owner,
    ])
  ).rows[0];
  if (!row) fail(404, 'NOT_FOUND', 'NOT_FOUND');
  const source = {
    name: typeof row.data.name === 'string' ? row.data.name : '',
    appearance: typeof row.data.appearance === 'string' ? row.data.appearance : '',
    portraitAssetId: typeof row.data.portraitAssetId === 'string' ? row.data.portraitAssetId : null,
    packageVersionId: row.data.characterPackageVersionId ?? null,
  };
  return { ...source, hash: visualDigest(source) };
}
