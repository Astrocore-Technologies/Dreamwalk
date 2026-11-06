/** Real isolated PostgreSQL/game transport tests. Never uses the preview or external database. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startLocalPostgres } from './postgres-local.mjs';
import { forceMockNpcTestEnvironment } from './mock-npc-test-env.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('Game tests cannot run in production');
const skipBuild = process.argv.includes('--skip-build');
if (process.argv.slice(2).some((arg) => arg !== '--skip-build'))
  throw new Error('Unknown game runner option');
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
process.env.LOCAL_POSTGRES_CLUSTER = `game-test-${randomUUID()}`;
process.env.LOCAL_POSTGRES_PORT = String(await freePort());
process.env.API_PORT = String(await freePort());
// The world-item acceptance also starts Next.js. Its origin and proxy must use
// this disposable runner's ports, never an inherited preview/default API.
process.env.TEST_GAME_WEB_PORT = String(await freePort());
process.env.WEB_ORIGIN = `http://127.0.0.1:${process.env.TEST_GAME_WEB_PORT}`;
process.env.API_URL = `http://127.0.0.1:${process.env.API_PORT}`;
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
const assetDir = await mkdtemp(join(tmpdir(), 'dreamwalk-game-test-assets-'));
process.env.ASSET_DIR = assetDir;
const database = await startLocalPostgres();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
async function run(command, args, env = process.env) {
  const child = spawn(
    command === npm && process.platform === 'win32' ? process.execPath : command,
    command === npm && process.platform === 'win32' ? [process.env.npm_execpath, ...args] : args,
    { stdio: 'inherit', env },
  );
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`Game test subprocess failed (${code})`);
}
try {
  if (skipBuild) await access(new URL('../apps/api/dist/main.js', import.meta.url));
  else
    for (const workspace of ['@dreamwalk/contracts', '@dreamwalk/game-core', '@dreamwalk/api'])
      await run(npm, ['run', 'build', '-w', workspace]);
  await run(process.execPath, ['apps/api/dist/migrate.js']);
  await run(process.execPath, ['apps/api/dist/seed.js']);
  let files = readdirSync('tests/game').filter((name) => /^integration.*\.test\.mjs$/.test(name));
  if (process.env.GAME_TEST_FILE) {
    if (!files.includes(process.env.GAME_TEST_FILE))
      throw new Error('Unknown game integration test file');
    files = [process.env.GAME_TEST_FILE];
  }
  // Legacy synthetic suites intentionally retain financial liabilities. The owner
  // admission suite must prove clean first-claim behavior in its own fresh cluster,
  // not erase those liabilities or weaken the production guard to share a fixture.
  const isolatedOwnerFiles = [
    'integration-generation-owner.test.mjs',
    'integration-generation-policy-revisions.test.mjs',
    'integration-generation-text-preflight.test.mjs',
    // Recovery proves one historical release bill under its own synthetic tariff.
    // Do not inherit another suite's active deployment or unresolved provider liability.
    'integration-known-npc-settlement.test.mjs',
    'integration-known-authoring-settlement.test.mjs',
    'integration-automatic-settlement.test.mjs',
    'integration-autonomous-speech.test.mjs',
    'integration-verified-access-recovery.test.mjs',
    'integration-location-only.test.mjs',
    'integration-text-plan-positions.test.mjs',
    // Travel deliberately retains an unknown native image liability under a synthetic tariff.
    'integration-location-travel.test.mjs',
    'integration-private-story-routing.test.mjs',
    'integration-established-roleplay.test.mjs',
  ];
  if (!process.env.GAME_TEST_FILE)
    for (const ownerFile of isolatedOwnerFiles) {
      if (!files.includes(ownerFile)) continue;
      await run(process.execPath, ['scripts/test-game.mjs', '--skip-build'], {
        ...process.env,
        GAME_TEST_FILE: ownerFile,
      });
      files = files.filter((name) => name !== ownerFile);
    }
  if (files.length)
    await run(process.execPath, [
      '--test',
      '--test-concurrency=1',
      ...files.map((name) => `tests/game/${name}`),
    ]);
} finally {
  await database.stop();
  await rm(assetDir, { recursive: true, force: true });
}
