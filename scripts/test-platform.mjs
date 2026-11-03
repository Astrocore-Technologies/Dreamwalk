import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** API/DB integration runner. All processes share one isolated local namespace. */
import { startLocalPostgres } from './postgres-local.mjs';
import { forceMockNpcTestEnvironment } from './mock-npc-test-env.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import pg from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
forceMockNpcTestEnvironment();
if (process.env.NODE_ENV === 'production') throw new Error('Disposable platform tests only');
delete process.env.DATABASE_URL;

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
process.env.LOCAL_POSTGRES_PORT = String(await freePort());
process.env.API_PORT = String(await freePort());
process.env.TEST_API_URL = `http://127.0.0.1:${process.env.API_PORT}/api/v1`;
process.env.TEST_WEB_ORIGIN = 'http://localhost:3000';
process.env.WEB_ORIGIN = process.env.TEST_WEB_ORIGIN;
const assetDir = await mkdtemp(join(tmpdir(), 'dreamwalk-platform-assets-'));
process.env.ASSET_DIR = assetDir;
process.env.LOCAL_POSTGRES_CLUSTER = `test-${Date.now()}`;
const database = process.env.DATABASE_URL ? null : await startLocalPostgres();
process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN ||= 'http://localhost:3000';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      command === npm && process.platform === 'win32' ? process.execPath : command,
      command === npm && process.platform === 'win32' ? [process.env.npm_execpath, ...args] : args,
      { stdio: 'inherit', env: process.env },
    );
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)),
    );
  });
}
let api;
async function startApi() {
  api = spawn(process.execPath, ['apps/api/dist/main.js'], { stdio: 'inherit', env: process.env });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (api.exitCode !== null || api.signalCode !== null)
      throw new Error('Nest API exited before becoming ready.');
    try {
      if ((await fetch(process.env.TEST_API_URL + '/health')).ok) return;
    } catch {
      /* Retry only local startup, never test requests or external calls. */
    }
    await delay(250);
  }
  throw new Error('Nest API did not become ready.');
}
async function stopApi() {
  if (api && api.exitCode === null && api.signalCode === null) {
    const exited = once(api, 'exit');
    const deadline = setTimeout(() => api.kill('SIGKILL'), 10_000);
    api.kill('SIGTERM');
    try {
      await exited;
    } finally {
      clearTimeout(deadline);
    }
  }
  api = undefined;
}
try {
  if (!process.argv.includes('--skip-build')) {
    await run(npm, ['run', 'build', '-w', '@dreamwalk/contracts']);
    await run(npm, ['run', 'build', '-w', '@dreamwalk/game-core']);
    await run(npm, ['run', 'build', '-w', '@dreamwalk/api']);
  }
  await run(process.execPath, ['apps/api/dist/migrate.js']);
  await run(process.execPath, ['apps/api/dist/seed.js']);
  const checkDb = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await checkDb.connect();
  const countSql =
    'SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM adventures) AS adventures, (SELECT count(*) FROM npcs) AS npcs, (SELECT count(*) FROM model_profiles) AS models, (SELECT count(*) FROM adventure_versions) AS versions';
  try {
    const before = (await checkDb.query(countSql)).rows[0];
    await run(process.execPath, ['apps/api/dist/migrate.js']);
    await run(process.execPath, ['apps/api/dist/seed.js']);
    assert.deepEqual(
      (await checkDb.query(countSql)).rows[0],
      before,
      'Migration/seed reruns must not duplicate fixtures',
    );
    console.log('Migration and seed rerun idempotency verified against PostgreSQL.');
  } finally {
    await checkDb.end();
  }
  // Test files have independent fixture traffic but intentionally share persisted data.
  // A fresh real API per file isolates its in-memory rate-limit window without changing
  // the production limiter, trusting spoofed IPs, or retrying rate-limited requests.
  const files = readdirSync('tests')
    .filter((name) => /^platform-.*\.test\.mjs$/.test(name))
    .sort();
  for (const file of files) {
    await startApi();
    try {
      await run(process.execPath, ['--import', 'tsx', '--test', `tests/${file}`]);
    } finally {
      await stopApi();
    }
  }
} finally {
  await stopApi();
  if (database) await database.stop();
  await rm(assetDir, { recursive: true, force: true });
}
