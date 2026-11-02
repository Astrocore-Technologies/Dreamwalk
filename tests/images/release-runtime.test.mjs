/** Pure release adapter checks; credential resolver and transport are never invoked. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readOwnerGenerationConfig } from '../../apps/api/src/generation/config.ts';
import { createOwnerImageRuntime } from '../../apps/api/src/image-generation/config.ts';
import { ownerProfile, ownerEnvironment } from './owner-config-fixture.mjs';
test('release image adapter carries release identity and explicit aggregate ceiling without claiming authority', () => {
  const now = Date.parse('2026-11-01T03:00:00Z');
  const owner = readOwnerGenerationConfig(ownerEnvironment(ownerProfile(now)), now);
  const { ownerHandle: _ownerHandle, ...profile } = owner;
  const config = { ...profile, mode: 'release', aggregateCapMicros: 4000000 };
  const runtime = createOwnerImageRuntime(config, {
    resolveApiKey: () => assert.fail('Construction must not read credentials'),
    fetchImpl: () => assert.fail('Construction must not dispatch'),
  });
  assert.equal(runtime.policy.generationMode, 'release');
  assert.equal(runtime.capabilities.generationMode, 'release');
  assert.equal(runtime.policy.scopeId, 'release-unbound');
  assert.equal(runtime.policy.releaseAggregateCapMicros, 4000000);
  assert.equal(runtime.policy.generationAuthorizationId, undefined);
  assert.equal(runtime.capabilities.estimateRiskConsentRequired, true);
  assert.equal(runtime.capabilities.providerEnforcesQuotedCap, false);
  assert.match(runtime.policy.version, /^release-image-policy-v1:/);
});

test('release configuration is explicit, strict, account-independent and has an aggregate ceiling', async () => {
  const { readGenerationConfig } = await import('../../apps/api/src/generation/config.ts');
  const profile = { ...ownerProfile(), aggregateCapMicros: 4000000 };
  const env = { GENERATION_MODE: 'release', GENERATION_CONFIG_JSON: JSON.stringify(profile) };
  const value = readGenerationConfig(env);
  assert.equal(value.mode, 'release');
  assert.equal(value.ownerHandle, undefined);
  assert.equal(value.aggregateCapMicros, 4000000);
  assert.match(value.configFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(readGenerationConfig({}).mode, 'disabled');
  assert.throws(
    () => readGenerationConfig({ GENERATION_MODE: 'release' }),
    /GENERATION_CONFIG_INVALID/,
  );
  assert.throws(
    () => readGenerationConfig({ ...env, GENERATION_CONFIG_JSON: JSON.stringify(ownerProfile()) }),
    /GENERATION_AGGREGATE_CAP_REQUIRED/,
  );
  assert.throws(
    () =>
      readGenerationConfig({
        ...env,
        GENERATION_CONFIG_JSON: JSON.stringify({ ...profile, aggregateCapMicros: 1 }),
      }),
    /GENERATION_AGGREGATE_CAP_INVALID/,
  );
  assert.throws(
    () =>
      readGenerationConfig({
        ...env,
        GENERATION_CONFIG_JSON: JSON.stringify({
          ...profile,
          ownerHandle: 'leaked-owner-dependency',
        }),
      }),
    /CONFIG_INVALID/,
  );
});

test('explicit unlimited release has null operator caps, never fake high numbers or owner bypass', async () => {
  const { readGenerationConfig } = await import('../../apps/api/src/generation/config.ts');
  const original = ownerProfile();
  const { totalCapMicros, textCapMicros, imageCapMicros, ...models } = original;
  void totalCapMicros;
  void textCapMicros;
  void imageCapMicros;
  const profile = { ...models, allowance: 'unlimited' };
  const value = readGenerationConfig({
    GENERATION_MODE: 'release',
    GENERATION_CONFIG_JSON: JSON.stringify(profile),
  });
  assert.equal(value.allowance, 'unlimited');
  for (const key of ['totalCapMicros', 'textCapMicros', 'imageCapMicros', 'aggregateCapMicros'])
    assert.equal(value[key], null);
  assert.equal(value.ownerHandle, undefined);
  for (const patch of [{ aggregateCapMicros: 1 }, { totalCapMicros: 1 }, { allowance: 'anything' }])
    assert.throws(() =>
      readGenerationConfig({
        GENERATION_MODE: 'release',
        GENERATION_CONFIG_JSON: JSON.stringify({ ...profile, ...patch }),
      }),
    );
  assert.throws(() => readOwnerGenerationConfig(ownerEnvironment(profile)));
});

test('reviewed cache tariffs are immutable profile identity and cannot omit a write class', async () => {
  const { readGenerationConfig } = await import('../../apps/api/src/generation/config.ts');
  const profile = { ...ownerProfile(), aggregateCapMicros: 4000000 };
  profile.text.cachePricing = {
    cachedInputMicrosPerMillion: 10000,
    cacheWrite30mMicrosPerMillion: 125000,
    cacheWrite12hMicrosPerMillion: 250000,
  };
  const parse = () =>
    readGenerationConfig({
      GENERATION_MODE: 'release',
      GENERATION_CONFIG_JSON: JSON.stringify(profile),
    });
  const before = parse();
  assert.equal(Object.isFrozen(before.text.cachePricing), true);
  profile.text.cachePricing.cacheWrite30mMicrosPerMillion++;
  assert.notEqual(parse().configFingerprint, before.configFingerprint);
  delete profile.text.cachePricing.cacheWrite12hMicrosPerMillion;
  assert.throws(parse);
});
