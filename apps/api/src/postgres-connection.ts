import { X509Certificate } from 'node:crypto';
import type { PoolConfig } from 'pg';

/** Server-only settings. Never log the URL or include it in validation errors. */
export function postgresConnectionConfig(
  env: NodeJS.ProcessEnv = process.env,
  purpose: 'runtime' | 'migration' = 'runtime',
): PoolConfig {
  const connectionString =
    purpose === 'migration' && env.DATABASE_MIGRATION_URL !== undefined
      ? env.DATABASE_MIGRATION_URL
      : env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_CONNECTION_URL_REQUIRED');
  let url: URL;
  try {
    url = new URL(connectionString);
    // Encoded Unix-socket hosts bypass the TLS path inside node-postgres.
    if (/[\\/]/.test(decodeURIComponent(url.hostname))) throw new Error('Invalid host');
  } catch {
    throw new Error('DATABASE_CONNECTION_URL_INVALID');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash)
    throw new Error('DATABASE_CONNECTION_URL_INVALID');
  // node-postgres URL settings otherwise replace the explicit ssl object, including
  // its CA and verification policy. TLS configuration has one unambiguous source.
  for (const key of url.searchParams.keys()) {
    if (/^ssl/i.test(key) || ['uselibpqcompat', 'host', 'hostaddr'].includes(key.toLowerCase()))
      throw new Error('DATABASE_URL_CONNECTION_OVERRIDE_FORBIDDEN');
  }
  if (env.DATABASE_SSL !== undefined && !['true', 'false'].includes(env.DATABASE_SSL))
    throw new Error('DATABASE_SSL_MUST_BE_BOOLEAN');
  const enabled = env.DATABASE_SSL === 'true';
  const ca = env.DATABASE_SSL_CA;
  if (ca !== undefined && !enabled) throw new Error('DATABASE_SSL_CA_REQUIRES_TLS');
  if (ca !== undefined) {
    if (ca.length > 131072) throw new Error('DATABASE_SSL_CA_INVALID');
    const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!certificates?.length || certificates.length > 16)
      throw new Error('DATABASE_SSL_CA_INVALID');
    try {
      if (
        certificates
          .reduce((remaining, certificate) => remaining.replace(certificate, ''), ca)
          .trim()
      )
        throw new Error('Unexpected certificate contents');
      for (const certificate of certificates) new X509Certificate(certificate);
    } catch {
      throw new Error('DATABASE_SSL_CA_INVALID');
    }
  }
  return {
    connectionString,
    // Explicit false also prevents ambient PGSSLMODE from silently changing local behavior.
    ssl: enabled ? { rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }) } : false,
  };
}
