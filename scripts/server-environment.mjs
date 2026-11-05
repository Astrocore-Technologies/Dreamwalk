/** Owner-operated configuration only. Importing this module never reads a file or starts a process. */
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';

const serverKeys = new Set([
  'OPENAI_API_KEY',
  'NPC_AI_API_KEY',
  'NPC_AI_KILL_SWITCH',
  'GENERATION_MODE',
  'GENERATION_OWNER_HANDLE',
  'GENERATION_OWNER_CONFIG_JSON',
]);
const privateGenerationKey = (key) =>
  /^(OPENAI_|NPC_AI_|LIVE_TEST_|IMAGE_|GENERATION_|BREVO_|GOOGLE_|SMTP_|AUTH_EMAIL_)/.test(key) ||
  ['DREAMWALK_SERVER_ENV_FILE', 'DREAMWALK_LIVE_SECRET_FILE'].includes(key);
const systemKeys = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'SHELL',
]);
const webKeys = new Set([
  ...systemKeys,
  'NODE_ENV',
  'PORT',
  'API_URL',
  'WEB_ORIGIN',
  'API_WEB_ORIGIN',
  'WEB_ALLOWED_ORIGINS',
  'DREAMWALK_WEB_DIST_DIR',
  'NEXT_TELEMETRY_DISABLED',
]);

async function readConfigurationFile(file, { optional = false, allowed } = {}) {
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return {};
    throw new Error('SERVER_CONFIGURATION_FILE_UNAVAILABLE');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
    throw new Error('SERVER_CONFIGURATION_FILE_INVALID');
  let parsed;
  try {
    parsed = parseEnv(await readFile(file, 'utf8'));
  } catch {
    throw new Error('SERVER_CONFIGURATION_FILE_INVALID');
  }
  if (allowed && Object.keys(parsed).some((key) => !allowed.has(key)))
    throw new Error('SERVER_CONFIGURATION_VARIABLE_NOT_ALLOWED');
  return parsed;
}

function explicitFile(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0'))
    throw new Error('SERVER_CONFIGURATION_ABSOLUTE_PATH_REQUIRED');
  return value;
}

/** Web processes receive a small allowlist, never API keys, provider policy or database credentials. */
export function webEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => webKeys.has(key) && typeof value === 'string'),
  );
}

/** Build/migration/bootstrap processes do not receive provider/auth credentials or activation policy. */
export function preparationEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !privateGenerationKey(key)));
}

export async function readServerEnvironment({ root, env }) {
  // Existing shell variables take precedence, matching Node's loadEnvFile behavior.
  let apiEnv = { ...(await readConfigurationFile(join(root, '.env'), { optional: true })), ...env };
  for (const key of Object.keys(apiEnv))
    if (key.startsWith('NEXT_PUBLIC_') && /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/.test(key))
      throw new Error('SERVER_CREDENTIAL_MUST_NOT_BE_PUBLIC');
  if (apiEnv.GENERATION_MODE === 'owner' && apiEnv.DREAMWALK_SERVER_ENV_FILE) {
    const privateFile = explicitFile(apiEnv.DREAMWALK_SERVER_ENV_FILE);
    const values = await readConfigurationFile(privateFile, { allowed: serverKeys });
    // The explicit private file is authoritative for its allowlisted server settings.
    apiEnv = { ...apiEnv, ...values };
    if (apiEnv.GENERATION_MODE !== 'owner') throw new Error('SERVER_GENERATION_MODE_CONFLICT');
  }
  if (apiEnv.DREAMWALK_DATABASE_ENV_FILE) {
    const values = await readConfigurationFile(explicitFile(apiEnv.DREAMWALK_DATABASE_ENV_FILE), {
      allowed: new Set(['DATABASE_URL']),
    });
    if (!apiEnv.DATABASE_URL) apiEnv.DATABASE_URL = values.DATABASE_URL;
  }
  if (apiEnv.GENERATION_MODE === 'owner' && !apiEnv.DATABASE_URL)
    throw new Error('OWNER_GENERATION_PERSISTENT_DATABASE_REQUIRED');
  // Paths are launcher configuration, not provider credentials or child configuration.
  delete apiEnv.DREAMWALK_SERVER_ENV_FILE;
  delete apiEnv.DREAMWALK_DATABASE_ENV_FILE;
  return { apiEnv, preparationEnv: preparationEnvironment(apiEnv) };
}
