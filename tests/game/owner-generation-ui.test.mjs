import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  GenerationResponseScope,
  generationAuthorizationId,
  generationRemaining,
  generationExpired,
  generationPricingCurrent,
  liveSessionActive,
} from '../../apps/web/components/live-test/types.ts';
import {
  ownerImageEstimateAvailable,
  ownerImageQuoteMatches,
} from '../../apps/web/components/visual-authoring/generation-types.ts';
const read = (path) =>
  readFile(new URL('../../apps/web/components/' + path, import.meta.url), 'utf8');
const now = Date.parse('2026-11-01T00:00:00Z');
const owner = {
  mode: 'owner',
  enabled: true,
  authorizationId: 'server-issued-id',
  sessionId: 'server-issued-id',
  state: 'active',
  expiresAt: null,
  remainingMicros: 900000,
};
const config = {
  generationMode: 'owner',
  externalEnabled: true,
  ownerEstimateEnabled: true,
  estimateRiskConsentRequired: true,
  providerEnforcesQuotedCap: false,
  verifiedUpperMicros: null,
  estimatedTotalMicros: 45880,
  reserveMicros: 100000,
};
const quote = {
  generationMode: 'owner',
  estimateRiskConsentRequired: true,
  providerEnforcesQuotedCap: false,
  mode: 'external',
  costBasis: 'approved_estimate',
  upperMicros: null,
  estimatedTotalMicros: 45880,
  reserveMicros: 100000,
};

