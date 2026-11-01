/** Targeted disposable world-item/story/sprite acceptance. No owner key or external provider. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
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
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
process.env.NODE_ENV = 'test';
process.env.LOCAL_POSTGRES_CLUSTER = 'world-items-' + randomUUID();
process.env.LOCAL_POSTGRES_PORT = String(await port());
process.env.API_PORT = String(await port());
process.env.TEST_GAME_WEB_PORT = String(await port());
process.env.WEB_ORIGIN = 'http://127.0.0.1:' + process.env.TEST_GAME_WEB_PORT;
process.env.TEST_GAME_API_URL = 'http://127.0.0.1:' + process.env.API_PORT + '/api/v1';
process.env.API_URL = 'http://127.0.0.1:' + process.env.API_PORT;
process.env.ASSET_DIR = join(tmpdir(), 'world-items-assets-' + randomUUID());
await mkdir(process.env.ASSET_DIR, { recursive: true });
const database = await startLocalPostgres();
async function run(args) {
  const p = spawn(process.execPath, args, {
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  const [code] = await once(p, 'exit');
  if (code !== 0) throw Error('Targeted subprocess failed ' + code);
}
try {
  await run(['apps/api/dist/migrate.js']);
  await run(['apps/api/dist/seed.js']);
  await run(['--test', 'tests/game/integration-world-items.test.mjs']);
} finally {
  await database.stop();
}
