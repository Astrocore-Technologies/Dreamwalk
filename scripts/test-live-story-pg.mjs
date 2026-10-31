/** Explicit offline acceptance only. Never targets the application's existing database. */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { stripBootstrapSecrets } from './live-story/key-entry.mjs';
stripBootstrapSecrets(process.env);
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.LOCAL_POSTGRES_CLUSTER = `live-ledger-test-${randomUUID()}`;
const server = net.createServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
process.env.LOCAL_POSTGRES_PORT = String(server.address().port);
await new Promise((r) => server.close(r));
const { startLocalPostgres } = await import('./postgres-local.mjs');
const db = await startLocalPostgres();
try {
  const child = spawn(process.execPath, ['--test', 'tests/live-story-pg-guard.test.mjs'], {
    stdio: 'inherit',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SYSTEMROOT: process.env.SYSTEMROOT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      TEST_LIVE_GUARD_DB_URL: process.env.DATABASE_URL,
    },
  });
  const [code] = await once(child, 'exit');
  if (code !== 0) process.exitCode = 1;
} finally {
  await db.stop();
}
