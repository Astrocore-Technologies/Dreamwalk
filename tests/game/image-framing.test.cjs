/** Pure synthetic size/policy evidence tests. No provider calls or process environment. */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deriveMapImageFraming,
  imageFramingSchema,
  imageFramingMatchesProfile,
  imageFramingEvidenceMatches,
} = require('../../packages/contracts/dist');
const { readOwnerGenerationConfig } = require('../../apps/api/dist/generation/config');
const { imagePricingProfileSnapshot } = require('../../apps/api/dist/generation/estimates');
const { safeOwnerProfile } = require('../../apps/api/dist/generation/policy-revisions');
const pricing = {
  source: 'https://developers.openai.com/api/docs/pricing',
  reviewedAt: '2026-01-01T00:00:00.000Z',
  validUntil: '2099-01-01T00:00:00.000Z',
};
function raw() {
  return {
    totalCapMicros: 1000000000,
    textCapMicros: 500000000,
    imageCapMicros: 500000000,
    text: {
      model: 'synthetic',
      contextTokens: 100000,
      maxOutputTokens: 64,
      maxInputBytes: 64000,
      inputMicrosPerMillion: 1000000,
      outputMicrosPerMillion: 1000000,
      pricing,
    },
    image: {
      model: 'gpt-image-2.5-sunburst-2026-09-08',
      size: '1024x1024',
      quality: 'low',
      outputs: 1,
      format: 'png',
      maxPromptUtf8Bytes: 8000,
      maxReferenceImages: 0,
      inputTextMicrosPerMillion: 1000000,
      inputImageMicrosPerMillion: 1000000,
      outputImageMicrosPerMillion: 1000000,
      estimatedTotalMicros: 50000,
      reserveMicros: 100000,
      estimateRiskAccepted: true,
      pricing,
    },
  };
}
function read(value) {
  return readOwnerGenerationConfig(
    {
      GENERATION_MODE: 'owner',
      GENERATION_OWNER_HANDLE: 'fixture',
      GENERATION_OWNER_CONFIG_JSON: JSON.stringify(value),
    },
    Date.parse('2026-11-01'),
  );
}
function custom() {
  const v = raw();
  v.image.size = deriveMapImageFraming('map', 16, 9).size;
  delete v.image.estimatedTotalMicros;
  delete v.image.reserveMicros;
  v.image.estimation = {
    kind: 'operator_heuristic',
    textTokensPerKiBUtf8: 100,
    textProtocolTokens: 10,
    marginBps: 1000,
    fixedMarginMicros: 100,
    outputImageTokens: 1000,
    referenceImageTokensPerImage: 0,
    referenceAllowanceMicros: 0,
  };
  v.image.framingPolicy = {
    version: 1,
    mode: 'map_aspect_reviewed_range',
    assumptionKind: 'operator_range_ceiling_estimate',
    maxAspectRatio: 3,
    quality: 'low',
    minPixels: 655360,
    maxPixels: 8294400,
    maxEdge: 3840,
    reviewedOutputImageTokens: 1000,
    pricing,
  };
  return v;
}
test('every bounded map resolves deterministically to documented sizes; exact aspect or explicit contain fallback', () => {
  for (let w = 1; w <= 64; w++)
    for (let h = 1; h <= 64; h++) {
      const f = deriveMapImageFraming('map', w, h);
      assert.deepEqual(imageFramingSchema.parse(f), f);
      assert.equal(f.width % 16, 0);
      assert.equal(f.height % 16, 0);
      assert.ok(f.width * f.height >= 655360 && f.width * f.height <= 8294400);
      assert.ok(Math.max(f.width, f.height) <= 3840);
      assert.ok(Math.max(f.width, f.height) <= 3 * Math.min(f.width, f.height));
      assert.equal(f.exactAspect, w * f.height === h * f.width);
      assert.equal(f.resolutionMode, f.exactAspect ? 'exact_map_aspect' : 'contain_fallback');
    }
  const widescreen = deriveMapImageFraming('map', 16, 9);
  assert.equal(widescreen.exactAspect, true);
  assert.notEqual(widescreen.size, '1536x1024');
  assert.equal(deriveMapImageFraming('map', 64, 1).resolutionMode, 'contain_fallback');
});
test('tampered dimensions and stale quote/source evidence fail; legacy absent evidence stays compatible', () => {
  const f = deriveMapImageFraming('map', 16, 9);
  assert.equal(imageFramingSchema.safeParse({ ...f, width: f.width + 16 }).success, false);
  assert.equal(imageFramingMatchesProfile(f, '1024x1024'), false);
  assert.equal(imageFramingMatchesProfile(f, f.size), true);
  assert.equal(imageFramingEvidenceMatches({}, {}), true);
  assert.equal(imageFramingEvidenceMatches({ framingVersion: 1, imageFraming: f }, {}), false);
  assert.equal(
    imageFramingEvidenceMatches(
      { framingVersion: 1, imageFraming: f },
      { framingVersion: 1, imageFraming: deriveMapImageFraming('other-map', 16, 9) },
    ),
    false,
  );
});
test('custom size requires explicit reviewed range policy and matching cost evidence; no inferred pixel price', () => {
  const v = custom(),
    c = read(v);
  assert.equal(c.image.size, v.image.size);
  assert.equal(safeOwnerProfile(c).image.framingPolicy.mode, 'map_aspect_reviewed_range');
  assert.deepEqual(imagePricingProfileSnapshot(c.image).framingPolicy, c.image.framingPolicy);
  for (const mutate of [
    (v) => delete v.image.framingPolicy,
    (v) => v.image.framingPolicy.reviewedOutputImageTokens++,
    (v) => (v.image.framingPolicy.maxEdge = 1024),
    (v) => (v.image.framingPolicy.pricing = { ...pricing, reviewedAt: '2026-02-01T00:00:00.000Z' }),
    (v) => (v.image.model = 'unreviewed'),
  ]) {
    const bad = custom();
    mutate(bad);
    assert.throws(() => read(bad), /OWNER_GENERATION_CONFIG_INVALID/);
  }
});
test('policy bounds change invalidates immutable profile/config consent; legacy omission adds no serialized field', () => {
  const a = read(custom()),
    braw = custom();
  braw.image.framingPolicy.maxEdge = 3000;
  const b = read(braw);
  assert.notEqual(a.configFingerprint, b.configFingerprint);
  assert.notEqual(
    imagePricingProfileSnapshot(a.image).fingerprint,
    imagePricingProfileSnapshot(b.image).fingerprint,
  );
  const legacy = read(raw());
  // Independently compared against pre-change HEAD parser/config serialization.
  assert.equal(
    legacy.configFingerprint,
    'f48351efdf6a352105ec2d76429beeb479d1167477901d0d5a3fedba034d4cd2',
  );
  assert.equal(Object.hasOwn(legacy.image, 'framingPolicy'), false);
  assert.equal(Object.hasOwn(safeOwnerProfile(legacy).image, 'framingPolicy'), false);
  assert.equal(Object.hasOwn(imagePricingProfileSnapshot(legacy.image), 'framingPolicy'), false);
  assert.deepEqual(read(raw()), legacy);
});
test('authoritative geometry changes invalidate grounding; frozen pre-framing requests retain absent evidence', () => {
  const { createObservatoryState, addPlayer } = require('@dreamwalk/game-core');
  const { prepareSceneMedia } = require('../../apps/api/dist/game/media-preparation');
  const state = addPlayer(createObservatoryState(), 'player-a').state;
  state.entities['player-a'].x = 5;
  state.entities['player-a'].y = 4;
  state.narrativeSource = { versionId: 'source-v1', checksum: 'a'.repeat(64) };
  const before = prepareSceneMedia(state, 'player-a', 'source-v1', { kind: 'background' });
  assert.equal(before.spec.framingVersion, 1);
  assert.equal(
    before.spec.imageFraming.mapWidth,
    state.maps[state.entities['player-a'].mapId].width,
  );
  const legacy = prepareSceneMedia(state, 'player-a', 'source-v1', { kind: 'background' }, 0);
  assert.equal(Object.hasOwn(legacy.spec, 'framingVersion'), false);
  assert.equal(Object.hasOwn(legacy.spec, 'imageFraming'), false);
  assert.notEqual(legacy.groundingHash, before.groundingHash);
  const changed = structuredClone(state);
  changed.maps[state.entities['player-a'].mapId].width++;
  const after = prepareSceneMedia(changed, 'player-a', 'source-v1', { kind: 'background' });
  assert.notEqual(after.groundingHash, before.groundingHash);
  assert.notDeepEqual(after.spec.imageFraming, before.spec.imageFraming);
});
test('all three quote UIs forward and compare versioned consent evidence; admission rejects mismatched pixels', () => {
  const { readFileSync } = require('node:fs');
  for (const path of [
    'apps/web/components/game/grounded-image.tsx',
    'apps/web/components/assets/image-generation.tsx',
    'apps/web/components/visual-authoring/location-image-inline.tsx',
  ]) {
    const s = readFileSync(path, 'utf8');
    assert.match(s, /imageFramingEvidenceMatches/);
    assert.match(s, /ImageFramingNotice/);
  }
  const service = readFileSync('apps/api/src/image-generation/service.ts', 'utf8');
  assert.match(service, /IMAGE_FRAMING_DIMENSIONS_MISMATCH/);
  assert.match(service, /IMAGE_SIZE_POLICY_REVIEW_REQUIRED/);
  assert.match(service, /input.framingVersion === undefined/);
});
test('one reviewed range supports different map aspects with the same explicit worst-case assumption, immutable per-size evidence', async () => {
  const { resolveOwnerImageProfile } = require('../../apps/api/dist/generation/config');
  const { estimateImageRequest } = require('../../apps/api/dist/generation/estimates');
  const config = read(custom()),
    frames = [
      [16, 9],
      [4, 3],
      [9, 16],
    ].map(([w, h]) => deriveMapImageFraming('map', w, h));
  const resolved = frames.map((f) => resolveOwnerImageProfile(config.image, f));
  assert.equal(new Set(resolved.map((p) => p.size)).size, 3);
  assert.equal(
    new Set(resolved.map((p) => estimateImageRequest('fixture', 0, p, 'synthetic').reserveMicros))
      .size,
    1,
  );
  assert.equal(new Set(resolved.map((p) => imagePricingProfileSnapshot(p).fingerprint)).size, 3);
  for (let i = 0; i < frames.length; i++) assert.equal(resolved[i].size, frames[i].size);
  const tight = {
    ...config.image,
    framingPolicy: { ...config.image.framingPolicy, maxAspectRatio: 1 },
  };
  assert.throws(
    () => resolveOwnerImageProfile(tight, frames[0]),
    /IMAGE_SIZE_POLICY_REVIEW_REQUIRED/,
  );
  assert.equal(resolveOwnerImageProfile(config.image), config.image);
  const { OwnerOpenAiImageProvider } = require('../../apps/api/dist/image-generation/provider');
  const bodies = [];
  let keys = 0;
  const provider = new OwnerOpenAiImageProvider(config, {
    resolveApiKey: () => {
      keys++;
      return 'synthetic-fixture-not-a-secret';
    },
    now: () => Date.parse('2026-11-01'),
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      throw Error('INJECTED_TRANSPORT_STOP');
    },
  });
  const request = {
    adventureId: '123e4567-e89b-42d3-a456-426614174000',
    studioLocationContext: {
      locationId: 'room',
      expectedEditRevision: 1,
      sourceHash: 'a'.repeat(64),
    },
    framingVersion: 1,
    imageFraming: frames[0],
    prompt: 'fixture',
    title: 'fixture',
    kind: 'background',
    camera: 'top-down',
    tags: [],
    background: 'opaque',
    rights: {
      basis: 'generated',
      licenseLabel: 'fixture',
      attribution: '',
      allowAuthorReuse: false,
      attested: true,
    },
    mode: 'external',
  };
  await assert.rejects(
    () => provider.generate(request, 'synthetic-dispatch', []),
    /INJECTED_TRANSPORT_STOP/,
  );
  assert.equal(bodies[0].size, frames[0].size);
  assert.equal(bodies[0].model, 'gpt-image-2.5-sunburst-2026-09-08');
  const denied = new OwnerOpenAiImageProvider(
    { ...config, image: tight },
    {
      resolveApiKey: () => {
        throw Error('MUST_NOT_RESOLVE_KEY');
      },
      fetchImpl: async () => {
        throw Error('MUST_NOT_DISPATCH');
      },
    },
  );
  await assert.rejects(
    () => denied.generate(request, 'denied', []),
    /IMAGE_SIZE_POLICY_REVIEW_REQUIRED/,
  );
  assert.equal(keys, 1);
});
test('real image service quote, consent, immutable size/policy validation and raster rejection with isolated persistence ports', async () => {
  const { mkdtemp, writeFile, rm } = require('node:fs/promises');
  const { randomUUID, createHash } = require('node:crypto');
  const dir = await mkdtemp('/tmp/image-framing-service-');
  const configModule = require.resolve('../../apps/api/dist/config');
  require.cache[configModule] = {
    id: configModule,
    filename: configModule,
    loaded: true,
    exports: {
      config: {
        NODE_ENV: 'test',
        ASSET_DIR: dir,
        DATABASE_URL: 'postgresql://synthetic@127.0.0.1:1/never_connect',
      },
    },
  };
  try {
    const { ImageGenerationEngine } = require('../../apps/api/dist/image-generation/service');
    const { FixtureImageProvider } = require('../../apps/api/dist/image-generation/provider');
    const { defaultImagePolicy } = require('../../apps/api/dist/image-generation/contracts');
    const cprofile = read(custom());
    const policy = {
      ...defaultImagePolicy,
      generationMode: 'owner',
      ownerImageProfile: cprofile.image,
      approved: true,
      externalEnabled: true,
      costBasis: 'approved_estimate',
      generationPolicyRevision: 1,
      generationPolicyHash: 'f'.repeat(64),
    };
    let quoted, job;
    const statements = [];
    const query = async (sql, values = []) => {
      statements.push([sql, values]);
      if (sql.includes('count(*)')) return { rows: [{ n: 0 }], rowCount: 1 };
      if (sql.startsWith('INSERT INTO image_generation_quotes')) {
        const names = [
          'id',
          'actor_id',
          'adventure_id',
          'request_hash',
          'input',
          'reference_hashes',
          'mode',
          'policy_version',
          'upper_micros',
          'expires_at',
          'cost_basis',
          'estimated_total_micros',
          'estimate_snapshot',
          'pricing_profile_snapshot',
          'generation_policy_revision',
          'generation_policy_hash',
        ];
        quoted = Object.fromEntries(names.map((n, i) => [n, values[i]]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT id FROM users')) return { rows: [{ id: values[0] }], rowCount: 1 };
      if (sql.includes('SELECT * FROM image_generation_quotes'))
        return { rows: [quoted], rowCount: 1 };
      if (sql.includes('SELECT * FROM image_generation_jobs'))
        return {
          rows: sql.includes('operation_id') ? [] : job ? [job] : [],
          rowCount: job ? 1 : 0,
        };
      if (sql.startsWith("UPDATE image_generation_jobs SET status='rejected'")) {
        job.status = 'rejected';
        job.error_code = values[1];
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const db = {
      tx: (work) => work({ query }),
      query: async (...args) => (await query(...args)).rows,
    };
    class Engine extends ImageGenerationEngine {
      async authorize() {
        return { hashes: {}, refs: [], livePolicy: this.policy };
      }
    }
    const provider = {
      id: 'injected-no-dispatch',
      generate: () => {
        throw Error('UNEXPECTED_DISPATCH');
      },
    };
    const engine = new Engine(db, { search: async () => [] }, provider, policy, {
      requestProfile: { size: cprofile.image.size, maxReferenceImages: 0 },
    });
    const request = {
      adventureId: randomUUID(),
      studioLocationContext: {
        locationId: 'room',
        expectedEditRevision: 1,
        sourceHash: 'a'.repeat(64),
      },
      framingVersion: 1,
      imageFraming: deriveMapImageFraming('map', 4, 3),
      prompt: 'fixture',
      title: 'fixture',
      kind: 'background',
      camera: 'top-down',
      tags: [],
      background: 'opaque',
      rights: {
        basis: 'generated',
        licenseLabel: 'fixture',
        attribution: '',
        allowAuthorReuse: false,
        attested: true,
      },
      mode: 'external',
      declineReuse: true,
    };
    const actor = randomUUID(),
      result = await engine.quote(actor, request);
    assert.equal(result.quote.imageFraming.size, request.imageFraming.size);
    assert.equal(quoted.pricing_profile_snapshot.size, request.imageFraming.size);
    assert.equal(
      quoted.estimate_snapshot.pricingProfileHash,
      quoted.pricing_profile_snapshot.fingerprint,
    );
    assert.equal(
      result.quote.basePricingProfileHash,
      imagePricingProfileSnapshot(cprofile.image).fingerprint,
    );
    engine.assertQuotedProvider(quoted);
    await assert.rejects(
      () => engine.enqueue(actor, { quoteId: quoted.id, operationId: randomUUID(), consent: true }),
      /IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED/,
    );
    await assert.rejects(() =>
      engine.enqueue(actor, {
        quoteId: quoted.id,
        operationId: randomUUID(),
        consent: false,
        estimateRiskConsent: true,
      }),
    );
    const saved = structuredClone(quoted);
    quoted.input.imageFraming = deriveMapImageFraming('map', 9, 16);
    assert.throws(() => engine.assertQuotedProvider(quoted), /QUOTE_PROVIDER_CHANGED/);
    quoted = saved;
    const changed = {
      ...policy,
      ownerImageProfile: {
        ...cprofile.image,
        framingPolicy: { ...cprofile.image.framingPolicy, maxEdge: 3000 },
      },
    };
    const changedEngine = new Engine(db, { search: async () => [] }, provider, changed, {
      requestProfile: { size: cprofile.image.size, maxReferenceImages: 0 },
    });
    assert.throws(() => changedEngine.assertQuotedProvider(quoted), /QUOTE_PROVIDER_CHANGED/);
    const raster = await new FixtureImageProvider().generate(
      { ...request, imageFraming: undefined },
      'raster',
    );
    const filename = 'fixture.image-quarantine';
    await writeFile(`${dir}/${filename}`, raster.bytes);
    job = {
      id: randomUUID(),
      actor_id: actor,
      status: 'generated',
      mode: 'external',
      actual_micros: 13,
      reservation_id: randomUUID(),
      input: request,
      pricing_profile_snapshot: quoted.pricing_profile_snapshot,
      quarantine_filename: filename,
      quarantine_sha256: createHash('sha256').update(raster.bytes).digest('hex'),
      quarantine_mime: 'image/png',
      cancel_requested: false,
    };
    await engine.admit(job.id);
    assert.equal(job.status, 'rejected');
    assert.equal(job.error_code, 'IMAGE_FRAMING_DIMENSIONS_MISMATCH');
    assert.equal(job.actual_micros, 13);
    assert.equal(
      statements.some(([sql]) => /INSERT INTO art_(assets|asset_revisions)/.test(sql)),
      false,
    );
    assert.ok(
      statements.some(([sql]) =>
        sql.includes('SELECT actor_id,spark_quote_id,scope_id FROM generation_budget_reservations'),
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('actual UI consent helper accepts resolved range snapshot only under matching reviewed base policy', () => {
  const ts = require('typescript'),
    Module = require('node:module'),
    { readFileSync } = require('node:fs');
  const m = new Module('isolated-framing-ui');
  m._compile(
    ts.transpileModule(
      readFileSync('apps/web/components/visual-authoring/generation-types.ts', 'utf8'),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    'isolated-framing-ui.js',
  );
  const { ownerImageQuoteMatches } = m.exports;
  const { resolveOwnerImageProfile } = require('../../apps/api/dist/generation/config');
  const { estimateImageRequest } = require('../../apps/api/dist/generation/estimates');
  const base = read(custom()).image,
    resolved = resolveOwnerImageProfile(base, deriveMapImageFraming('map', 4, 3)),
    pricing = imagePricingProfileSnapshot(resolved),
    estimate = estimateImageRequest('fixture', 0, resolved, 'fixture-provider'),
    baseSnapshot = imagePricingProfileSnapshot(base);
  const config = {
    generationMode: 'owner',
    externalEnabled: true,
    ownerEstimateEnabled: true,
    estimateRiskConsentRequired: true,
    providerEnforcesQuotedCap: false,
    verifiedUpperMicros: null,
    requestEstimationEnabled: true,
    pricingProfileId: baseSnapshot.id,
    pricingProfileHash: baseSnapshot.fingerprint,
    providerFingerprint: 'fixture-provider',
    requestProfile: { size: base.size, framingPolicy: base.framingPolicy },
  };
  const quote = {
    mode: 'external',
    generationMode: 'owner',
    estimateRiskConsentRequired: true,
    providerEnforcesQuotedCap: false,
    costBasis: 'approved_estimate',
    upperMicros: null,
    estimatedTotalMicros: estimate.estimatedTotalMicros,
    reserveMicros: estimate.reserveMicros,
    estimateSnapshot: estimate,
    pricingProfileSnapshot: pricing,
    estimateSnapshotId: estimate.id,
    estimateSnapshotHash: estimate.fingerprint,
    pricingProfileId: pricing.id,
    pricingProfileHash: pricing.fingerprint,
    basePricingProfileId: baseSnapshot.id,
    basePricingProfileHash: baseSnapshot.fingerprint,
  };
  assert.equal(ownerImageQuoteMatches(quote, config), true);
  assert.equal(
    ownerImageQuoteMatches({ ...quote, basePricingProfileHash: 'stale' }, config),
    false,
  );
  assert.equal(ownerImageQuoteMatches({ ...quote, pricingProfileHash: 'stale' }, config), false);
  assert.equal(
    ownerImageQuoteMatches(quote, { ...config, requestProfile: { size: base.size } }),
    false,
  );
});
