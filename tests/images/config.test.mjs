/** Pure synthetic config/transport tests. No credentials, sockets, or runtime dotenv loader. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createImageRuntime,
  imageRequestProfile,
  imagePricing,
  imageEstimateProfile,
} from '../../apps/api/src/image-generation/config.ts';
import { generationRequestSchema } from '../../apps/api/src/image-generation/contracts.ts';
import { OpenAiImageProvider } from '../../apps/api/src/image-generation/provider.ts';
const now = Date.parse('2026-10-31T12:00:00Z');
// Synthetic evidence ONLY. These invented ceilings do not establish a real provider bound.
const syntheticBound = {
  evidenceKind: 'verified_token_ceiling',
  evidenceUrl: 'https://developers.openai.com/synthetic-test-evidence',
  verifiedAt: '2026-10-31T00:00:00Z',
  expiresAt: '2026-11-01T00:00:00Z',
  model: imageRequestProfile.model,
  size: '1024x1024',
  quality: 'low',
  outputs: 1,
  maxPromptUtf8Bytes: 8000,
  maxReferenceImages: 2,
  maxReferencePixels: 16777216,
  upperMicros: 50000,
  maxTextInputTokens: 1000,
  maxImageInputTokens: 2000,
  maxImageOutputTokens: 196,
};
const configured = () => ({
  IMAGE_PROVIDER: 'openai',
  IMAGE_EXTERNAL_ENABLED: 'true',
  IMAGE_NETWORK_APPROVED: 'true',
  IMAGE_SPEND_AUTHORIZED: 'true',
  IMAGE_APPROVAL_ID: 'synthetic-only',
  IMAGE_PRICING_ID: imagePricing.id,
  IMAGE_APPROVAL_TOTAL_MICROS: '1000000',
  IMAGE_APPROVAL_IMAGE_MICROS: '1000000',
  IMAGE_APPROVAL_TEXT_MICROS: '1000000',
  IMAGE_COST_BOUND_JSON: JSON.stringify(syntheticBound),
});
const input = (mode = 'external') =>
  generationRequestSchema.parse({
    adventureId: randomUUID(),
    prompt: 'A synthetic drawn room',
    title: 'Fixture',
    kind: 'background',
    camera: 'top-down',
    tags: [],
    background: 'opaque',
    mode,
    rights: {
      basis: 'generated',
      licenseLabel: 'Synthetic',
      attribution: '',
      allowAuthorReuse: false,
      attested: true,
    },
  });
test('default/malformed/unapproved configuration is fail-closed and never resolves credentials', () => {
  for (const env of [
    {},
    { ...configured(), IMAGE_COST_BOUND_JSON: 'private malformed text' },
    { ...configured(), IMAGE_SPEND_AUTHORIZED: 'false' },
    { ...configured(), IMAGE_APPROVAL_TOTAL_MICROS: '2000001' },
    { ...configured(), IMAGE_MODEL: 'unapproved' },
    { ...configured(), IMAGE_PRICING_ID: 'batch-rates' },
  ]) {
    let reads = 0;
    const runtime = createImageRuntime(env, {
      now,
      resolveApiKey: () => {
        reads++;
        throw new Error('Must not read key');
      },
    });
    assert.equal(reads, 0);
    assert.equal(runtime.capabilities.externalEnabled, false);
    assert.equal(runtime.capabilities.credentialState, 'not_checked');
    assert.equal(runtime.capabilities.planningEstimate.estimatedTotalMicros, 45880);
    assert.equal(runtime.capabilities.planningEstimate.operationalReserveMicros, 100000);
    assert.equal(runtime.capabilities.planningEstimate.costBasis, 'planning_estimate');
    assert.equal(runtime.capabilities.planningEstimate.maxReferenceImages, 0);
    assert.ok(runtime.capabilities.externalBlockReasons.length);
    assert.doesNotMatch(
      JSON.stringify(runtime.capabilities),
      /private malformed text|apiKey|Bearer/,
    );
  }
});
test('a calculator estimate, stale proof, partial token costs or different request cannot become a bound', () => {
  for (const bound of [
    { ...syntheticBound, evidenceKind: 'calculator_estimate' },
    { ...syntheticBound, expiresAt: '2026-10-30T00:00:00Z' },
    { ...syntheticBound, upperMicros: 1 },
    { ...syntheticBound, maxReferenceImages: 0 },
    { ...syntheticBound, size: 'auto' },
    { ...syntheticBound, evidenceUrl: 'https://attacker.invalid/proof' },
    { ...syntheticBound, evidenceUrl: 'https://private:secret@developers.openai.com/proof' },
    { ...syntheticBound, evidenceUrl: 'https://developers.openai.com/proof?key=private' },
  ]) {
    const runtime = createImageRuntime(
      { ...configured(), IMAGE_COST_BOUND_JSON: JSON.stringify(bound) },
      {
        now,
        resolveApiKey: () => {
          throw new Error('No credential read');
        },
      },
    );
    assert.ok(
      runtime.capabilities.externalBlockReasons.includes('VERIFIED_TOTAL_COST_BOUND_REQUIRED'),
    );
  }
});
test('validated factory routes fixture locally and one external generation through injected fixed-origin transport', async () => {
  let calls = 0;
  const runtime = createImageRuntime(configured(), {
    now,
    resolveApiKey: () => 'synthetic-private-key',
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/images/generations');
      assert.equal(options.redirect, 'error');
      const request = JSON.parse(options.body);
      assert.equal(request.model, imageRequestProfile.model);
      assert.equal(request.n, 1);
      assert.equal(request.quality, 'low');
      assert.equal(request.size, '1024x1024');
      assert.equal(request.output_format, 'png');
      return new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from('synthetic raster transport').toString('base64') }],
          usage: { input_tokens_details: { text_tokens: 10, image_tokens: 0 }, output_tokens: 196 },
        }),
        { headers: { 'x-request-id': 'req_synthetic' } },
      );
    },
  });
  assert.equal(runtime.capabilities.externalEnabled, true);
  assert.equal(runtime.policy.totalCapMicros, 1000000);
  assert.equal(runtime.capabilities.verifiedUpperMicros, 50000);
  assert.doesNotMatch(JSON.stringify(runtime.capabilities), /synthetic-private-key|apiKey|Bearer/);
  const fixture = await runtime.provider.generate(input('mock'), randomUUID(), []);
  assert.equal(fixture.actualMicros, 0);
  assert.equal(calls, 0);
  const result = await runtime.provider.generate(input(), randomUUID(), []);
  assert.equal(calls, 1);
  assert.equal(result.actualMicros, 5930);
  assert.equal(result.requestId, 'req_synthetic');
});
test('missing credential or expired pricing stays unavailable and does not dispatch', () => {
  const missing = createImageRuntime(configured(), { now, resolveApiKey: () => undefined });
  assert.equal(missing.capabilities.credentialState, 'missing');
  assert.ok(missing.capabilities.externalBlockReasons.includes('IMAGE_CREDENTIAL_REQUIRED'));
  const expired = createImageRuntime(configured(), {
    now: Date.parse('2026-11-02T00:00:00Z'),
    resolveApiKey: () => {
      throw new Error('No key read');
    },
  });
  assert.ok(expired.capabilities.externalBlockReasons.includes('VERIFIED_PRICING_REQUIRED'));
});
test('private source photos require a distinct owner authoring context and bounded combined references', () => {
  const base = input();
  assert.equal(
    generationRequestSchema.safeParse({ ...base, privateReferenceAssetIds: [randomUUID()] })
      .success,
    false,
  );
  const authoring = {
    ...base,
    adventureId: undefined,
    authoringContext: {
      projectId: randomUUID(),
      expectedProjectRevision: 1,
      sourceHash: 'a'.repeat(64),
      stage: 'concept',
      role: 'concept',
    },
    privateReferenceAssetIds: [randomUUID()],
  };
  assert.equal(generationRequestSchema.safeParse(authoring).success, true);
  assert.equal(
    generationRequestSchema.safeParse({
      ...authoring,
      referenceRevisionIds: [randomUUID(), randomUUID()],
    }).success,
    false,
  );
  assert.equal(
    generationRequestSchema.safeParse({ ...base, adventureId: undefined }).success,
    false,
  );
});

const estimateConfig = () => ({
  ...configured(),
  IMAGE_COST_MODE: 'estimate',
  IMAGE_ESTIMATE_PROFILE_ID: imageEstimateProfile.id,
  IMAGE_ESTIMATE_RISK_APPROVED: 'true',
  IMAGE_ESTIMATE_RISK_APPROVAL_ID: 'synthetic-offline-risk',
  IMAGE_ESTIMATE_RISK_EXPIRES_AT: '2026-10-31T13:00:00Z',
});
test('estimate preparation remains disabled without separate valid operator risk approval', () => {
  for (const env of [
    { ...estimateConfig(), IMAGE_ESTIMATE_RISK_APPROVED: 'false' },
    { ...estimateConfig(), IMAGE_ESTIMATE_RISK_EXPIRES_AT: '2026-10-30T13:00:00Z' },
    { ...estimateConfig(), IMAGE_ESTIMATE_RISK_EXPIRES_AT: '2026-10-31T15:00:00Z' },
    { ...estimateConfig(), IMAGE_APPROVAL_TOTAL_MICROS: '2000000' },
  ]) {
    const runtime = createImageRuntime(env, {
      now,
      resolveApiKey: () => {
        throw new Error('No key read while approval is pending');
      },
    });
    assert.equal(runtime.capabilities.externalEnabled, false);
    assert.equal(runtime.capabilities.verifiedUpperMicros, null);
    assert.equal(runtime.capabilities.estimatedTotalMicros, 45880);
    assert.equal(runtime.capabilities.reserveMicros, 100000);
  }
});
test('estimate planning remains non-dispatchable even with synthetic approval flags, while retaining honest inputs/output/reserve', async () => {
  let reads = 0,
    calls = 0;
  const runtime = createImageRuntime(estimateConfig(), {
    now,
    resolveApiKey: () => {
      reads++;
      return 'synthetic-no-network';
    },
    fetchImpl: async () => {
      calls++;
      throw new Error('Must not dispatch pending estimate');
    },
  });
  assert.equal(runtime.capabilities.externalEnabled, false);
  assert.equal(runtime.capabilities.costBasis, 'approved_estimate');
  assert.ok(
    runtime.capabilities.externalBlockReasons.includes('ESTIMATE_DISPATCH_APPROVAL_PENDING'),
  );
  assert.equal(runtime.capabilities.estimateDispatchReleased, false);
  assert.equal(runtime.capabilities.verifiedUpperMicros, null);
  assert.equal(runtime.policy.verifiedUpperMicros, null);
  assert.equal(runtime.policy.operationalReserveMicros, 100000);
  assert.equal(runtime.capabilities.requestProfile.maxReferenceImages, 0);
  assert.equal(
    imageEstimateProfile.estimatedTextInputMicros +
      imageEstimateProfile.estimatedImageInputMicros +
      imageEstimateProfile.estimatedImageOutputMicros,
    imageEstimateProfile.estimatedTotalMicros,
  );
  assert.equal(runtime.capabilities.providerEnforcesQuotedCap, false);
  await assert.rejects(
    () => runtime.provider.generate(input(), randomUUID(), []),
    /LIVE_COST_BOUND_REQUIRED/,
  );
  const direct = new OpenAiImageProvider({
    enabled: true,
    networkApproved: true,
    model: imageRequestProfile.model,
    verifiedUpperMicros: null,
    costBasis: 'approved_estimate',
    estimateRiskApproved: true,
    operationalReserveMicros: 100000,
    resolveApiKey: () => {
      reads++;
      return 'synthetic-no-network';
    },
    fetchImpl: async () => {
      calls++;
      throw new Error('No indirect dispatch');
    },
    ...imagePricing,
  });
  await assert.rejects(
    () => direct.generate(input(), randomUUID(), []),
    /ESTIMATE_DISPATCH_APPROVAL_PENDING/,
  );
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('bounded provider validates 2000 authored characters before adding hidden style', async () => {
  let sent;
  const runtime = createImageRuntime(configured(), {
    now,
    resolveApiKey: () => 'synthetic-key',
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body).prompt;
      return new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from('synthetic').toString('base64') }],
          usage: { input_tokens_details: { text_tokens: 1, image_tokens: 0 }, output_tokens: 1 },
        }),
        { headers: { 'x-request-id': 'synthetic-boundary' } },
      );
    },
  });
  const prompt = 'x'.repeat(2000);
  await runtime.provider.generate(
    { ...input(), prompt, requestPolicyVersion: 2 },
    randomUUID(),
    [],
  );
  assert.match(sent, /Default art: detailed drawn 2D anime/);
  assert.ok(sent.endsWith(prompt));
  assert.ok(sent.length > 2000);
});
