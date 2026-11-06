import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readOwnerSettlements } from '../../apps/web/lib/owner-settlements.ts';
const ownerId = randomUUID(),
  jobId = randomUUID(),
  holdId = randomUUID();
const row = () => ({
  holdId,
  reservedSubunits: '1000',
  state: 'verified',
  kind: 'authoring',
  jobId,
  campaignId: null,
  quote: {
    jobId,
    holdId,
    status: 'pending',
    actualMicros: '123',
    reservedSubunits: '1000',
    captureSubunits: '246',
    releaseSubunits: '754',
    rateVersion: 'api-cent-2-sparks-v2',
    funding: {
      dreamsCaptureSubunits: '0',
      dreamsReleaseSubunits: '0',
      sparksCaptureSubunits: '246',
      sparksReleaseSubunits: '754',
    },
    requiresConsent: true,
    noGameEffect: true,
    noAuthoringEffect: true,
    settlementMode: 'legacy_confirmation',
  },
});
const data = () => ({ ownerId, entries: [row()], nextCursor: null });
test('reservation reader keeps safe verified navigation and drops arbitrary content', () => {
  const value = data();
  value.entries[0].private = 'not retained';
  assert.equal(
    JSON.stringify(readOwnerSettlements(value, ownerId)).includes('not retained'),
    false,
  );
  for (const state of ['active', 'unavailable'])
    assert.deepEqual(
      readOwnerSettlements(
        {
          ownerId,
          entries: [{ holdId, reservedSubunits: '1000', state, jobId }],
          nextCursor: null,
        },
        ownerId,
      ).entries,
      [{ holdId, reservedSubunits: '1000', state }],
    );
});
test('foreign owner, tampered amounts, scope and unknown policy cannot expose a recovery route', () => {
  const changes = [
    (v) => {
      v.ownerId = randomUUID();
    },
    (v) => {
      v.entries[0].holdId = randomUUID();
    },
    (v) => {
      v.entries[0].reservedSubunits = '1001';
    },
    (v) => {
      v.entries[0].quote.settlementMode = 'bad';
    },
    (v) => {
      v.entries[0].kind = 'npc';
    },
    (v) => {
      v.entries.push(v.entries[0]);
    },
    (v) => {
      v.nextCursor = 'bad';
    },
  ];
  for (const change of changes) {
    const value = data();
    change(value);
    assert.throws(() => readOwnerSettlements(value, ownerId));
  }
});
test('discovery and historical authoring page are read-only and protected', () => {
  const source = readFileSync('apps/web/components/owner-settlements.tsx', 'utf8');
  assert.doesNotMatch(source, /method: ['"]POST|\.confirm\(/);
  assert.match(source, /key=\{user.id\}/);
  assert.match(source, /cache: 'no-store'/);
  assert.match(source, /<OwnerAuthoringSettlement jobId=\{jobId\}/);
  const route = readFileSync('apps/web/app/[[...path]]/page.tsx', 'utf8');
  assert.match(route, /<Protected>\s*<WalletSettlementsPage/);
  assert.match(route, /<Protected>\s*<OwnerAuthoringSettlementPage/);
});
