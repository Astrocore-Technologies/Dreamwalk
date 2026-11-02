/** Preserve file checksums; production extension installation belongs to the DB operator. */
export function productionMigrationSql(name: string, sql: string, pgcryptoInstalled: boolean) {
  if (!pgcryptoInstalled)
    throw new Error(
      'PRODUCTION_PGCRYPTO_REQUIRED: ask the database operator to install pgcrypto before migrations',
    );
  const extension = 'CREATE EXTENSION IF NOT EXISTS pgcrypto;';
  let executable = sql;
  if (name === '001_platform.sql') {
    if (!sql.startsWith(extension)) throw new Error('UNEXPECTED_EXTENSION_MIGRATION');
    executable = sql.slice(extension.length);
  }
  if (/\b(?:CREATE|ALTER|DROP)\s+EXTENSION\b/i.test(executable))
    throw new Error('PRODUCTION_EXTENSION_DDL_REQUIRES_OPERATOR');
  return executable;
}
