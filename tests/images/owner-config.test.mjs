import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fixturePng } from './support.mjs';
import sharp from 'sharp';
import { readOwnerGenerationConfig } from '../../apps/api/src/generation/config.ts';
import {
  createOwnerImageRuntime,
  createImageRuntime,
} from '../../apps/api/src/image-generation/config.ts';
import { generationRequestSchema } from '../../apps/api/src/image-generation/contracts.ts';
import { ownerProfile, ownerEnvironment } from './owner-config-fixture.mjs';
const now = Date.parse('2026-11-01T03:00:00Z');
const config = (p = ownerProfile(now)) => readOwnerGenerationConfig(ownerEnvironment(p), now);
const request = (extra = {}) => ({
  adventureId: randomUUID(),
  prompt: 'Synthetic private scene',
  title: 'Synthetic test',
  kind: 'background',
  camera: 'top-down',
  tags: [],
  background: 'opaque',
  referenceRevisionIds: [],
  mode: 'external',
  rights: {
    basis: 'generated',
    licenseLabel: 'Synthetic',
    attribution: '',
    allowAuthorReuse: true,
    attested: true,
  },
  ...extra,
});
const result = (
  usage = { input_tokens_details: { text_tokens: 100, image_tokens: 0 }, output_tokens: 100 },
) =>
  new Response(
    JSON.stringify({
      data: [{ b64_json: Buffer.from('synthetic-not-an-admitted-raster').toString('base64') }],
      usage,
    }),
    { headers: { 'Content-Type': 'application/json', 'x-request-id': 'synthetic-receipt' } },
  );

test('owner config is strict, nonsecret, no default activation, and not restricted to two hours', () => {
  assert.deepEqual(readOwnerGenerationConfig({}, now), { mode: 'disabled' });
  assert.deepEqual(readOwnerGenerationConfig({ GENERATION_MODE: 'disabled' }, now), {
    mode: 'disabled',
  });
  for (const env of [
    { GENERATION_MODE: 'typo' },
    { GENERATION_MODE: 'owner' },
    { ...ownerEnvironment(ownerProfile(now)), GENERATION_OWNER_CONFIG_JSON: 'SECRET_MALFORMED' },
  ]) {
    assert.throws(
      () => readOwnerGenerationConfig(env, now),
      (e) => e.message.startsWith('OWNER_GENERATION_') && !e.message.includes('SECRET'),
    );
  }
  const env = ownerEnvironment(ownerProfile(now));
  Object.defineProperty(env, 'OPENAI_API_KEY', {
    get() {
      throw new Error('MUST_NOT_READ_KEY');
    },
  });
  const c = readOwnerGenerationConfig(env, now);
  assert.equal(c.mode, 'owner');
  assert.equal(c.text.upperMicros, 132096);
  assert.equal(c.image.costBasis, 'approved_estimate');
  assert.equal(c.image.providerEnforcesQuotedCap, false);
  assert.ok(Date.parse(c.image.pricing.validUntil) > now + 2 * 3600000);
  assert.ok(Object.isFrozen(c.image.pricing));
  assert.ok(Object.isFrozen(c));
  assert.equal(c.configFingerprint, config().configFingerprint);
  for (const mutate of [
    (p) => (p.text.model = 'changed-text'),
    (p) => (p.image.model = 'changed-image'),
    (p) => p.image.reserveMicros++,
    (p) => p.totalCapMicros++,
    (p) => p.text.inputMicrosPerMillion++,
    (p) => (p.image.pricing.validUntil = new Date(now + 86400000).toISOString()),
  ]) {
    const p = ownerProfile(now);
    mutate(p);
    assert.notEqual(config(p).configFingerprint, c.configFingerprint);
  }
});

