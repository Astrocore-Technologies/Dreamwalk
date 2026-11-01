import type { PoolClient } from 'pg';
/** Acquire only AFTER the target financial row (shared scope or legacy provider budget). While held, never lock another scope/authorization.
 * Serializes first owner policy with legacy cross-scope admission, not provider execution. */
export async function fenceGenerationAdmission(c: PoolClient) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'generation-scope-admission',
  ]);
}
