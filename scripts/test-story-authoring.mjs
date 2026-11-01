/** Bounded synthetic CI journey; disposable PostgreSQL and mock-only API.
 * Browser default: install managed Chromium with `npx playwright install --with-deps chromium`.
 * HTTP-only: STORY_AUTHORING_HTTP=1 (never launches a browser).
 * Optional screenshot destination: STORY_AUTHORING_ARTIFACT_DIR (CI default: test-results/story-authoring).
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { forceMockNpcTestEnvironment } from './mock-npc-test-env.mjs';
import { startLocalPostgres } from './postgres-local.mjs';
forceMockNpcTestEnvironment();
delete process.env.DATABASE_URL;
async function port() {
  const s = net.createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const value = s.address().port;
  await new Promise((r) => s.close(r));
  return value;
}
process.env.NODE_ENV = 'test';
process.env.LOCAL_POSTGRES_CLUSTER = `authoring-${randomUUID()}`;
process.env.LOCAL_POSTGRES_PORT = String(await port());
process.env.API_PORT = String(await port());
process.env.TEST_GAME_WEB_PORT = String(process.env.STORY_AUTHORING_WEB_PORT || (await port()));
process.env.WEB_ORIGIN = `http://127.0.0.1:${process.env.TEST_GAME_WEB_PORT}`;
process.env.TEST_GAME_API_URL = `http://127.0.0.1:${process.env.API_PORT}/api/v1`;
process.env.API_URL = `http://127.0.0.1:${process.env.API_PORT}`;
process.env.DREAMWALK_WEB_DIST_DIR = '.next-authoring-qa';
for (const key of [
  'PAID_GENERATION_ENABLED',
  'PAYMENTS_ENABLED',
  'DISCORD_ENABLED',
  'DEV_AUTH_ENABLED',
  'DEMO_FAUCET_ENABLED',
])
  process.env[key] = 'false';
process.env.AI_PROVIDER = 'mock';
process.env.GLOBAL_SPEND_CAP = '0';
for (const key of ['SMTP_HOST', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASSWORD']) delete process.env[key];
process.env.ASSET_DIR = await mkdtemp(join(tmpdir(), 'authoring-assets-'));
let database;
async function run(args, timeout = 180000) {
  const child = spawn(process.execPath, args, {
    env: process.env,
    stdio: 'inherit',
    timeout,
    killSignal: 'SIGTERM',
  });
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) throw Error(`Synthetic authoring subprocess exited ${code ?? signal}`);
}
try {
  database = await startLocalPostgres();
  // Build separately before running: avoids competing with the owner's active build.
  await run(['apps/api/dist/migrate.js']);
  await run(['apps/api/dist/seed.js']);
  await run(
    ['--test', '--test-timeout=300000', 'tests/game/story-authoring-browser.test.mjs'],
    330000,
  );
} finally {
  try {
    await database?.stop();
  } finally {
    await rm(process.env.ASSET_DIR, { recursive: true, force: true });
  }
}
