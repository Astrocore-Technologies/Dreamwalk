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
const child = spawn(process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command, args, {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
