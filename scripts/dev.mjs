/** Shared launcher for local and managed-preview use. Never prints secrets. */
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startLocalPostgres } from './postgres-local.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
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
async function run(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(npm, args, { cwd: root, stdio: 'inherit', env: process.env });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${args.join(' ')} exited ${code}`)),
    );
  });
}
try {
  await run(['run', 'build', '-w', '@dreamwalk/contracts']);
  await run(['run', 'build', '-w', '@dreamwalk/game-core']);
  await run(['run', 'db:migrate']);
  await run(['run', 'db:seed']);
  if (process.env.LOCAL_ADMIN_EMAIL) {
    if (!['development', 'test', undefined].includes(process.env.NODE_ENV))
      throw new Error('Local administrator bootstrap is development/test only.');
    await run(['run', 'admin:grant', '--', '--email', process.env.LOCAL_ADMIN_EMAIL]);
    delete process.env.LOCAL_ADMIN_EMAIL;
  }
  const child = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    [
      '--no-install',
      'concurrently',
      '--kill-others',
      '-n',
      'api,web',
      '-c',
      'cyan,magenta',
      'npm run dev -w @dreamwalk/api',
      'npm run dev -w @dreamwalk/web',
    ],
    { cwd: root, stdio: ['inherit', 'pipe', 'pipe'], env: process.env },
  );
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      process.stdout.write(chunk);
      appendFileSync(devLog, chunk);
    });
  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    child.kill('SIGTERM');
    if (database) await database.stop();
    process.exit(code);
  };
  child.on('exit', (code) => void stop(code ?? 1));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());
} catch (error) {
  if (database) await database.stop();
  throw error;
}
