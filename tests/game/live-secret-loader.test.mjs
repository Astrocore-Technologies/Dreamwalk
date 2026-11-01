import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractAuthorizedLiveKey,
  loadAuthorizedLiveKey,
  resolveAuthorizedLiveSecretPath,
  launchManualLiveApi,
} from '../../scripts/local-live-loader.mjs';
import { readServerEnvironment, webEnvironment } from '../../scripts/server-environment.mjs';
import { forceMockNpcTestEnvironment } from '../../scripts/mock-npc-test-env.mjs';
test('private loader extracts only exact authorized variable without evaluating content', () => {
  const value = extractAuthorizedLiveKey(
    'OTHER_SECRET=unrelated\nNPC_AI_API_KEY="synthetic_private_key_123"\nDATABASE_URL=ignored\nEVIL=$(exit)\n',
  );
  assert.equal(value, 'synthetic_private_key_123');
  assert.throws(
    () => extractAuthorizedLiveKey('OPENAI_API_KEY=synthetic_private_key_123'),
    /MISSING_OR_DUPLICATED/,
  );
  assert.throws(
    () =>
      extractAuthorizedLiveKey(
        'NPC_AI_API_KEY=synthetic_private_key_123\nNPC_AI_API_KEY=synthetic_private_key_456',
      ),
    /MISSING_OR_DUPLICATED/,
  );
  assert.throws(() => extractAuthorizedLiveKey('NPC_AI_API_KEY=$(print-secret)'), /FILE_INVALID/);
});

