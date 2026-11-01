/** Private loader: imports exactly one authorized credential, never a dotenv environment. */
import { readFile, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
export const authorizedSecretName = 'NPC_AI_API_KEY';
export function resolveAuthorizedLiveSecretPath(env = process.env) {
  const path = env.DREAMWALK_LIVE_SECRET_FILE;
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))
    throw new Error('LIVE_SECRET_PATH_REQUIRED');
  return path;
}
export function extractAuthorizedLiveKey(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 65536)
    throw new Error('LIVE_SECRET_FILE_INVALID');
  const values = [];
  for (const line of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?NPC_AI_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[1];
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      if (value.length < 2 || value.at(-1) !== quote) throw new Error('LIVE_SECRET_FILE_INVALID');
      value = value.slice(1, -1);
    }
    if (!/^[A-Za-z0-9_-]{10,512}$/.test(value)) throw new Error('LIVE_SECRET_FILE_INVALID');
    values.push(value);
  }
  if (values.length !== 1) throw new Error('LIVE_SECRET_KEY_MISSING_OR_DUPLICATED');
  return values[0];
}
export async function loadAuthorizedLiveKey(path) {
  resolveAuthorizedLiveSecretPath({ DREAMWALK_LIVE_SECRET_FILE: path });
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
    throw new Error('LIVE_SECRET_FILE_INVALID');
  return extractAuthorizedLiveKey(await readFile(path, 'utf8'));
}
export async function launchManualLiveApi({ secretPath, env = process.env, cwd = process.cwd() }) {
  if (env.LIVE_TEST_ENABLED !== 'true') throw new Error('LIVE_TEST_DISABLED');
  const key = await loadAuthorizedLiveKey(secretPath);
  const childEnv = { ...env, NPC_AI_API_KEY: key };
  delete childEnv.DREAMWALK_LIVE_SECRET_FILE;
  // The key travels only in the child process environment; it is never an argv/log/file value.
  return spawn(process.execPath, ['apps/api/dist/main.js'], {
    cwd,
    env: childEnv,
    stdio: 'inherit',
    windowsHide: true,
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const child = await launchManualLiveApi({
      secretPath: resolveAuthorizedLiveSecretPath(),
    });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
    });
  } catch {
    console.error('LIVE_TEST_START_FAILED');
    process.exitCode = 1;
  }
}
