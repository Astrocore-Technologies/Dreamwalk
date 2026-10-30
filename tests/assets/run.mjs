import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
/** Real isolated PostgreSQL/game transport tests. Never uses the preview or external database. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { startLocalPostgres } from '../../scripts/postgres-local.mjs';
import { forceMockNpcTestEnvironment } from '../../scripts/mock-npc-test-env.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('Game tests cannot run in production');
forceMockNpcTestEnvironment();
async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
// An inherited DATABASE_URL is intentionally ignored, including the CI platform service.
delete process.env.DATABASE_URL;
process.env.NODE_ENV = 'test';
process.env.LOCAL_POSTGRES_CLUSTER = `assets-test-${randomUUID()}`;
process.env.LOCAL_POSTGRES_PORT = String(await freePort());
process.env.API_PORT = String(await freePort());
process.env.WEB_ORIGIN = 'http://localhost:3000';
process.env.TEST_GAME_API_URL = `http://127.0.0.1:${process.env.API_PORT}/api/v1`;
process.env.AI_PROVIDER = 'mock';
for (const key of [
  'PAID_GENERATION_ENABLED',
  'PAYMENTS_ENABLED',
  'DISCORD_ENABLED',
  'DEV_AUTH_ENABLED',
  'DEMO_FAUCET_ENABLED',
])
  process.env[key] = 'false';
process.env.GLOBAL_SPEND_CAP = '0';
for (const key of ['SMTP_HOST', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASSWORD']) delete process.env[key];
const assetDir = await mkdtemp(join(tmpdir(), 'dreamwalk-art-test-'));
process.env.ASSET_DIR = assetDir;
const database = await startLocalPostgres();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
async function run(command, args) {
  const child = spawn(command, args, { stdio: 'inherit', env: process.env });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`Game test subprocess failed (${code})`);
}
try {
  for (const workspace of ['@dreamwalk/contracts', '@dreamwalk/game-core', '@dreamwalk/api'])
    await run(npm, ['run', 'build', '-w', workspace]);
  await run(process.execPath, ['apps/api/dist/migrate.js']);
  await run(process.execPath, ['apps/api/dist/seed.js']);
  let files = ['integration-reuse.test.mjs', 'integration-http.test.mjs'];
  if (process.env.ASSET_TEST_FILE) {
    if (!files.includes(process.env.ASSET_TEST_FILE)) throw new Error('Unknown asset test file');
    files = [process.env.ASSET_TEST_FILE];
  }
  await run(process.execPath, [
    '--test',
    '--test-concurrency=1',
    ...files.map((f) => `tests/assets/${f}`),
  ]);
} finally {
  await database.stop();
  await rm(assetDir, { recursive: true, force: true });
}
