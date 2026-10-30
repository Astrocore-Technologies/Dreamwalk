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
process.env.LOCAL_POSTGRES_CLUSTER = `test-${Date.now()}`;
const database = process.env.DATABASE_URL ? null : await startLocalPostgres();
process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN ||= 'http://localhost:3000';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: process.env });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)),
    );
  });
}
let api;
try {
  await run(npm, ['run', 'build', '-w', '@dreamwalk/contracts']);
  await run(npm, ['run', 'build', '-w', '@dreamwalk/game-core']);
  await run(npm, ['run', 'build', '-w', '@dreamwalk/api']);
  await run(npm, ['run', 'db:migrate']);
  await run(npm, ['run', 'db:seed']);
  const checkDb = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await checkDb.connect();
  const countSql =
    'SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM adventures) AS adventures, (SELECT count(*) FROM npcs) AS npcs, (SELECT count(*) FROM model_profiles) AS models, (SELECT count(*) FROM adventure_versions) AS versions';
  try {
    const before = (await checkDb.query(countSql)).rows[0];
    await run(npm, ['run', 'db:migrate']);
    await run(npm, ['run', 'db:seed']);
    assert.deepEqual(
      (await checkDb.query(countSql)).rows[0],
      before,
      'Migration/seed reruns must not duplicate fixtures',
    );
    console.log('Migration and seed rerun idempotency verified against PostgreSQL.');
  } finally {
    await checkDb.end();
  }
  api = spawn(process.execPath, ['apps/api/dist/main.js'], { stdio: 'inherit', env: process.env });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch('http://127.0.0.1:4000/api/v1/auth/me')).ok) {
        ready = true;
        break;
      }
    } catch {
      /* Retry only local startup, never external calls. */
    }
    await delay(250);
  }
  if (!ready) throw new Error('Nest API did not become ready.');
  await run(process.execPath, [
    '--import',
    'tsx',
    '--test',
    '--test-concurrency=1',
    ...readdirSync('tests')
      .filter((name) => /^platform-.*\.test\.mjs$/.test(name))
      .map((name) => `tests/${name}`),
  ]);
} finally {
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
  if (database) await database.stop();
}
