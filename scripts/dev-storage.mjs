import { spawn } from 'node:child_process';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storage = path.resolve(
  process.env.DREAMWALK_DEV_STORAGE_ROOT || path.join(root, '.local', 'workflow'),
);
const paths = {
  root,
  storage,
  temp: path.join(storage, 'tmp'),
  npmCache: path.join(storage, 'npm-cache'),
  browserCache: path.join(storage, 'playwright-browsers'),
  artifacts: path.join(storage, 'artifacts'),
};
for (const directory of [paths.temp, paths.npmCache, paths.browserCache, paths.artifacts])
  await mkdir(directory, { recursive: true });
Object.assign(process.env, {
  TEMP: paths.temp,
  TMP: paths.temp,
  TMPDIR: paths.temp,
  npm_config_cache: paths.npmCache,
  PLAYWRIGHT_BROWSERS_PATH: paths.browserCache,
  DREAMWALK_ARTIFACT_DIR: paths.artifacts,
  XDG_CACHE_HOME: path.join(storage, 'cache'),
  NEXT_TELEMETRY_DISABLED: '1',
});
const args = process.argv.slice(2);
if (args[0] === '--show-paths') {
  const probe = path.join(paths.temp, `storage-probe-${process.pid}.txt`);
  await writeFile(probe, 'Dreamwalk storage probe', { flag: 'wx' });
  await unlink(probe);
  console.log(
    JSON.stringify(
      {
        ...paths,
        effectiveNodeTemp: tmpdir(),
        scope: 'this development process and children; no Windows-wide settings changed',
      },
      null,
      2,
    ),
  );
} else {
  if (!args.length) throw new Error('Usage: npm run local -- <npm|node|command> [args]');
  let command = args.shift();
  if (command === 'node') command = process.execPath;
  else if (command === 'npm') {
    if (!process.env.npm_execpath) throw new Error('Run through npm run local to locate npm CLI');
    args.unshift(process.env.npm_execpath);
    command = process.execPath;
  }
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
}