test('invalid prices, risk, references, unknown fields, scope, and URL credentials fail closed', () => {
  for (const mutate of [
    (p) => (p.scopeId = 'reset-budget'),
    (p) => (p.secret = 'SECRET_DO_NOT_ECHO'),
    (p) => (p.image.apiKey = 'SECRET_DO_NOT_ECHO'),
    (p) => (p.image.reserveMicros = 49999),
    (p) => (p.image.estimatedTotalMicros = 0),
    (p) => (p.image.reserveMicros = Number.MAX_SAFE_INTEGER + 1),
    (p) => (p.image.maxReferenceImages = 3),
    (p) => (p.image.outputs = 2),
    (p) => (p.image.estimateRiskAccepted = false),
    (p) => (p.text.inputMicrosPerMillion = 0),
    (p) => (p.text.contextTokens = 1024),
    (p) => (p.image.pricing.source = 'https://user:SECRET_DO_NOT_ECHO@openai.com/pricing'),
    (p) => (p.image.pricing.source = 'https://openai.com/pricing?key=SECRET_DO_NOT_ECHO'),
    (p) => (p.image.pricing.source = 'https://openai.com.evil.invalid/pricing'),
    (p) => (p.image.pricing.validUntil = new Date(now).toISOString()),
    (p) => (p.text.pricing.reviewedAt = new Date(now + 1).toISOString()),
    (p) => (p.textCapMicros = 1),
    (p) => (p.imageCapMicros = 99999),
  ]) {
    const p = ownerProfile(now);
    mutate(p);
    assert.throws(
      () => config(p),
      (e) => e.message.startsWith('OWNER_GENERATION_') && !e.message.includes('SECRET'),
    );
  }
});

test('owner factory is pure, dynamic profile reaches one fixed-origin transport without releasing legacy gate', async () => {
  let reads = 0,
    calls = 0;
  const runtime = createOwnerImageRuntime(config(), {
    now: () => now,
    resolveApiKey: () => {
      reads++;
      return 'fake-owner-key';
    },
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/images/generations');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, 'Bearer fake-owner-key');
      const b = JSON.parse(init.body);
      assert.equal(b.model, 'synthetic-owner-image');
      assert.equal(b.size, '1536x1024');
      assert.equal(b.quality, 'medium');
      assert.equal(b.n, 1);
      assert.equal(b.stream, false);
      return result();
    },
  });
  assert.equal(reads, 0);
  assert.equal(calls, 0);
  assert.equal(runtime.capabilities.externalEnabled, true);
  assert.equal(runtime.capabilities.generationMode, 'owner');
  assert.equal(runtime.capabilities.estimateRiskConsentRequired, true);
  assert.equal(runtime.capabilities.ownerEstimateEnabled, true);
  assert.equal(runtime.capabilities.estimateDispatchReleased, false);
  assert.equal(runtime.capabilities.verifiedUpperMicros, null);
  assert.equal(runtime.capabilities.credentialState, 'not_checked');
  const receipt = await runtime.provider.generate(request(), 'synthetic-dispatch', []);
  assert.equal(receipt.actualMicros, 400);
  assert.equal(reads, 1);
  assert.equal(calls, 1);
  const legacy = createImageRuntime(
    { IMAGE_COST_MODE: 'estimate', IMAGE_ESTIMATE_RISK_APPROVED: 'true' },
    {
      now,
      resolveApiKey: () => {
        throw new Error('MUST_NOT_READ');
      },
    },
  );
  assert.equal(legacy.capabilities.externalEnabled, false);
  assert.equal(legacy.capabilities.estimateDispatchReleased, false);
  assert.ok(
    legacy.capabilities.externalBlockReasons.includes('ESTIMATE_DISPATCH_APPROVAL_PENDING'),
  );
});

