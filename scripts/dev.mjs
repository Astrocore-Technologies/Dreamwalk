/** Shared launcher for local and managed-preview use. Never prints secrets. */
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startLocalPostgres } from './postgres-local.mjs';
import { readServerEnvironment, webEnvironment } from './server-environment.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverConfiguration = await readServerEnvironment({ root, env: process.env });
for (const key of Object.keys(process.env))
  if (!(key in serverConfiguration.preparationEnv)) delete process.env[key];
Object.assign(process.env, serverConfiguration.preparationEnv);
// In managed sandboxes the database must share the preview process namespace.
process.env.LOCAL_POSTGRES_CLUSTER ||= 'preview-live';
const database = process.env.DATABASE_URL ? null : await startLocalPostgres();
const portFlag = process.argv.indexOf('--port');
if (portFlag >= 0 && /^\d+$/.test(process.argv[portFlag + 1] || ''))
  process.env.PORT = process.argv[portFlag + 1];
process.env.API_PORT ||= '4000';
mkdirSync(path.join(root, '.local'), { recursive: true, mode: 0o700 });
const devLog = path.join(root, '.local', 'dev.log');
appendFileSync(
  devLog,
  `\nStartup ${new Date().toISOString()}; web PORT=${process.env.PORT || '(Next default)'}\n`,
  { mode: 0o600 },
);
process.env.WEB_ORIGIN ||=
  process.env.PREVIEW_ORIGIN ||
  (portFlag >= 0 ? `http://127.0.0.1:${process.env.PORT}` : 'http://localhost:3000');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
async function run(args, node = false) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      node || process.platform === 'win32' ? process.execPath : npm,
      !node && process.platform === 'win32' ? [process.env.npm_execpath, ...args] : args,
      { cwd: root, stdio: 'inherit', env: process.env },
    );
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${args.join(' ')} exited ${code}`)),
    );
  });
}
try {
  await run(['run', 'build', '-w', '@dreamwalk/contracts']);
  await run(['run', 'build', '-w', '@dreamwalk/game-core']);
  // Root env-run intentionally loads .env; bypass that wrapper here because the
  // launcher already parsed it and removed provider credentials from preparation.
  await run(['run', 'db:migrate', '-w', '@dreamwalk/api']);
  await run(['run', 'db:seed', '-w', '@dreamwalk/api']);
  await run(['run', 'build', '-w', '@dreamwalk/api']);
  if (process.env.LOCAL_ADMIN_EMAIL) {
    if (!['development', 'test', undefined].includes(process.env.NODE_ENV))
      throw new Error('Local administrator bootstrap is development/test only.');
    await run(['scripts/admin-grant.mjs', '--email', process.env.LOCAL_ADMIN_EMAIL], true);
    delete process.env.LOCAL_ADMIN_EMAIL;
  }
  // Separate child environments: provider keys/policy never reach Next.js.
  const apiEnv = {
    ...process.env,
    ...serverConfiguration.apiEnv,
    DATABASE_URL: process.env.DATABASE_URL,
    API_PORT: process.env.API_PORT,
    WEB_ORIGIN: process.env.WEB_ORIGIN,
  };
  // Do not reintroduce the one-time bootstrap identity from the saved input.
  delete apiEnv.LOCAL_ADMIN_EMAIL;
  const children = [
    spawn(process.execPath, [path.join(root, 'apps/api/dist/main.js')], {
      cwd: root,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: apiEnv,
    }),
    spawn(
      process.execPath,
      [
        path.join(root, 'node_modules/next/dist/bin/next'),
        'dev',
        '--hostname',
        '127.0.0.1',
        '--port',
        process.env.PORT || '3000',
      ],
      {
        cwd: path.join(root, 'apps/web'),
        stdio: ['inherit', 'pipe', 'pipe'],
        env: webEnvironment(process.env),
      },
    ),
  ];
  for (const child of children)
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        process.stdout.write(chunk);
        appendFileSync(devLog, chunk);
      });
  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill('SIGTERM');
    if (database) await database.stop();
    process.exit(code);
  };
  for (const child of children) {
    child.on('exit', (code) => void stop(code ?? 1));
    child.on('error', () => void stop(1));
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());
} catch (error) {
  if (database) await database.stop();
  throw error;
}
