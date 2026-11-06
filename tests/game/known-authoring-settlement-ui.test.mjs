/** Read-only recovery, exact confirmation and authoring/NPC isolation. No transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  KnownSettlementController,
  authoringSettlementScope,
  settlementScope,
} from '../../apps/web/lib/known-npc-settlement.ts';
import { authoringSettlementMessages } from '../../apps/web/components/visual-authoring/owner-authoring-settlement-messages.ts';
function setup() {
  const ownerId = randomUUID(),
    jobId = randomUUID(),
    holdId = randomUUID(),
    operationId = randomUUID();
  let lost = false,
    complete = false;
  const posts = [],
    reads = [],
    values = new Map();
  const q = {
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
    settlementMode: 'legacy_confirmation',
    noAuthoringEffect: true,
    requiresConsent: true,
    noGameEffect: true,
  };
  const input = {
    kind: 'authoring',
    ownerId,
    jobId,
    operationId: () => operationId,
    storage: { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) },
    read: async (p) => {
      reads.push(p);
      return complete ? { ...q, status: 'settled', requiresConsent: false } : q;
    },
    post: async (p, b) => {
      posts.push({ p, b });
      if (lost) throw new Error('network');
      complete = true;
      return { ...q, status: 'settled', requiresConsent: false };
    },
    changed: () => {},
  };
  return { input, posts, reads, values, q, lost: (value) => (lost = value) };
}
test('authoring mount/reload stays read-only and explicit retries retain the same operation', async () => {
  const f = setup(),
    controller = new KnownSettlementController(f.input);
  await controller.refresh();
  await controller.refresh();
  assert.equal(f.posts.length, 0);
  const scope = authoringSettlementScope(f.input.ownerId, f.input.jobId);
  assert.equal(
    f.reads.every((p) => p === scope.path),
    true,
  );
  assert.notEqual(
    scope.storageKey,
    settlementScope(f.input.ownerId, randomUUID(), f.input.jobId).storageKey,
  );
  f.lost(true);
  await controller.confirm();
  assert.equal(f.posts.length, 1);
  controller.dispose();
  const resumed = new KnownSettlementController(f.input);
  await resumed.refresh();
  assert.equal(f.posts.length, 1);
  f.lost(false);
  await resumed.confirm();
  assert.equal(f.posts.length, 2);
  assert.deepEqual(f.posts[1], f.posts[0]);
  await resumed.confirm();
  await resumed.refresh();
  assert.equal(f.posts.length, 2);
});
test('authoring quote errors and disposal never submit, and storage is owner/job scoped', async () => {
  const f = setup();
  const c = new KnownSettlementController({
    ...f.input,
    read: async () => {
      throw new Error('not available');
    },
  });
  await c.refresh();
  await c.confirm();
  assert.equal(f.posts.length, 0);
  c.dispose();
  await c.confirm();
  assert.notEqual(
    authoringSettlementScope(randomUUID(), f.input.jobId).storageKey,
    authoringSettlementScope(f.input.ownerId, f.input.jobId).storageKey,
  );
  assert.throws(() => authoringSettlementScope(f.input.ownerId, 'foreign-path'));
});
test('owner UI gates the explicit legacy action and keeps polling read-only in three locales', () => {
  const component = readFileSync(
    'apps/web/components/visual-authoring/owner-authoring-settlement.tsx',
    'utf8',
  );
  const builder = readFileSync(
    'apps/web/components/visual-authoring/story-playable-builder.tsx',
    'utf8',
  );
  for (const key of [
    'authoring-provider-cost',
    'authoring-sparks-charge',
    'authoring-sparks-release',
  ])
    assert.ok(component.includes(key));
  assert.match(
    component,
    /legacy && \['ready', 'uncertain', 'sending', 'loading'\]\.includes\(state.phase\)/,
  );
  assert.match(component, /q\?\.settlementMode === 'legacy_confirmation'/);
  assert.match(component, /onClick=\{\(\) => void controller.current\?\.confirm\(\)\}/);
  assert.equal((component.match(/\.confirm\(/g) ?? []).length, 1);
  assert.match(component, /instance.dispose\(\)/);
  assert.match(component, /key=\{`\$\{user.id\}:\$\{jobId\}`\}/);
  assert.match(component, /setTimeout\(\(\) => void refresh\(\), 5000\)/);
  assert.match(component, /q && \(legacy \|\| state\.phase === 'complete'\)/);
  assert.match(builder, /j\.sparkStatus === 'pending'/);
  assert.match(builder, /\['held', 'pending'\]\.includes\(j\.sparkStatus \?\? ''\)/);
  assert.match(builder, /onSettled=\{\(\) => void refreshAfterSettlement\(\)\}/);
  assert.match(component, /state\.phase === 'complete' && !notified\.current/);
  assert.match(builder, /\['stale', 'failed'\]\.includes\(j\.status\)/);
  for (const locale of ['ru', 'en', 'uk'])
    for (const key of [
      'title',
      'hint',
      'legacyHint',
      'legacy',
      'noNew',
      'providerCost',
      'charged',
      'automatic',
      'uncertain',
    ])
      assert.ok(authoringSettlementMessages[locale][key]);
});

test('automatic authoring remains read-only even on confirm and with unavailable storage', async () => {
  const f = setup();
  f.q.settlementMode = 'automatic';
  const c = new KnownSettlementController({
    ...f.input,
    storage: {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    },
  });
  await c.refresh();
  await c.confirm();
  await c.refresh();
  assert.equal(f.posts.length, 0);
  assert.equal(f.values.size, 0);
});
for (const mode of [undefined, 'unavailable', 'other-policy'])
  test(`unrecognized authoring mode ${mode} never submits`, async () => {
    const f = setup();
    f.q.settlementMode = mode;
    const c = new KnownSettlementController(f.input);
    await c.refresh();
    await c.confirm();
    assert.equal(f.posts.length, 0);
  });
test('changed authoring mode or exact amounts are rejected before sending', async () => {
  for (const change of [
    (q) => {
      q.settlementMode = 'automatic';
    },
    (q) => {
      q.actualMicros = '124';
      q.captureSubunits = '248';
      q.releaseSubunits = '752';
      q.funding.sparksCaptureSubunits = '248';
      q.funding.sparksReleaseSubunits = '752';
    },
    (q) => {
      q.noAuthoringEffect = false;
    },
  ]) {
    const f = setup(),
      c = new KnownSettlementController(f.input);
    await c.refresh();
    change(f.q);
    await c.confirm();
    assert.equal(f.posts.length, 0);
    assert.equal(f.values.size, 0);
  }
});
test('repeated legacy clicks use one operation and storage failure refuses before POST', async () => {
  const f = setup(),
    c = new KnownSettlementController(f.input);
  await c.refresh();
  await Promise.all([c.confirm(), c.confirm(), c.confirm()]);
  assert.equal(f.posts.length, 1);
  for (const failure of ['getItem', 'setItem']) {
    const x = setup();
    x.input.storage[failure] = () => {
      throw new Error('denied');
    };
    const blocked = new KnownSettlementController(x.input);
    await blocked.refresh();
    await blocked.confirm();
    assert.equal(x.posts.length, 0);
  }
});
test('a pre-mode saved authoring attempt only replays after fresh exact legacy proof', async () => {
  const f = setup(),
    c = new KnownSettlementController(f.input);
  await c.refresh();
  f.lost(true);
  await c.confirm();
  c.dispose();
  const key = authoringSettlementScope(f.input.ownerId, f.input.jobId).storageKey;
  const stored = JSON.parse(f.values.get(key));
  delete stored.quote.settlementMode;
  delete stored.quote.noAuthoringEffect;
  f.values.set(key, JSON.stringify(stored));
  const resumed = new KnownSettlementController(f.input);
  await resumed.refresh();
  assert.equal(f.posts.length, 1);
  f.lost(false);
  await resumed.confirm();
  assert.equal(f.posts.length, 2);
  assert.deepEqual(f.posts[1], f.posts[0]);
});
test('owner switch disposes an in-flight confirmation before POST and isolates saved attempts', async () => {
  const f = setup();
  let release;
  const c = new KnownSettlementController(f.input);
  await c.refresh();
  f.input.read = () =>
    new Promise((resolve) => {
      release = () => resolve(f.q);
    });
  const waiting = c.confirm();
  c.dispose();
  release();
  await waiting;
  assert.equal(f.posts.length, 0);
  assert.equal(f.values.size, 0);
});
