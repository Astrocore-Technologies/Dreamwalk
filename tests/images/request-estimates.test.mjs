/** Synthetic operator assumptions/rates only; no provider/key/database or official pricing claims. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  estimateImageRequest,
  estimateTextRequest,
  imagePricingProfileSnapshot,
} from '../../apps/api/src/generation/estimates.ts';
import { readOwnerGenerationConfig } from '../../apps/api/src/generation/config.ts';
import {
  ownerEnvironment,
  legacyOwnerProfile,
  requestEstimateOwnerProfile,
} from './owner-config-fixture.mjs';
const now = Date.parse('2026-11-01T03:00:00Z');
const parse = (p) => readOwnerGenerationConfig(ownerEnvironment(p), now);
const configured = () => parse(requestEstimateOwnerProfile(now));
test('image reserves use actual UTF8 prompt, configured output, exact integer margin and separate uncertain reference allowance', () => {
  const p = configured().image;
  const small = estimateImageRequest('hello', 0, p, 'fixture-provider'),
    large = estimateImageRequest('h'.repeat(1024), 0, p, 'fixture-provider');
  assert.equal(small.promptUtf8Bytes, 5);
  assert.equal(small.inputTextTokensEstimate, 37);
  assert.equal(small.outputImageTokensEstimate, 1000);
  assert.equal(small.estimatedTotalMicros, 3037);
  assert.equal(small.percentageMarginMicros, 760);
  assert.equal(small.reserveMicros, 4797);
  assert.ok(large.reserveMicros > small.reserveMicros);
  const reference = estimateImageRequest('hello', 1, p, 'fixture-provider');
  assert.equal(reference.inputImageTokensEstimate, 1200);
  assert.equal(reference.inputImageMicros, 2400);
  assert.equal(reference.referenceAllowanceMicros, 10000);
  assert.equal(reference.uncertainReferences, true);
  assert.equal(
    reference.reserveMicros,
    reference.estimatedTotalMicros +
      reference.percentageMarginMicros +
      reference.fixedMarginMicros +
      reference.referenceAllowanceMicros,
  );
  assert.equal(small.providerEnforcesQuotedCap, false);
  assert.equal(small.basis, 'operator_heuristic');
  const unicode = estimateImageRequest('Ж🙂', 0, p, 'fixture-provider');
  assert.equal(unicode.promptUtf8Bytes, 6);
});
test('configuration minimum can fit while a maximum request is unaffordable; requests are not clipped', () => {
  const raw = requestEstimateOwnerProfile(now);
  raw.imageCapMicros = 10000;
  const c = parse(raw);
  const small = estimateImageRequest('hello', 0, c.image, 'fixture-provider');
  const expensive = estimateImageRequest('x'.repeat(8000), 2, c.image, 'fixture-provider');
  assert.ok(small.reserveMicros < 10000);
  assert.ok(expensive.reserveMicros > 10000);
  assert.notEqual(expensive.reserveMicros, 10000);
  const impossible = requestEstimateOwnerProfile(now);
  impossible.imageCapMicros = 1000;
  assert.throws(() => parse(impossible), /OWNER_GENERATION_BUDGET_INVALID/);
});
test('profile/estimate identities bind model, size, quality, rates and operator policy without raw private content', () => {
  const c = configured(),
    p = c.image;
  const snapshot = estimateImageRequest('PRIVATE_PROMPT_CANARY', 1, p, 'provider');
  const pricing = imagePricingProfileSnapshot(p);
  assert.equal(snapshot.pricingProfileId, pricing.id);
  assert.equal(snapshot.pricingProfileHash, pricing.fingerprint);
  assert.equal(pricing.model, p.model);
  assert.equal(pricing.size, p.size);
  assert.equal(pricing.quality, p.quality);
  assert.doesNotMatch(
    JSON.stringify({ snapshot, pricing }),
    /PRIVATE_PROMPT_CANARY|filename|revisionId|apiKey|Bearer/,
  );
  for (const change of [
    { ...p, model: 'another' },
    { ...p, size: '1024x1024' },
    { ...p, quality: 'high' },
    { ...p, inputTextMicrosPerMillion: 2 },
    { ...p, estimation: { ...p.estimation, marginBps: 3000 } },
  ])
    assert.notEqual(imagePricingProfileSnapshot(change).fingerprint, pricing.fingerprint);
  assert.notEqual(
    estimateImageRequest('OTHER', 1, p, 'provider').fingerprint,
    snapshot.fingerprint,
  );
  assert.equal(
    estimateImageRequest('PRIVATE_PROMPT_CANARY', 1, p, 'provider').fingerprint,
    snapshot.fingerprint,
  );
});
test('text planning measures the entire serialized envelope and keeps context capacity separate from per-request price', () => {
  const p = configured().text,
    body = JSON.stringify({
      instructions: 'PRIVATE_TEXT_CANARY',
      input: [{ role: 'user', content: 'hello' }],
      schema: { type: 'object' },
    });
  const quote = estimateTextRequest(body, p, 'provider');
  assert.equal(quote.serializedBytes, Buffer.byteLength(body));
  assert.equal(quote.estimatedInputTokens, quote.serializedBytes + p.estimation.textProtocolTokens);
  assert.equal(quote.protocolTokenAllowance, 4096);
  assert.equal(quote.costBasis, 'operator_estimate');
  assert.ok(quote.estimatedInputTokens < p.contextTokens);
  assert.equal(
    quote.reserveMicros,
    quote.estimatedTotalMicros + quote.percentageMarginMicros + quote.fixedMarginMicros,
  );
  assert.doesNotMatch(JSON.stringify(quote), /PRIVATE_TEXT_CANARY|instructions|content/);
  const capacityOnly = estimateTextRequest(body, { ...p, contextTokens: 262144 }, 'provider');
  assert.equal(capacityOnly.reserveMicros, quote.reserveMicros);
  assert.notEqual(estimateTextRequest(body + ' ', p, 'provider').bodySha256, quote.bodySha256);
});
test('legacy fixed owner policy retains exact historical config fingerprint and explicit legacy reserve label', () => {
  const raw = legacyOwnerProfile(now),
    c = parse(raw);
  const expected = {
    mode: 'owner',
    ownerHandle: 'synthetic_owner',
    totalCapMicros: raw.totalCapMicros,
    textCapMicros: raw.textCapMicros,
    imageCapMicros: raw.imageCapMicros,
    text: { ...raw.text, upperMicros: 132096 },
    image: {
      ...raw.image,
      maxReferenceBytes: 5 * 1024 * 1024,
      maxReferencePixels: 4096 * 4096,
      costBasis: 'approved_estimate',
      providerEnforcesQuotedCap: false,
    },
  };
  assert.equal(
    c.configFingerprint,
    createHash('sha256').update(JSON.stringify(expected)).digest('hex'),
  );
  const legacy = estimateImageRequest('small', 0, c.image, 'provider');
  assert.equal(legacy.basis, 'legacy_fixed');
  assert.equal(legacy.reserveMicros, 100000);
  assert.equal(legacy.estimatedTotalMicros, 50000);
  assert.equal(legacy.inputTextTokensEstimate, null);
  assert.equal(estimateTextRequest('{}', c.text, 'provider').reserveMicros, 132096);
});
test('BigInt preserves oversized intermediate arithmetic and rejects unsafe DTO totals or malformed/negative/zero policies', () => {
  const p = configured().image;
  const large = {
    ...p,
    inputTextMicrosPerMillion: 1000000000000,
    outputImageMicrosPerMillion: 1000000000000,
  };
  const quote = estimateImageRequest('x'.repeat(8000), 0, large, 'provider');
  assert.equal(quote.inputTextMicros, 8032000000);
  assert.equal(quote.outputImageMicros, 1000000000);
  assert.throws(
    () =>
      estimateImageRequest(
        'x',
        0,
        {
          ...p,
          outputImageMicrosPerMillion: Number.MAX_SAFE_INTEGER,
          estimation: { ...p.estimation, outputImageTokens: 1048576 },
        },
        'provider',
      ),
    /GENERATION_ESTIMATION_OVERFLOW/,
  );
  for (const mutate of [
    (p) => (p.image.estimation.marginBps = -1),
    (p) => (p.image.estimation.textTokensPerKiBUtf8 = 0),
    (p) => (p.image.estimation.outputImageTokens = 0),
    (p) => (p.image.estimation.referenceAllowanceMicros = -1),
    (p) => (p.image.estimation.fixedMarginMicros = Number.MAX_SAFE_INTEGER + 1),
    (p) => (p.image.estimation.kind = 'official_tokenizer'),
    (p) => (p.text.estimation.textProtocolTokens = -1),
    (p) => (p.image.reserveMicros = 100000),
  ]) {
    const raw = requestEstimateOwnerProfile(now);
    mutate(raw);
    assert.throws(() => parse(raw), /OWNER_GENERATION_/);
  }
  assert.throws(() => estimateImageRequest('x', 3, p, 'provider'), /GENERATION_ESTIMATION_INVALID/);
  assert.throws(
    () => estimateTextRequest('x'.repeat(64001), configured().text, 'provider'),
    /GENERATION_INPUT_TOO_LARGE/,
  );
});

test('an in-flight synthetic provider receipt retains the original rates after caller configuration changes', async () => {
  const { OwnerOpenAiImageProvider } =
    await import('../../apps/api/src/image-generation/provider.ts');
  const mutable = structuredClone(configured());
  let signalStarted, resolveResponse;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const response = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  const provider = new OwnerOpenAiImageProvider(mutable, {
    now: () => now,
    resolveApiKey: () => 'synthetic-no-network',
    fetchImpl: async () => {
      signalStarted();
      return response;
    },
  });
  const pending = provider.generate(
    {
      adventureId: '11111111-1111-4111-8111-111111111111',
      prompt: 'synthetic pricing only',
      title: 'fixture',
      kind: 'background',
      camera: 'top-down',
      tags: [],
      background: 'opaque',
      referenceRevisionIds: [],
      privateReferenceAssetIds: [],
      mode: 'external',
      rights: {
        basis: 'generated',
        licenseLabel: 'synthetic',
        attribution: '',
        allowAuthorReuse: false,
        attested: true,
      },
    },
    'synthetic-dispatch',
    [],
  );
  await started;
  mutable.image.inputTextMicrosPerMillion = 9000000;
  mutable.image.outputImageMicrosPerMillion = 99000000;
  resolveResponse(
    new Response(
      JSON.stringify({
        data: [{ b64_json: 'eA==' }],
        usage: { input_tokens_details: { text_tokens: 100, image_tokens: 0 }, output_tokens: 100 },
      }),
    ),
  );
  assert.equal((await pending).actualMicros, 400);
});
