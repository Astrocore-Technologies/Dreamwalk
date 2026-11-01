import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractAuthorizedLiveKey,
  loadAuthorizedLiveKey,
  resolveAuthorizedLiveSecretPath,
  launchManualLiveApi,
} from '../../scripts/local-live-loader.mjs';
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
