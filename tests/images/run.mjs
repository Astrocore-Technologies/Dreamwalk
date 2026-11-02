import { mkdtemp, rm, access } from 'node:fs/promises';
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
const selectedTestFile = process.env.IMAGE_TEST_FILE;
const skipBuild = process.argv.includes('--skip-build');
if (process.argv.slice(2).some((arg) => arg !== '--skip-build'))
  throw new Error('Unknown image runner option');
forceMockNpcTestEnvironment();
// Never propagate approved live-image configuration into synthetic acceptance.
for (const key of Object.keys(process.env))
  if (
    (key.startsWith('IMAGE_') && key !== 'IMAGE_TEST_FILE') ||
    key.startsWith('OPENAI_') ||
    key.startsWith('LIVE_NPC_') ||
    key.startsWith('GENERATION_')
  )
    delete process.env[key];
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
process.env.LOCAL_POSTGRES_CLUSTER = `images-test-${randomUUID()}`;
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
const assetDir = await mkdtemp(join(tmpdir(), 'dreamwalk-image-test-'));
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
  if (skipBuild) await access(new URL('../../apps/api/dist/main.js', import.meta.url));
  else
    for (const workspace of ['@dreamwalk/contracts', '@dreamwalk/game-core', '@dreamwalk/api'])
      await run(npm, ['run', 'build', '-w', workspace]);
  await run(process.execPath, ['apps/api/dist/migrate.js']);
  await run(process.execPath, ['apps/api/dist/seed.js']);
  await run(process.execPath, [
    '--import',
    'tsx',
    '--test',
    'tests/images/config.test.mjs',
    'tests/images/owner-config.test.mjs',
    'tests/images/release-runtime.test.mjs',
    'tests/images/request-estimates.test.mjs',
  ]);
  let files = [
    'integration-release-budget.test.mjs',
    'integration-release-authority.test.mjs',
    'integration-release-npc.test.mjs',
    'integration-owner-generation.test.mjs',
    'integration-recovery.test.mjs',
    'integration-retained-rejections.test.mjs',
    'integration-request-estimates.test.mjs',
    'integration-budget.test.mjs',
    'integration-diagnostics.test.mjs',
    'integration-generation.test.mjs',
    'integration-campaign.test.mjs',
    'integration-studio-location.test.mjs',
  ];
  if (selectedTestFile) {
    if (!files.includes(selectedTestFile)) throw new Error('Unknown image test file');
    files = [selectedTestFile];
  }
  // Node sorts test filenames. Run the rollback-only owner fixture before legacy tests
  // deliberately retain unknown liabilities; never erase those liabilities to admit an owner.
  const ownerFile = 'integration-owner-generation.test.mjs';
  if (files.includes(ownerFile))
    await run(process.execPath, ['--test', `tests/images/${ownerFile}`]);
  files = files.filter((file) => file !== ownerFile);
  // Owner admission fixtures need a fresh scope. Legacy budget tests below
  // deliberately retain unknown liabilities; never erase them to admit a new owner.
  for (const isolatedFile of [
    'integration-request-estimates.test.mjs',
    'integration-retained-rejections.test.mjs',
    'integration-recovery.test.mjs',
  ]) {
    if (!selectedTestFile && files.includes(isolatedFile)) {
      await run(process.execPath, ['tests/images/run.mjs', '--skip-build'], {
        ...process.env,
        IMAGE_TEST_FILE: isolatedFile,
      });
      files = files.filter((file) => file !== isolatedFile);
    }
  }
  if (files.length)
    await run(process.execPath, [
      '--test',
      '--test-concurrency=1',
      ...files.map((f) => `tests/images/${f}`),
    ]);
} finally {
  await database.stop();
  await rm(assetDir, { recursive: true, force: true });
}