test('owner authorization has no invented session expiry but still needs a server ID, active state and budget', () => {
  assert.equal(liveSessionActive(owner, now), true);
  assert.equal(liveSessionActive(owner, now + 365 * 24 * 3600000), true);
  assert.equal(generationExpired(owner, now), false);
  assert.equal(generationAuthorizationId(owner), 'server-issued-id');
  for (const override of [
    { authorizationId: null, sessionId: null },
    { enabled: false },
    { state: 'unclaimed' },
    { state: 'stopped' },
    { remainingMicros: 0 },
    { remainingMicros: -1 },
  ])
    assert.equal(liveSessionActive({ ...owner, ...override }, now), false);
});
test('manual compatibility still expires and owner pricing freshness is not presented as session expiry', () => {
  const manual = { ...owner, mode: 'manual', expiresAt: new Date(now + 1000).toISOString() };
  assert.equal(liveSessionActive(manual, now), true);
  assert.equal(liveSessionActive(manual, now + 1001), false);
  assert.equal(liveSessionActive({ ...manual, mode: undefined }, now), true);
  assert.equal(liveSessionActive({ ...manual, expiresAt: null }, now), false);
  assert.equal(liveSessionActive({ ...manual, expiresAt: 'invalid' }, now), false);
  const stale = { ...owner, pricingValidUntil: new Date(now - 1).toISOString() };
  assert.equal(generationExpired(stale, now), false);
  assert.equal(generationPricingCurrent(stale, now), false);
  assert.equal(liveSessionActive(stale, now), false);
});
test('only explicit owner estimate capability enables matching estimated quotes, never legacy, malformed or mismatched values', () => {
  assert.equal(ownerImageEstimateAvailable(config), true);
  assert.equal(ownerImageQuoteMatches(quote, config), true);
  for (const override of [
    { generationMode: 'manual' },
    { generationMode: undefined },
    { externalEnabled: false },
    { ownerEstimateEnabled: false },
    { ownerEstimateEnabled: undefined },
    { estimateRiskConsentRequired: false },
    { providerEnforcesQuotedCap: true },
    { providerEnforcesQuotedCap: undefined },
    { verifiedUpperMicros: 0 },
    { estimatedTotalMicros: 0 },
    { estimatedTotalMicros: NaN },
    { estimatedTotalMicros: Infinity },
    { estimatedTotalMicros: 1.5 },
    { reserveMicros: 45879 },
    { reserveMicros: -1 },
    { reserveMicros: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.equal(ownerImageQuoteMatches(quote, { ...config, ...override }), false);
  for (const override of [
    { mode: 'mock' },
    { generationMode: 'manual' },
    { generationMode: undefined },
    { estimateRiskConsentRequired: false },
    { providerEnforcesQuotedCap: true },
    { costBasis: 'verified_bound' },
    { upperMicros: 0 },
    { reserveMicros: 100001 },
    { estimatedTotalMicros: 45881 },
    { reserveMicros: undefined },
    { estimatedTotalMicros: undefined },
  ])
    assert.equal(ownerImageQuoteMatches({ ...quote, ...override }, config), false);
});
test('generic owner endpoints do not require admin role, hide authorization on refresh failure and never synthesize session IDs', async () => {
  const panel = await read('live-test/live-test-panel.tsx');
  assert.match(panel, /const owner = user\?\.id \?\? null/);
  assert.match(panel, /api<LiveTestStatus>\('\/generation\/status'\)/);
  assert.match(panel, /api<LiveTestStatus>\('\/generation\/claim'/);
  assert.match(panel, /JSON.stringify\(\{ consent: true \}\)/);
  assert.match(panel, /authorizationId: generationAuthorizationId\(status\)/);
  assert.match(panel, /status: null,\s+error: e instanceof ApiError/);
  assert.match(panel, /snapshot.owner === owner \? snapshot.status : null/);
  assert.match(panel, /identity.current === owner/);
  assert.doesNotMatch(
    panel,
    /\/live-test\/status|status === 404|role === 'admin'|expiresAt: new Date/,
  );
  assert.match(panel, /ownerMode \? \(\s+<p[^>]*>\{m\('ownerDuration'\)\}/);
  assert.match(panel, /sameTurnFence\(turnFence, batch.turnFence\)/);
  assert.match(panel, /uncertain.includes\(request.id\)/);
});
test('both image paths require separate per-quote estimate consent and preserve no automatic fallback or retry', async () => {
  for (const path of ['assets/image-generation.tsx', 'visual-authoring/external-generation.tsx']) {
    const source = await read(path);
    assert.match(source, /ownerImageQuoteMatches/);
    assert.match(source, /estimateRiskConsent: true/);
    assert.match(source, /set(?:EstimateRiskConsent|RiskConsents)\((?:false|\{\})\)/);
    assert.match(source, /estimateRiskConsent'\)/);
    assert.doesNotMatch(source, /api.openai|Authorization:|apiKey|process.env/);
  }
  const source = await read('assets/image-generation.tsx');
  assert.match(
    source,
    /quote.upperMicros === null && \(!estimatedQuote \|\| !estimateRiskConsent\)/,
  );
  assert.match(source, /setDispatchUncertain\(true\)/);
  assert.match(
    source,
    /mode === 'mock' \? !config.data\?\.mockAvailable : !config.data\?\.externalEnabled/,
  );
  assert.match(source, /modeChosen.current = true/);
  assert.doesNotMatch(source, /setMode\('mock'\)/);
});
test('owner budget, indefinite authorization, risk and unavailable copy all have complete uk/en/ru variants', async () => {
  for (const path of [
    'live-test/messages.ts',
    'visual-authoring/generation-messages.ts',
    'visual-authoring/location-image-messages.ts',
    'assets/image-messages.ts',
  ]) {
    const source = await read(path);
    const rows = source.matchAll(/\w+: \[([\s\S]*?)\],/g);
    for (const [, values] of rows) {
      const strings = values.match(/'(?:[^'\\]|\\.)*'/g) ?? [];
      assert.equal(strings.length, 3, `${path}: ${values}`);
      assert.ok(strings.every((value) => value.length > 2));
    }
  }
});

test('unsupported owner photos and reference-dependent stages are blocked without dropping their references', async () => {
  const workshop = await read('visual-authoring/workshop.tsx');
  assert.match(workshop, /maxReferenceImages === 0/);
  assert.match(workshop, /if \(unsupportedPhoto\)/);
  assert.match(workshop, /value="photo" disabled=\{ownerReferencesUnavailable\}/);
  const stages = await read('visual-authoring/external-generation.tsx');
  assert.match(stages, /referenceRequired/);
  assert.match(stages, /ownerReferenceStage/);
  assert.doesNotMatch(stages, /referenceRevisionIds: \[\]/);
});

test('late owner/campaign responses are rejected, including leave-and-return ABA and unmount', async () => {
  const scope = new GenerationResponseScope();
  scope.update('owner-a:campaign-a:turn-1');
  const claim = scope.capture();
  assert.equal(scope.current(claim), true);
  scope.update('owner-b:campaign-a:turn-1');
  assert.equal(scope.current(claim), false);
  scope.update('owner-a:campaign-a:turn-1');
  assert.equal(scope.current(claim), false);
  const pending = scope.capture();
  scope.update('owner-a:campaign-b:turn-1');
  assert.equal(scope.current(pending), false);
  const consent = scope.capture();
  scope.update('owner-a:campaign-b:turn-2');
  assert.equal(scope.current(consent), false);
  const final = scope.capture();
  scope.invalidate();
  assert.equal(scope.current(final), false);
  const panel = await read('live-test/live-test-panel.tsx');
  assert.match(panel, /batchState && responseScope.current\(batchState.stamp\)/);
  assert.equal((panel.match(/const stamp = responseScope.capture\(\)/g) ?? []).length, 3);
  assert.ok((panel.match(/mounted.current && responseScope.current\(stamp\)/g) ?? []).length >= 7);
});

test('purpose budgets cannot exceed total headroom and legacy status retains combined-budget compatibility', () => {
  assert.equal(generationRemaining(owner, 'text'), 900000);
  assert.equal(generationRemaining({ ...owner, textRemainingMicros: 0 }, 'text'), 0);
  assert.equal(generationRemaining({ ...owner, textRemainingMicros: 2000000 }, 'text'), 900000);
  assert.equal(generationRemaining({ ...owner, imageRemainingMicros: 45880 }, 'image'), 45880);
  assert.equal(generationRemaining({ ...owner, imageRemainingMicros: -1 }, 'image'), 0);
});
