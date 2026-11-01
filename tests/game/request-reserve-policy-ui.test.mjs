import assert from 'node:assert/strict';
import test from 'node:test';
import { ownerImageQuoteMatches } from '../../apps/web/components/visual-authoring/generation-types.ts';
import {
  liveRequestReserve,
  ownerClaimFingerprintCurrent,
  liveRequestConsentFence,
  liveRequestPolicyCurrent,
} from '../../apps/web/components/live-test/types.ts';
import {
  policyRetryMatches,
  validPendingPolicyApply,
} from '../../apps/web/components/live-test/owner-policy-types.ts';
const hash = 'a'.repeat(64),
  policyHash = 'b'.repeat(64);
const config = {
  generationMode: 'owner',
  externalEnabled: true,
  ownerEstimateEnabled: true,
  estimateRiskConsentRequired: true,
  providerEnforcesQuotedCap: false,
  verifiedUpperMicros: null,
  estimatedTotalMicros: 45880,
  reserveMicros: 100000,
  requestEstimationEnabled: true,
  pricingProfileId: 'profile-v2',
  pricingProfileHash: hash,
  providerFingerprint: 'provider-v2',
};
const pricing = { id: 'profile-v2', fingerprint: hash, providerEnforcesQuotedCap: false };
const snapshot = {
  schemaVersion: 1,
  id: 'estimate-1',
  fingerprint: 'c'.repeat(64),
  basis: 'operator_heuristic',
  costBasis: 'operator_estimate',
  providerEnforcesQuotedCap: false,
  promptUtf8Bytes: 120,
  referenceCount: 1,
  uncertainReferences: true,
  inputTextMicros: 24000,
  inputImageMicros: 8000,
  outputImageMicros: 9000,
  estimatedTotalMicros: 41000,
  marginBps: 1000,
  percentageMarginMicros: 4100,
  fixedMarginMicros: 10000,
  referenceAllowanceMicros: 20000,
  reserveMicros: 75100,
  providerFingerprint: 'provider-v2',
  pricingProfileId: 'profile-v2',
  pricingProfileHash: hash,
};
const quote = {
  mode: 'external',
  generationMode: 'owner',
  estimateRiskConsentRequired: true,
  providerEnforcesQuotedCap: false,
  costBasis: 'approved_estimate',
  upperMicros: null,
  estimatedTotalMicros: 41000,
  reserveMicros: 75100,
  estimateSnapshot: snapshot,
  pricingProfileSnapshot: pricing,
  estimateSnapshotId: snapshot.id,
  estimateSnapshotHash: snapshot.fingerprint,
  pricingProfileId: pricing.id,
  pricingProfileHash: pricing.fingerprint,
  policyRevision: 2,
  policyHash,
};
const status = { policyRevision: 2, policyHash };
test('per-request image reserve may differ from profile baseline while keeping immutable snapshots and active policy fences', () => {
  assert.equal(ownerImageQuoteMatches(quote, config, status), true);
  assert.notEqual(quote.reserveMicros, config.reserveMicros);
  assert.notEqual(quote.estimatedTotalMicros, config.estimatedTotalMicros);
  for (const change of [
    { policyRevision: 1 },
    { policyHash: hash },
    { estimateSnapshotHash: hash },
    { pricingProfileHash: policyHash },
    { reserveMicros: 75099 },
    { upperMicros: 0 },
    { estimateSnapshot: undefined },
    { pricingProfileSnapshot: undefined },
  ])
    assert.equal(ownerImageQuoteMatches({ ...quote, ...change }, config, status), false);
  assert.equal(
    ownerImageQuoteMatches(quote, { ...config, providerFingerprint: 'other' }, status),
    false,
  );
  assert.equal(
    ownerImageQuoteMatches(quote, { ...config, pricingProfileHash: policyHash }, status),
    false,
  );
});
test('image snapshot cost arithmetic, uncertainty and integer safety cannot silently weaken the reserve', () => {
  for (const change of [
    { reserveMicros: -1 },
    { estimatedTotalMicros: NaN },
    { estimatedTotalMicros: Infinity },
    { referenceCount: 1.5 },
    { uncertainReferences: false },
    { inputTextMicros: 24001 },
    { fixedMarginMicros: 9999 },
    { marginBps: -1 },
  ])
    assert.equal(
      ownerImageQuoteMatches(
        { ...quote, estimateSnapshot: { ...snapshot, ...change } },
        config,
        status,
      ),
      false,
    );
  const legacySnapshot = {
    ...snapshot,
    basis: 'legacy_fixed',
    costBasis: 'legacy_fixed',
    inputTextMicros: null,
    inputImageMicros: null,
    outputImageMicros: null,
    marginBps: null,
    percentageMarginMicros: null,
    fixedMarginMicros: null,
    referenceAllowanceMicros: null,
  };
  assert.equal(
    ownerImageQuoteMatches({ ...quote, estimateSnapshot: legacySnapshot }, config, status),
    true,
  );
});
test('text request reserve uses the concrete snapshot and blocks stale policy or malformed cost data', () => {
  const request = {
    upperMicros: null,
    reserveMicros: 31000,
    policyRevision: 2,
    policyHash,
    estimateSnapshot: {
      schemaVersion: 1,
      providerEnforcesQuotedCap: false,
      estimatedTotalMicros: 21000,
      reserveMicros: 31000,
    },
  };
  assert.equal(liveRequestReserve(request), 31000);
  assert.equal(liveRequestPolicyCurrent(request, status), true);
  assert.equal(liveRequestPolicyCurrent({ ...request, policyRevision: 1 }, status), false);
  assert.equal(liveRequestPolicyCurrent({ ...request, policyHash: hash }, status), false);
  for (const reserve of [null, undefined, -1, NaN, Infinity, 1.5])
    assert.equal(liveRequestReserve({ ...request, reserveMicros: reserve }), null);
  assert.equal(liveRequestReserve({ ...request, reserveMicros: 21000 }), null);
  assert.equal(liveRequestReserve({ upperMicros: 264036 }), 264036);
});
test('uncertain policy recovery requires exact saved operation and unchanged reviewed CAS/candidate', () => {
  const pending = {
    operationId: '00000000-0000-4000-8000-000000000001',
    expectedRevision: 2,
    expectedHash: hash,
    candidateFingerprint: policyHash,
    consent: true,
  };
  const policy = {
    active: { revision: 2, hash },
    proposed: { candidateFingerprint: policyHash, canApply: true },
  };
  assert.equal(validPendingPolicyApply(pending), true);
  assert.equal(validPendingPolicyApply({ ...pending, operationId: 'bad' }), false);
  assert.equal(policyRetryMatches(pending, policy), true);
  assert.equal(policyRetryMatches(pending, { ...policy, active: { revision: 3, hash } }), false);
  assert.equal(
    policyRetryMatches(pending, { ...policy, active: { revision: 2, hash: policyHash } }),
    false,
  );
  assert.equal(
    policyRetryMatches(pending, {
      ...policy,
      proposed: { candidateFingerprint: hash, canApply: true },
    }),
    false,
  );
  assert.equal(
    policyRetryMatches(pending, {
      ...policy,
      proposed: { candidateFingerprint: policyHash, canApply: false },
    }),
    false,
  );
  assert.equal(policyRetryMatches(pending, null), false);
});