test('owner server configuration passes synthetic credentials only to API environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamwalk-owner-env-test-'));
  try {
    const secret = join(root, 'synthetic-server.env');
    const database = join(root, 'synthetic-database.env');
    await writeFile(secret, 'OPENAI_API_KEY=synthetic-owner-key-only\n');
    await writeFile(database, 'DATABASE_URL=postgresql://synthetic:synthetic@127.0.0.1/example\n');
    await writeFile(
      join(root, '.env'),
      `GENERATION_MODE=owner\nGENERATION_OWNER_HANDLE=synthetic_owner\nGENERATION_OWNER_CONFIG_JSON='{}'\nDREAMWALK_SERVER_ENV_FILE="${secret.replaceAll('\\', '/')}"\nDREAMWALK_DATABASE_ENV_FILE="${database.replaceAll('\\', '/')}"\nAPI_URL=http://127.0.0.1:4000\n`,
    );
    const { apiEnv, preparationEnv } = await readServerEnvironment({
      root,
      env: { PATH: 'synthetic-path' },
    });
    assert.equal(apiEnv.OPENAI_API_KEY, 'synthetic-owner-key-only');
    assert.equal(apiEnv.GENERATION_OWNER_HANDLE, 'synthetic_owner');
    assert.equal(apiEnv.DREAMWALK_SERVER_ENV_FILE, undefined);
    assert.equal(preparationEnv.OPENAI_API_KEY, undefined);
    assert.equal(preparationEnv.GENERATION_OWNER_CONFIG_JSON, undefined);
    const web = webEnvironment(apiEnv);
    assert.equal(web.API_URL, 'http://127.0.0.1:4000');
    assert.equal(web.PATH, 'synthetic-path');
    for (const key of [
      'OPENAI_API_KEY',
      'GENERATION_OWNER_CONFIG_JSON',
      'DATABASE_URL',
      'DREAMWALK_SERVER_ENV_FILE',
    ])
      assert.equal(web[key], undefined);
    assert.equal(JSON.stringify(web).includes('synthetic-owner-key-only'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('owner mode cannot silently create a fresh database and hide earlier liabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamwalk-owner-env-test-'));
  try {
    await assert.rejects(
      readServerEnvironment({ root, env: { GENERATION_MODE: 'owner' } }),
      /OWNER_GENERATION_PERSISTENT_DATABASE_REQUIRED/,
    );
    const disabled = await readServerEnvironment({
      root,
      env: {
        GENERATION_MODE: 'disabled',
        DREAMWALK_SERVER_ENV_FILE: join(root, 'must-not-read.env'),
      },
    });
    assert.equal(disabled.apiEnv.OPENAI_API_KEY, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary launcher preparation cannot reintroduce root dotenv provider keys', async () => {
  const source = await readFile(new URL('../../scripts/dev.mjs', import.meta.url), 'utf8');
  assert.match(source, /run\(\['run', 'db:migrate', '-w', '@dreamwalk\/api'\]\)/);
  assert.match(source, /run\(\['run', 'db:seed', '-w', '@dreamwalk\/api'\]\)/);
  assert.match(
    source,
    /run\(\['scripts\/admin-grant\.mjs', '--email', process\.env\.LOCAL_ADMIN_EMAIL\], true\)/,
  );
  assert.doesNotMatch(source, /run\(\['run', '(?:db:migrate|db:seed|admin:grant)'\]\)/);
  assert.match(source, /env: webEnvironment\(process\.env\)/);
  assert.match(source, /delete apiEnv\.LOCAL_ADMIN_EMAIL/);
  assert.match(source, /'apps\/api\/dist\/main\.js'/);
});

test('private owner file rejects unrelated execution settings, links and ambiguous paths without echoing input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamwalk-owner-env-test-'));
  const env = {
    GENERATION_MODE: 'owner',
    DATABASE_URL: 'postgresql://synthetic@127.0.0.1/example',
  };
  try {
    const secret = join(root, 'synthetic-server.env');
    await writeFile(
      secret,
      'OPENAI_API_KEY=synthetic-only-key\nNODE_OPTIONS=--synthetic-not-executed\n',
    );
    await assert.rejects(
      readServerEnvironment({ root, env: { ...env, DREAMWALK_SERVER_ENV_FILE: secret } }),
      (error) => error.message === 'SERVER_CONFIGURATION_VARIABLE_NOT_ALLOWED',
    );
    await assert.rejects(
      readServerEnvironment({ root, env: { ...env, DREAMWALK_SERVER_ENV_FILE: 'relative.env' } }),
      /ABSOLUTE_PATH_REQUIRED/,
    );
    await writeFile(secret, 'x'.repeat(65537));
    await assert.rejects(
      readServerEnvironment({ root, env: { ...env, DREAMWALK_SERVER_ENV_FILE: secret } }),
      /FILE_INVALID/,
    );
    const link = join(root, 'synthetic-link.env');
    try {
      await symlink(secret, link);
    } catch (error) {
      if (error.code !== 'EPERM') throw error;
      return;
    }
    await assert.rejects(
      readServerEnvironment({ root, env: { ...env, DREAMWALK_SERVER_ENV_FILE: link } }),
      /FILE_INVALID/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('public credential variables are rejected and all owner settings are scrubbed from test children', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamwalk-owner-env-test-'));
  try {
    await assert.rejects(
      readServerEnvironment({ root, env: { NEXT_PUBLIC_OPENAI_API_KEY: 'synthetic-only' } }),
      /SERVER_CREDENTIAL_MUST_NOT_BE_PUBLIC/,
    );
    const env = {
      GENERATION_MODE: 'owner',
      GENERATION_OWNER_CONFIG_JSON: '{}',
      OPENAI_API_KEY: 'synthetic-only',
      DREAMWALK_SERVER_ENV_FILE: 'never-read',
      NPC_AI_API_KEY: 'synthetic-only',
      LIVE_TEST_ENABLED: 'true',
      IMAGE_EXTERNAL_ENABLED: 'true',
    };
    forceMockNpcTestEnvironment(env);
    assert.deepEqual(env, { NPC_AI_PROVIDER: 'mock', NPC_AI_EXTERNAL_APPROVED: 'false' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('loader reads synthetic file only and rejects oversized input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dreamwalk-loader-test-'));
  try {
    const path = join(dir, 'synthetic.env');
    await writeFile(path, 'NPC_AI_API_KEY=synthetic_only_key_123\nOTHER_SECRET=neverloaded');
    assert.equal(await loadAuthorizedLiveKey(path), 'synthetic_only_key_123');
    assert.throws(() => extractAuthorizedLiveKey('x'.repeat(65537)), /FILE_INVALID/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('secret paths are explicitly supplied and absolute; no machine-specific fallback', async () => {
  for (const value of [undefined, '', 'relative.env', 'relative/secret.env']) {
    assert.throws(
      () => resolveAuthorizedLiveSecretPath({ DREAMWALK_LIVE_SECRET_FILE: value }),
      /LIVE_SECRET_PATH_REQUIRED/,
    );
    await assert.rejects(loadAuthorizedLiveKey(value), /LIVE_SECRET_PATH_REQUIRED/);
  }
  const path = join(tmpdir(), 'synthetic-do-not-read.env');
  assert.equal(resolveAuthorizedLiveSecretPath({ DREAMWALK_LIVE_SECRET_FILE: path }), path);
  assert.throws(
    () => resolveAuthorizedLiveSecretPath({ DREAMWALK_LIVE_SECRET_FILE: path + '\0' }),
    /LIVE_SECRET_PATH_REQUIRED/,
  );
  await assert.rejects(
    launchManualLiveApi({ secretPath: path, env: { LIVE_TEST_ENABLED: 'false' } }),
    /LIVE_TEST_DISABLED/,
  );
});
