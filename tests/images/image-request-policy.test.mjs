import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { imageProviderRequest } = require('../../apps/api/dist/image-generation/request-policy.js');
const { estimateImageRequest } = require('../../apps/api/dist/generation/estimates.js');
const base = {
  prompt: 'A blue fox. Explicit style: watercolor.',
  kind: 'portrait',
  camera: 'portrait',
};
test('new image requests enforce hidden anime fallback without replacing explicit style', () => {
  const request = { ...base, requestPolicyVersion: 2 };
  const prepared = imageProviderRequest(request);
  assert.match(prepared.prompt, /Default art: detailed drawn 2D anime/);
  assert.match(prepared.prompt, /Explicit author art style takes precedence/);
  assert.ok(prepared.prompt.endsWith(base.prompt));
  assert.equal(request.prompt, base.prompt);
  assert.deepEqual(imageProviderRequest(prepared), prepared);
  assert.equal(imageProviderRequest(base), base);
});
test('cover and map defaults preserve subject geometry while legacy inputs remain unchanged', () => {
  const cover = imageProviderRequest({ ...base, requestPolicyVersion: 2, storyCoverContext: {} });
  assert.match(cover.prompt, /cinematic key art/);
  const map = imageProviderRequest({
    ...base,
    requestPolicyVersion: 2,
    kind: 'background',
    camera: 'top-down',
  });
  assert.match(map.prompt, /preserve required camera and gameplay geometry/);
});
test('new estimate reservation removes legacy fixed floor without rewriting old quotes', () => {
  const profile = {
    model: 'fixture',
    size: '1024x1024',
    quality: 'medium',
    outputs: 1,
    maxPromptUtf8Bytes: 8000,
    maxReferenceImages: 0,
    inputTextMicrosPerMillion: 5000000,
    inputImageMicrosPerMillion: 10000000,
    outputImageMicrosPerMillion: 40000000,
    estimatedTotalMicros: 45880,
    reserveMicros: 100000,
  };
  const old = estimateImageRequest(base.prompt, 0, profile, 'fixture');
  const fresh = estimateImageRequest(base.prompt, 0, profile, 'fixture', true);
  assert.equal(old.reserveMicros, 100000);
  assert.equal(fresh.reserveMicros, 45880);
  assert.equal(fresh.fixedMarginMicros, 0);
  assert.equal(fresh.estimatedTotalMicros, fresh.reserveMicros);
  assert.notEqual(fresh.fingerprint, old.fingerprint);
});

test('persisted pre-policy quote validates with its original larger hold; policy cannot be swapped', () => {
  const { createHash, randomUUID } = require('node:crypto');
  // Constructor-only check: no DB instance or network access is created.
  process.env.DATABASE_URL ??= 'postgres://fixture:fixture@127.0.0.1:9/unused';
  const { ImageGenerationEngine } = require('../../apps/api/dist/image-generation/service.js');
  const { generationRequestSchema } = require('../../apps/api/dist/image-generation/contracts.js');
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  const hash = (v) =>
    createHash('sha256')
      .update(JSON.stringify(canonical(v)))
      .digest('hex');
  const input = generationRequestSchema.parse({
    ...base,
    adventureId: randomUUID(),
    title: 'Legacy fixture',
    tags: [],
    background: 'opaque',
    mode: 'external',
    rights: {
      basis: 'generated',
      licenseLabel: 'Fixture',
      attribution: '',
      allowAuthorReuse: false,
      attested: true,
    },
  });
  const policy = {
    generationMode: 'owner',
    costBasis: 'approved_estimate',
    estimatedTotalMicros: 45880,
    operationalReserveMicros: 100000,
    version: 'historical-fixture',
  };
  const engine = new ImageGenerationEngine({}, {}, { id: 'historical-provider' }, policy);
  const row = {
    input,
    reference_hashes: {},
    policy_version: policy.version,
    upper_micros: 100000,
    cost_basis: 'approved_estimate',
    estimated_total_micros: 45880,
  };
  row.request_hash = hash({
    input,
    refs: {},
    policy: policy.version,
    provider: 'historical-provider',
    upper: 100000,
  });
  assert.doesNotThrow(() => engine.assertQuotedProvider(row));
  assert.equal(engine.reservationMicros(input), 100000);
  assert.equal(engine.reservationMicros({ ...input, requestPolicyVersion: 2 }), 45880);
  assert.throws(() =>
    engine.assertQuotedProvider({ ...row, input: { ...input, requestPolicyVersion: 2 } }),
  );
  assert.doesNotThrow(() => engine.assertQuotedProvider(row, 'historical-provider'));
});