test('text operator consent carries the exact displayed estimate and policy fence, legacy requests stay compatible', () => {
  const request = {
    upperMicros: null,
    reserveMicros: 31000,
    policyRevision: 2,
    policyHash,
    estimateSnapshot: { costBasis: 'operator_estimate', fingerprint: hash },
  };
  assert.deepEqual(liveRequestConsentFence(request), {
    estimateFingerprint: hash,
    policyRevision: 2,
    policyHash,
  });
  for (const change of [
    { policyRevision: undefined },
    { policyRevision: -1 },
    { policyHash: undefined },
    { policyHash: 'bad' },
    { estimateSnapshot: { costBasis: 'operator_estimate', fingerprint: 'bad' } },
  ])
    assert.equal(liveRequestConsentFence({ ...request, ...change }), null);
  assert.deepEqual(liveRequestConsentFence({ upperMicros: 264036 }), {});
});

test('fixed-price owner consent is policy-fenced while manual legacy consent remains compatible', () => {
  const request = { upperMicros: 264036, policyRevision: 2, policyHash };
  assert.deepEqual(liveRequestConsentFence(request, { mode: 'owner' }), {
    policyRevision: 2,
    policyHash,
  });
  assert.equal(liveRequestConsentFence({ upperMicros: 264036 }, { mode: 'owner' }), null);
  assert.deepEqual(liveRequestConsentFence({ upperMicros: 264036 }, { mode: 'manual' }), {});
});

test('initial owner claim is tied to the displayed runtime candidate, with manual compatibility', () => {
  assert.equal(ownerClaimFingerprintCurrent({ mode: 'owner', configFingerprint: hash }), true);
  assert.equal(ownerClaimFingerprintCurrent({ mode: 'owner', configFingerprint: 'bad' }), false);
  assert.equal(ownerClaimFingerprintCurrent({ mode: 'owner' }), false);
  assert.equal(ownerClaimFingerprintCurrent({ mode: 'manual' }), true);
});
