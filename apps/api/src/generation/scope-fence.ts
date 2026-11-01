import type { PoolClient } from 'pg';
/** Acquire only AFTER the target financial row (shared scope or legacy provider budget). While held, never lock another scope/authorization.
 * Serializes first claim and reviewed policy amendments with legacy cross-scope admission.
 * The caller checks the persisted active revision under its already-held financial row before dispatch.
 * Parent authorization nonkey writes use NO KEY UPDATE so implicit job FK KEY SHARE remains compatible. */
export async function fenceGenerationAdmission(c: PoolClient) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'generation-scope-admission',
  ]);
}
