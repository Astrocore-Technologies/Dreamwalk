import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  GenerationResponseScope,
  generationExpired,
  liveSessionActive,
  liveRequestConsentFence,
} from '../../apps/web/components/live-test/types.ts';
import {
  ownerImageEstimateAvailable,
  ownerImageQuoteMatches,
} from '../../apps/web/components/visual-authoring/generation-types.ts';
const now = Date.parse('2026-11-02T00:00:00Z');
const release = {
  mode: 'release',
  enabled: true,
  state: 'active',
  authorizationId: null,
  sessionId: null,
  expiresAt: null,
  remainingMicros: 500000,
  pricingValidUntil: '2026-12-01T00:00:00Z',
};
const config = {
  generationMode: 'release',
  externalEnabled: true,
  ownerEstimateEnabled: true,
  estimateRiskConsentRequired: true,
  providerEnforcesQuotedCap: false,
  verifiedUpperMicros: null,
  estimatedTotalMicros: 10000,
  reserveMicros: 20000,
};
const quote = {
  generationMode: 'release',
  mode: 'external',
  estimateRiskConsentRequired: true,
  providerEnforcesQuotedCap: false,
  costBasis: 'approved_estimate',
  upperMicros: null,
  estimatedTotalMicros: 10000,
  reserveMicros: 20000,
  sparks: { walletCharging: true },
};
test('release status can admit first quote without a manual session/claim', () => {
  assert.equal(generationExpired(release, now), false);
  assert.equal(liveSessionActive(release, now), true);
  for (const patch of [
    { enabled: false },
    { state: 'stopped' },
    { remainingMicros: 0 },
    { pricingValidUntil: '2026-11-01T00:00:00Z' },
  ])
    assert.equal(liveSessionActive({ ...release, ...patch }, now), false);
  assert.equal(liveSessionActive({ ...release, mode: 'owner' }, now), false);
});
test('release image quotes retain model and policy fences and require real Sparks charging', () => {
  assert.equal(ownerImageEstimateAvailable(config), true);
  assert.equal(ownerImageQuoteMatches(quote, config, release), true);
  assert.equal(ownerImageQuoteMatches({ ...quote, sparks: undefined }, config, release), false);
  assert.equal(
    ownerImageQuoteMatches({ ...quote, generationMode: 'owner' }, config, release),
    false,
  );
  assert.equal(ownerImageQuoteMatches({ ...quote, reserveMicros: 1 }, config, release), false);
  assert.equal(
    ownerImageQuoteMatches({ ...quote, policyRevision: 1, policyHash: 'a'.repeat(64) }, config, {
      ...release,
      policyRevision: 2,
      policyHash: 'b'.repeat(64),
    }),
    false,
  );
});
test('release text consent never bypasses the persisted policy fence', () => {
  assert.equal(liveRequestConsentFence({}, release), null);
  assert.deepEqual(
    liveRequestConsentFence({ policyRevision: 1, policyHash: 'a'.repeat(64) }, release),
    { policyRevision: 1, policyHash: 'a'.repeat(64) },
  );
});
test('account/navigation changes invalidate previous quote result even on navigation back', () => {
  const scope = new GenerationResponseScope();
  scope.update('account-a:story-a');
  const before = scope.capture();
  scope.update('account-b:story-a');
  scope.update('account-a:story-a');
  assert.equal(scope.current(before), false);
  scope.invalidate();
  assert.equal(scope.current(before), false);
});
test('release panel excludes claim and operator policy review while keeping request actions', async () => {
  const s = await readFile(
    new URL('../../apps/web/components/live-test/live-test-panel.tsx', import.meta.url),
    'utf8',
  );
  assert.match(s, /release-generation-panel/);
  assert.match(s, /!releaseMode &&\s*status.state === 'unclaimed'/);
  assert.match(s, /\{ownerMode && \(\s*<OwnerPolicyReview/);
  assert.match(s, /value.ownerId !== owner/);
  assert.match(s, /window.removeEventListener\(SPARKS_REFRESH_EVENT/);
});
