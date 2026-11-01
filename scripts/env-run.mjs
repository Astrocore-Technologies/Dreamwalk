/** Run a development command with local configuration, without exposing credentials. */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const file of ['.env', '.local/preview-live/database.env']) {
  const absolute = path.join(root, file);
  if (existsSync(absolute)) process.loadEnvFile(absolute);
}
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('A command is required.');
const npmCommand = process.platform === 'win32' && ['npm', 'npm.cmd'].includes(command);
const npmCli =
  process.env.npm_execpath ||
  path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const child = spawn(
  npmCommand ? process.execPath : command,
  npmCommand ? [npmCli, ...args] : args,
  { cwd: root, stdio: 'inherit', env: process.env, windowsHide: true },
);
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
