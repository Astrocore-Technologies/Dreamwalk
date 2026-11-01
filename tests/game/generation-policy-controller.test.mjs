/** Injected controller only: no database, app, credentials or provider transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
// Required solely by imported DI class metadata. No Db instance or connection is constructed.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic';
const require = createRequire(import.meta.url);
const { GenerationController } = require('../../apps/api/dist/generation/controller.js');
async function status({
  remaining = 50,
  reserve = 100,
  perRequest = true,
  held = 0,
  state = 'active',
  stopCode = null,
  imageOnlyAdmission = false,
  retainedImageHoldMicros = 0,
  external = true,
  mode = 'owner',
} = {}) {
  const auth = { require: async () => ({ id: 'synthetic-owner' }) };
  const authority = {
    status: async () => ({
      mode,
      enabled: true,
      state,
      stopCode,
      imageOnlyAdmission,
      retainedImageHoldMicros,
      imageRemainingMicros: remaining,
      remainingMicros: remaining,
      heldMicros: held,
    }),
  };
  const images = {
    configuration: () => ({
      externalEnabled: external,
      externalBlockReasons: external ? [] : ['EXTERNAL_PROVIDER_DISABLED'],
      requestEstimationEnabled: perRequest,
      reserveMicros: reserve,
      verifiedUpperMicros: null,
      generationMode: 'owner',
      costBasis: 'approved_estimate',
      estimatedTotalMicros: 10,
      requestProfile: null,
    }),
  };
  return new GenerationController(auth, authority, images).status({});
}
test('heuristic image quote capability needs headroom, not the profile-wide example reserve', async () => {
  const value = await status();
  assert.equal(value.imagesEnabled, true);
  assert.equal(value.imageBlockCode, null);
  assert.equal(value.imageConfiguration.requestEstimationEnabled, true);
});
test('concrete fixed reserve remains required for legacy owner and manual profile', async () => {
  for (const options of [{ perRequest: false }, { mode: 'manual' }]) {
    const value = await status(options);
    assert.equal(value.imagesEnabled, false);
    assert.equal(value.imageBlockCode, 'GENERATION_BUDGET_EXCEEDED');
  }
});
test('per-request quote capability keeps zero-budget, held, stopped and provider gates', async () => {
  for (const [options, code] of [
    [{ remaining: 0 }, 'GENERATION_BUDGET_EXCEEDED'],
    [{ held: 1 }, 'GENERATION_OUTSTANDING_REQUEST'],
    [{ state: 'stopped' }, 'MANUAL_LIVE_SESSION_REQUIRED'],
    [{ external: false }, 'EXTERNAL_PROVIDER_DISABLED'],
  ]) {
    const value = await status(options);
    assert.equal(value.imagesEnabled, false);
    assert.equal(value.imageBlockCode, code);
  }
});

test('a stopped unknown image exposes its real reason even while its reserve is held', async () => {
  const value = await status({ state: 'stopped', held: 66900, stopCode: 'IMAGE_RESULT_UNKNOWN' });
  assert.equal(value.imagesEnabled, false);
  assert.equal(value.imageBlockCode, 'IMAGE_RESULT_UNKNOWN');
});

test('only a server-verified model refusal can keep its hold while enabling a distinct image', async () => {
  const options = {
    state: 'stopped',
    stopCode: 'IMAGE_RESULT_UNKNOWN',
    held: 66900,
    remaining: 933100,
    imageOnlyAdmission: true,
    retainedImageHoldMicros: 66900,
  };
  assert.equal((await status(options)).imagesEnabled, true);
  assert.equal(
    (await status({ ...options, held: 100000 })).imageBlockCode,
    'GENERATION_OUTSTANDING_REQUEST',
  );
  assert.equal((await status({ ...options, imageOnlyAdmission: false })).imagesEnabled, false);
  assert.equal((await status({ ...options, remaining: 0 })).imagesEnabled, false);
});
