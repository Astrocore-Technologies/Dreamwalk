import { createHash } from 'node:crypto';

/** Git/Windows may change line endings without changing migration text. */
export function canonicalMigrationSql(sql: string): string {
  return sql.replace(/\r\n/g, '\n');
}

export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/** Verify exact historical bytes; never rewrite an existing ledger checksum. */
export function matchesMigrationChecksum(sql: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expected)) return false;
  const lf = canonicalMigrationSql(sql);
  const candidates = [sql, lf, lf.replace(/\n/g, '\r\n')];
  // An earlier Windows append produced LF content with one final CRLF (migration 035).
  if (lf.endsWith('\n')) candidates.push(lf.slice(0, -1) + '\r\n');
  return candidates.some((candidate) => migrationChecksum(candidate) === expected);
}
