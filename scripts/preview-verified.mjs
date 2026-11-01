/** Starts this checkout's isolated loopback preview. Live mode requires a scoped manual grant; no requests are dispatched by launch. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { launchManualLiveApi, resolveAuthorizedLiveSecretPath } from './local-live-loader.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { startLocalPostgres } from './postgres-local.mjs';
import { stopWindowsPostgres } from './postgres-local.mjs';
import { forceMockNpcTestEnvironment } from './mock-npc-test-env.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (
  !existsSync(
    path.join(root, 'apps/web', process.env.DREAMWALK_WEB_DIST_DIR ?? '.next', 'BUILD_ID'),
  ) ||
  !existsSync(path.join(root, 'apps/api/dist/main.js'))
)
  throw new Error('Run the verified production build first');
const resumeOwned = process.argv.includes('--resume-owned');
const manualLive = process.argv.includes('--manual-live');
const liveSecretPath = manualLive ? resolveAuthorizedLiveSecretPath() : undefined;
delete process.env.DREAMWALK_LIVE_SECRET_FILE;
const webDist = process.env.DREAMWALK_WEB_DIST_DIR ?? '.next';
const webPort = 3010,
  apiPort = 4000,
  dbPort = 55439;
async function listening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}
for (const port of resumeOwned ? [webPort, apiPort] : [webPort, apiPort, dbPort])
  if (await listening(port))
    throw new Error(`Port ${port} already occupied; no duplicate service started`);
forceMockNpcTestEnvironment();
for (const key of Object.keys(process.env))
  if (key.startsWith('LIVE_TEST_') || key.startsWith('IMAGE_')) delete process.env[key];
let liveGrant;
if (manualLive) {
  if (!resumeOwned)
    throw new Error('Manual live mode requires the existing owned preview database');
  liveGrant = JSON.parse(
    await readFile(path.join(root, '.local/verified-preview/manual-session.json'), 'utf8'),
  );
  if (
    !/^[0-9a-f-]{36}$/i.test(liveGrant.sessionId ?? '') ||
    !/^[0-9a-f-]{36}$/i.test(liveGrant.ownerId ?? '') ||
    !Number.isFinite(Date.parse(liveGrant.expiresAt)) ||
    Date.parse(liveGrant.expiresAt) <= Date.now() ||
    Date.parse(liveGrant.expiresAt) > Date.now() + 2 * 3600000
  )
    throw new Error('Manual live grant is invalid or expired; launch does not renew it');
  Object.assign(process.env, {
    LIVE_TEST_ENABLED: 'true',
    LIVE_TEST_SESSION_ID: liveGrant.sessionId,
    LIVE_TEST_OWNER_ID: liveGrant.ownerId,
    LIVE_TEST_EXPIRES_AT: liveGrant.expiresAt,
  });
}
delete process.env.DATABASE_URL;
for (const key of Object.keys(process.env)) if (key.startsWith('SMTP_')) delete process.env[key];
Object.assign(process.env, {
  LOCAL_PREVIEW_TEST_ADMIN_ENABLED: 'true',
  NODE_ENV: 'development',
  AI_PROVIDER: 'mock',
  GLOBAL_SPEND_CAP: '0',
  API_PORT: String(apiPort),
  PORT: String(webPort),
  WEB_ORIGIN: `http://127.0.0.1:${webPort}`,
  API_URL: `http://127.0.0.1:${apiPort}`,
  LOCAL_POSTGRES_CLUSTER: 'verified-preview',
  LOCAL_POSTGRES_PORT: String(dbPort),
  ASSET_DIR: path.join(root, '.local/verified-preview/assets'),
});
for (const key of [
  'PAID_GENERATION_ENABLED',
  'PAYMENTS_ENABLED',
  'DISCORD_ENABLED',
  'DEV_AUTH_ENABLED',
  'DEMO_FAUCET_ENABLED',
])
  process.env[key] = 'false';
const children = [];
let database;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.all(
    children.map((child) =>
      child.exitCode === null && child.signalCode === null
        ? once(child, 'exit')
        : Promise.resolve(),
    ),
  );
  if (database) await database.stop();
  process.exitCode = code;
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => void stop());
async function run(args) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error('Preview preparation failed');
}
try {
  if (resumeOwned) {
    if (!(await listening(dbPort)))
      throw new Error('Owned database must be recovered before resume');
    process.loadEnvFile(path.join(root, '.local/verified-preview/database.env'));
    const { pg_ctl } = await import('@embedded-postgres/windows-x64');
    database = {
      stop: () =>
        stopWindowsPostgres(
          pg_ctl,
          path.join(root, '.local/verified-preview/postgres'),
          'verified-preview',
        ),
    };
    await run(['apps/api/dist/migrate.js']);
  } else {
    database = await startLocalPostgres();
    await run(['apps/api/dist/migrate.js']);
    await run(['apps/api/dist/seed.js']);
  }
  const api = manualLive
    ? await launchManualLiveApi({
        secretPath: liveSecretPath,
        env: process.env,
        cwd: root,
      })
    : spawn(process.execPath, ['apps/api/dist/main.js'], {
        cwd: root,
        env: process.env,
        stdio: 'inherit',
        windowsHide: true,
      });
  children.push(api);
  for (let n = 0; n < 100; n++) {
    if (api.exitCode !== null) throw new Error('API startup failed');
    if (await listening(apiPort)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!(await listening(apiPort))) throw new Error('API did not become ready');
  const web = spawn(
    process.execPath,
    [
      path.join(root, 'node_modules/next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(webPort),
    ],
    {
      cwd: path.join(root, 'apps/web'),
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  children.push(web);
  for (let n = 0; n < 200; n++) {
    if (web.exitCode !== null) throw new Error('Web startup failed');
    if (await listening(webPort)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!(await listening(webPort))) throw new Error('Web did not become ready');
  const health = await fetch(`http://127.0.0.1:${webPort}/api/v1/health`);
  if (!health.ok || (await health.json()).status !== 'ok')
    throw new Error('Preview proxy health failed');
  // Use the absolute Next CLI from root while keeping Next's project cwd.
  await mkdir(path.join(root, '.local/verified-preview'), { recursive: true });
  await writeFile(
    path.join(root, '.local/verified-preview/processes.json'),
    JSON.stringify(
      {
        root,
        launcherPid: process.pid,
        apiPid: api.pid,
        webPid: web.pid,
        url: `http://127.0.0.1:${webPort}`,
        mode: manualLive ? 'openai-manual' : 'mock-only',
        webDist,
        ...(manualLive ? { sessionId: liveGrant.sessionId, expiresAt: liveGrant.expiresAt } : {}),
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  for (const child of children)
    child.once('exit', (code) => {
      if (!stopping) void stop(code ?? 1);
    });
  console.log(
    `Verified isolated ${manualLive ? 'manual OpenAI' : 'mock'} preview: http://127.0.0.1:${webPort}`,
  );
} catch (error) {
  console.error(error.message);
  await stop(1);
}
