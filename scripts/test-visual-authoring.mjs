import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { startLocalPostgres } from './postgres-local.mjs';
import { forceMockNpcTestEnvironment } from './mock-npc-test-env.mjs';
if (process.env.NODE_ENV === 'production') throw new Error('Disposable tests only');
forceMockNpcTestEnvironment();
async function port() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
delete process.env.DATABASE_URL;
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOCAL_POSTGRES_CLUSTER: `visual-test-${randomUUID()}`,
  LOCAL_POSTGRES_PORT: String(await port()),
  API_PORT: String(await port()),
  WEB_ORIGIN: 'http://localhost:3000',
  AI_PROVIDER: 'mock',
  GLOBAL_SPEND_CAP: '0',
});
for (const key of [
  'PAID_GENERATION_ENABLED',
  'PAYMENTS_ENABLED',
  'DISCORD_ENABLED',
  'DEV_AUTH_ENABLED',
  'DEMO_FAUCET_ENABLED',
])
  process.env[key] = 'false';
for (const key of ['SMTP_HOST', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASSWORD']) delete process.env[key];
process.env.TEST_GAME_API_URL = `http://127.0.0.1:${process.env.API_PORT}/api/v1`;
const allowedTests = [
  'tests/visuals/integration.test.mjs',
  'tests/visuals/real-pipeline.test.mjs',
  'tests/visuals/spatial-plan.test.mjs',
  'tests/visuals/spatial-planner.test.mjs',
  'tests/visuals/spatial-http.test.mjs',
];
const args = process.argv.slice(2),
  skipBuild = args.includes('--skip-build'),
  fileAt = args.indexOf('--test-file');
const selected = fileAt >= 0 ? args[fileAt + 1] : undefined;
if (
  args.some(
    (arg, index) =>
      arg !== '--skip-build' && arg !== '--test-file' && !(fileAt >= 0 && index === fileAt + 1),
  ) ||
  (fileAt >= 0 && !allowedTests.includes(selected))
)
  throw new Error('Invalid visual test arguments');
const assetDir = await mkdtemp(join(tmpdir(), 'dreamwalk-visual-tests-'));
process.env.ASSET_DIR = assetDir;
const database = await startLocalPostgres();
async function run(args) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`Visual check failed: ${code}`);
}

try {
  if (!skipBuild)
    for (const workspace of ['@dreamwalk/contracts', '@dreamwalk/game-core', '@dreamwalk/api'])
      await run([process.env.npm_execpath, 'run', 'build', '-w', workspace]);
  await run(['apps/api/dist/migrate.js']);
  await run(['apps/api/dist/seed.js']);
  await run(['--test', '--test-concurrency=1', ...(selected ? [selected] : allowedTests)]);
} finally {
  await database.stop();
  await rm(assetDir, { recursive: true, force: true });
}