test('pricing expiry, alias mismatch, oversized prompt and references reject before key/transport', async () => {
  let clock = now,
    reads = 0,
    calls = 0;
  const runtime = createOwnerImageRuntime(config(), {
    now: () => clock,
    resolveApiKey: () => {
      reads++;
      return 'fake';
    },
    fetchImpl: async () => {
      calls++;
      return result();
    },
  });
  await assert.rejects(
    runtime.provider.generate(
      request({ generationAuthorizationId: randomUUID(), liveTestSessionId: randomUUID() }),
      'id',
      [],
    ),
  );
  assert.equal(
    generationRequestSchema.safeParse(request({ generationAuthorizationId: 'not-a-uuid' })).success,
    false,
  );
  await assert.rejects(
    runtime.provider.generate(request({ referenceRevisionIds: [randomUUID()] }), 'id', []),
    /IMAGE_REFERENCE_ESTIMATE_UNAVAILABLE/,
  );
  await assert.rejects(runtime.provider.generate(request({ prompt: 'x'.repeat(2001) }), 'id', []));
  clock = Date.parse(config().image.pricing.validUntil);
  await assert.rejects(
    runtime.provider.generate(request(), 'id', []),
    /OWNER_GENERATION_CURRENT_PRICING_REQUIRED/,
  );
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('missing/malformed/unsafe usage stays unknown and failures never retry or become fixtures', async () => {
  for (const usage of [
    undefined,
    {},
    { input_tokens_details: { text_tokens: -1, image_tokens: 0 }, output_tokens: 1 },
    { input_tokens_details: { text_tokens: 1.5, image_tokens: 0 }, output_tokens: 1 },
    {
      input_tokens_details: { text_tokens: Number.MAX_SAFE_INTEGER, image_tokens: 0 },
      output_tokens: Number.MAX_SAFE_INTEGER,
    },
  ]) {
    let calls = 0;
    const runtime = createOwnerImageRuntime(config(), {
      now: () => now,
      resolveApiKey: () => 'fake',
      fetchImpl: async () => {
        calls++;
        return usage === undefined
          ? new Response(JSON.stringify({ data: [{ b64_json: 'eA==' }] }))
          : result(usage);
      },
    });
    assert.equal((await runtime.provider.generate(request(), 'id', [])).actualMicros, undefined);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const runtime = createOwnerImageRuntime(config(), {
    now: () => now,
    resolveApiKey: () => 'fake',
    fetchImpl: async () => {
      calls++;
      throw new Error('synthetic timeout');
    },
  });
  await assert.rejects(runtime.provider.generate(request(), 'id', []), /synthetic timeout/);
  assert.equal(calls, 1);
  const missing = createOwnerImageRuntime(config(), {
    now: () => now,
    resolveApiKey: () => undefined,
    fetchImpl: async () => {
      throw new Error('MUST_NOT_CALL');
    },
  });
  await assert.rejects(missing.provider.generate(request(), 'id', []), /IMAGE_CREDENTIAL_REQUIRED/);
});

test('dynamic image rates use exact BigInt rounding even when intermediate products exceed safe Number precision', async () => {
  const profile = ownerProfile(now);
  profile.image.inputTextMicrosPerMillion = 999999999997;
  profile.image.outputImageMicrosPerMillion = 999999999991;
  const runtime = createOwnerImageRuntime(config(profile), {
    now: () => now,
    resolveApiKey: () => 'fake-exact-accounting',
    fetchImpl: async () =>
      result({ input_tokens_details: { text_tokens: 9000001, image_tokens: 0 }, output_tokens: 7 }),
  });
  const receipt = await runtime.provider.generate(request(), 'synthetic-exact', []);
  const expected = Number((9000001n * 999999999997n + 7n * 999999999991n + 999999n) / 1000000n);
  assert.equal(receipt.actualMicros, expected);
  assert.ok(
    receipt.actualMicros > profile.image.reserveMicros,
    'known over-reserve bill is not clamped to an estimate',
  );
});

test('explicit bounded owner references use one multipart edit and account image input tokens', async () => {
  const profile = ownerProfile(now);
  profile.image.maxReferenceImages = 2;
  const configured = config(profile),
    revisionId = randomUUID(),
    bytes = await fixturePng();
  const ref = {
    revisionId,
    bytes,
    mime: 'image/png',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  let reads = 0,
    calls = 0;
  const runtime = createOwnerImageRuntime(configured, {
    now: () => now,
    resolveApiKey: () => {
      reads++;
      return 'fake-photo-key';
    },
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/images/edits');
      assert.ok(init.body instanceof FormData);
      assert.equal(init.headers['Content-Type'], undefined);
      assert.equal(init.redirect, 'error');
      assert.equal(init.body.get('model'), profile.image.model);
      assert.equal(init.body.get('size'), profile.image.size);
      assert.equal(init.body.get('n'), '1');
      assert.equal(init.body.get('output_format'), 'png');
      const files = init.body.getAll('image[]');
      assert.equal(files.length, 1);
      assert.equal(files[0].type, 'image/png');
      assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), bytes);
      return result({
        input_tokens_details: { text_tokens: 100, image_tokens: 200 },
        output_tokens: 100,
      });
    },
  });
  assert.equal(reads, 0);
  assert.equal(runtime.capabilities.requestProfile.maxReferenceImages, 2);
  assert.equal(runtime.capabilities.requestProfile.maxReferenceBytes, 5 * 1024 * 1024);
  assert.equal(configured.image.maxReferencePixels, 4096 * 4096);
  const photoRequest = request({
    privateReferenceAssetIds: [revisionId],
    authoringContext: {
      projectId: randomUUID(),
      expectedProjectRevision: 1,
      sourceHash: 'a'.repeat(64),
      stage: 'concept',
      role: 'concept',
    },
  });
  assert.equal(
    (await runtime.provider.generate(photoRequest, 'synthetic-photo', [ref])).actualMicros,
    800,
  );
  assert.equal(reads, 1);
  assert.equal(calls, 1);
  assert.notEqual(configured.configFingerprint, config().configFingerprint);
});

test('reference count, identity, bytes, hash, decoder and pixels reject before credentials', async () => {
  const p = ownerProfile(now);
  p.image.maxReferenceImages = 2;
  let reads = 0,
    calls = 0;
  const runtime = createOwnerImageRuntime(config(p), {
    now: () => now,
    resolveApiKey: () => {
      reads++;
      return 'fake';
    },
    fetchImpl: async () => {
      calls++;
      return result();
    },
  });
  const revisionId = randomUUID(),
    bytes = await fixturePng(),
    ref = {
      revisionId,
      bytes,
      mime: 'image/png',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  const req = request({ referenceRevisionIds: [revisionId] });
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
  const tooWide = await sharp(bytes).resize(4097, 1).png().toBuffer();
  for (const refs of [
    [],
    [{ ...ref, revisionId: randomUUID() }],
    [ref, ref],
    [{ ...ref, sha256: '0'.repeat(64) }],
    [{ ...ref, mime: 'image/svg+xml' }],
    [{ ...ref, bytes: oversized }],
    [
      {
        ...ref,
        bytes: Buffer.from('not png'),
        sha256: createHash('sha256').update('not png').digest('hex'),
      },
    ],
    [{ ...ref, bytes: tooWide, sha256: createHash('sha256').update(tooWide).digest('hex') }],
  ])
    await assert.rejects(
      runtime.provider.generate(req, 'synthetic-invalid-reference', refs),
      /INVALID_IMAGE_REFERENCE/,
    );
  const noRefs = createOwnerImageRuntime(config(), {
    now: () => now,
    resolveApiKey: () => {
      reads++;
      return 'fake';
    },
    fetchImpl: async () => {
      calls++;
      return result();
    },
  });
  await assert.rejects(
    noRefs.provider.generate(req, 'synthetic-no-reference', [ref]),
    /IMAGE_REFERENCE_ESTIMATE_UNAVAILABLE/,
  );
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('two configured owned references retain declared order in one multipart request', async () => {
  const p = ownerProfile(now);
  p.image.maxReferenceImages = 2;
  const first = await fixturePng(),
    second = await fixturePng(true),
    ids = [randomUUID(), randomUUID()];
  const refs = [first, second].map((bytes, index) => ({
    revisionId: ids[index],
    bytes,
    mime: 'image/png',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }));
  let calls = 0;
  const runtime = createOwnerImageRuntime(config(p), {
    now: () => now,
    resolveApiKey: () => 'fake-two-refs',
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/images/edits');
      const files = init.body.getAll('image[]');
      assert.equal(files.length, 2);
      assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), first);
      assert.deepEqual(Buffer.from(await files[1].arrayBuffer()), second);
      return result({
        input_tokens_details: { text_tokens: 1, image_tokens: 1000 },
        output_tokens: 1,
      });
    },
  });
  assert.equal(
    (
      await runtime.provider.generate(
        request({ referenceRevisionIds: ids }),
        'synthetic-two',
        refs.reverse(),
      )
    ).actualMicros,
    2004,
  );
  assert.equal(calls, 1);
});

test('contradictory usage or an unpriced text-output modality remains unknown, not a guessed image bill', async () => {
  const base = { input_tokens_details: { text_tokens: 10, image_tokens: 20 }, output_tokens: 30 };
  for (const changes of [
    { input_tokens: 31 },
    { total_tokens: 61 },
    { input_tokens: -1 },
    { output_tokens_details: { image_tokens: 29, text_tokens: 1 } },
    { output_tokens_details: { image_tokens: 30 } },
    { output_tokens_details: null },
  ]) {
    const runtime = createOwnerImageRuntime(config(), {
      now: () => now,
      resolveApiKey: () => 'fake',
      fetchImpl: async () => result({ ...base, ...changes }),
    });
    assert.equal(
      (await runtime.provider.generate(request(), 'synthetic-inconsistent', [])).actualMicros,
      undefined,
    );
  }
  const runtime = createOwnerImageRuntime(config(), {
    now: () => now,
    resolveApiKey: () => 'fake',
    fetchImpl: async () =>
      result({
        ...base,
        input_tokens: 30,
        total_tokens: 60,
        output_tokens_details: { image_tokens: 30, text_tokens: 0 },
      }),
  });
  assert.equal(
    (await runtime.provider.generate(request(), 'synthetic-consistent', [])).actualMicros,
    140,
  );
});

test('story plan output override requires per-request estimates and fits reviewed context and caps', async () => {
  const { requestEstimateOwnerProfile } = await import('./owner-config-fixture.mjs');
  const p = requestEstimateOwnerProfile(now);
  p.text.storyPlanMaxOutputTokens = 8192;
  const c = config(p);
  assert.equal(c.text.maxOutputTokens, 512);
  assert.equal(c.text.storyPlanMaxOutputTokens, 8192);
  const { safeOwnerProfile } = await import('../../apps/api/src/generation/policy-revisions.ts');
  assert.equal(safeOwnerProfile(c).text.storyPlanMaxOutputTokens, 8192);
  for (const mutate of [
    (p) => delete p.text.estimation,
    (p) => {
      p.text.storyPlanMaxOutputTokens = 32001;
    },
    (p) => {
      p.text.contextTokens = 70000;
    },
    (p) => {
      p.textCapMicros = 1000;
    },
  ]) {
    const invalid = structuredClone(p);
    mutate(invalid);
    assert.throws(() => config(invalid), /OWNER_GENERATION_/);
  }
  const changed = structuredClone(p);
  changed.text.storyPlanMaxOutputTokens = 4096;
  assert.notEqual(config(changed).configFingerprint, c.configFingerprint);
});

test('maximum authored prompt gets hidden style after public validation; old requests keep original bytes', async () => {
  const sent = [];
  const runtime = createOwnerImageRuntime(config(), {
    now: () => now,
    resolveApiKey: () => 'synthetic-key',
    fetchImpl: async (_url, init) => {
      sent.push(JSON.parse(init.body).prompt);
      return result();
    },
  });
  const prompt = 'x'.repeat(2000);
  await runtime.provider.generate(request({ prompt, requestPolicyVersion: 2 }), randomUUID(), []);
  assert.ok(sent[0].length > 2000);
  assert.match(sent[0], /Default art: detailed drawn 2D anime/);
  assert.ok(sent[0].endsWith(prompt));
  await runtime.provider.generate(request({ prompt }), randomUUID(), []);
  assert.equal(sent[1], prompt);
  await assert.rejects(
    runtime.provider.generate(
      request({ prompt: 'x'.repeat(2001), requestPolicyVersion: 2 }),
      randomUUID(),
      [],
    ),
  );
  assert.equal(sent.length, 2);
});
