/** Synthetic browser controller only: no database, credentials or provider transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  KnownSettlementController,
  readKnownSettlement,
  settlementScope,
} from '../../apps/web/lib/known-npc-settlement.ts';
import { settlementMessages } from '../../apps/web/components/game/known-npc-settlement-messages.ts';

const ownerId = '11111111-1111-4111-8111-111111111111';
const campaignId = '22222222-2222-4222-8222-222222222222';
const jobId = '33333333-3333-4333-8333-333333333333';
const holdId = '44444444-4444-4444-8444-444444444444';
const operationId = '55555555-5555-4555-8555-555555555555';
const quote = () => ({
  jobId,
  holdId,
  status: 'pending',
  actualMicros: '123',
  reservedSubunits: '1000',
  captureSubunits: '246',
  releaseSubunits: '754',
  rateVersion: 'api-cent-2-sparks-v2',
  funding: {
    dreamsCaptureSubunits: '100',
    dreamsReleaseSubunits: '0',
    sparksCaptureSubunits: '146',
    sparksReleaseSubunits: '754',
  },
  requiresConsent: true,
  noGameEffect: true,
});
const complete = (value = quote()) => ({ ...value, status: 'settled', requiresConsent: false });
const storage = () => {
  const data = new Map();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
};
function setup(overrides = {}) {
  const states = [],
    posts = [],
    reads = [];
  const input = {
    ownerId,
    campaignId,
    jobId,
    storage: storage(),
    operationId: () => operationId,
    changed: (value) => states.push(value),
    read: async (path) => {
      reads.push(path);
      return quote();
    },
    post: async (path, body) => {
      posts.push({ path, body });
      return complete();
    },
    ...overrides,
  };
  return {
    controller: new KnownSettlementController(input),
    states,
    posts,
    reads,
    input,
    current: () => states.at(-1),
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('mount and refresh read only; exact consent follows explicit click and second GET', async () => {
  const h = setup();
  await h.controller.refresh();
  await h.controller.refresh();
  assert.equal(h.posts.length, 0);
  assert.equal(h.current().phase, 'ready');
  await h.controller.confirm();
  assert.equal(h.reads.length, 3);
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.posts[0], {
    path: settlementScope(ownerId, campaignId, jobId).path,
    body: {
      operationId,
      holdId,
      expectedActualMicros: '123',
      expectedReservedSubunits: '1000',
      expectedCaptureSubunits: '246',
      consent: true,
    },
  });
  assert.equal(h.current().phase, 'complete');
  await h.controller.confirm();
  assert.equal(h.posts.length, 1);
});

test('double clicks are synchronous locked, including slow GET and POST', async () => {
  const read = deferred(),
    post = deferred();
  let calls = 0,
    postCalls = 0;
  const h = setup({
    read: async () => (++calls === 1 ? quote() : read.promise),
    post: async () => {
      postCalls++;
      return post.promise;
    },
  });
  await h.controller.refresh();
  const pending = h.controller.confirm();
  await h.controller.confirm();
  assert.equal(calls, 2);
  read.resolve(quote());
  await new Promise((r) => setImmediate(r));
  await h.controller.confirm();
  assert.equal(postCalls, 1);
  post.resolve(complete());
  await pending;
  assert.equal(h.current().phase, 'complete');
});

test('uncertain response persists exact operation before POST and reuses it after reload', async () => {
  const saved = storage();
  const sent = [];
  const post = async (_path, body) => {
    assert.equal(JSON.parse([...saved.data.values()][0]).body.operationId, body.operationId);
    sent.push(body);
    if (sent.length === 1) throw new Error('lost response');
    return complete();
  };
  const first = setup({ storage: saved, post });
  await first.controller.refresh();
  await first.controller.confirm();
  assert.equal(first.current().phase, 'uncertain');
  first.controller.dispose();
  const restored = setup({
    storage: saved,
    post,
    operationId: () => {
      throw new Error('must not allocate');
    },
  });
  await restored.controller.refresh();
  assert.equal(restored.current().phase, 'uncertain');
  assert.equal(sent.length, 1);
  await restored.controller.confirm();
  assert.equal(restored.current().phase, 'complete');
  assert.deepEqual(sent[1], sent[0]);
});

test('reload after successful but lost response observes completed GET without another POST', async () => {
  const saved = storage();
  const first = setup({
    storage: saved,
    post: async () => {
      throw new Error('lost');
    },
  });
  await first.controller.refresh();
  await first.controller.confirm();
  first.controller.dispose();
  const second = setup({ storage: saved, read: async () => complete() });
  await second.controller.refresh();
  await second.controller.confirm();
  assert.equal(second.current().phase, 'complete');
  assert.equal(second.posts.length, 0);
});

for (const mode of ['read', 'write', 'corrupt'])
  test(`storage ${mode} failure prevents POST`, async () => {
    const saved = storage();
    if (mode === 'read')
      saved.getItem = () => {
        throw new Error('denied');
      };
    if (mode === 'write')
      saved.setItem = () => {
        throw new Error('quota');
      };
    if (mode === 'corrupt')
      saved.data.set(settlementScope(ownerId, campaignId, jobId).storageKey, '{bad');
    const h = setup({ storage: saved });
    await h.controller.refresh();
    await h.controller.confirm();
    assert.equal(h.current().error, 'storage');
    assert.equal(h.posts.length, 0);
  });

for (const kind of ['reserve', 'actual', 'funding', 'hold'])
  test(`${kind}-only drift stops consent before POST`, async () => {
    const altered = quote();
    if (kind === 'reserve') {
      altered.reservedSubunits = '1001';
      altered.releaseSubunits = '755';
      altered.funding.sparksReleaseSubunits = '755';
    }
    if (kind === 'actual') {
      altered.actualMicros = '124';
      altered.captureSubunits = '248';
      altered.releaseSubunits = '752';
      altered.funding.sparksCaptureSubunits = '148';
      altered.funding.sparksReleaseSubunits = '752';
    }
    if (kind === 'funding') {
      altered.funding.dreamsCaptureSubunits = '101';
      altered.funding.sparksCaptureSubunits = '145';
    }
    if (kind === 'hold') altered.holdId = ownerId;
    let calls = 0;
    const h = setup({ read: async () => (++calls === 1 ? quote() : altered) });
    await h.controller.refresh();
    await h.controller.confirm();
    assert.equal(h.current().error, 'changed');
    assert.equal(h.posts.length, 0);
  });

test('persisted attempt cannot be silently replaced after quote drift', async () => {
  const saved = storage();
  const first = setup({
    storage: saved,
    post: async () => {
      throw new Error('lost');
    },
  });
  await first.controller.refresh();
  await first.controller.confirm();
  first.controller.dispose();
  const changed = quote();
  changed.holdId = ownerId;
  const second = setup({ storage: saved, read: async () => changed });
  await second.controller.refresh();
  await second.controller.confirm();
  assert.equal(second.current().error, 'changed');
  assert.equal(second.posts.length, 0);
  assert.equal(JSON.parse([...saved.data.values()][0]).body.holdId, holdId);
});

for (const stage of ['refresh', 'confirm'])
  test(`disposal during ${stage} GET ignores late result and never sends`, async () => {
    const read = deferred();
    let calls = 0;
    const h = setup({
      read: async () => (stage === 'confirm' && ++calls === 1 ? quote() : read.promise),
    });
    if (stage === 'confirm') await h.controller.refresh();
    const pending = stage === 'confirm' ? h.controller.confirm() : h.controller.refresh();
    h.controller.dispose();
    const count = h.states.length;
    read.resolve(quote());
    await pending;
    assert.equal(h.states.length, count);
    assert.equal(h.posts.length, 0);
  });

test('disposal during POST keeps receipt but ignores late response', async () => {
  const post = deferred();
  const saved = storage();
  const h = setup({ storage: saved, post: () => post.promise });
  await h.controller.refresh();
  const pending = h.controller.confirm();
  await new Promise((r) => setImmediate(r));
  h.controller.dispose();
  const count = h.states.length;
  post.resolve(complete());
  await pending;
  assert.equal(h.states.length, count);
  assert.equal(saved.data.size, 1);
});

for (const status of ['settled', 'released'])
  test(`already ${status} GET prevents POST even on confirmation race`, async () => {
    let calls = 0;
    const h = setup({
      read: async () => (++calls === 1 ? quote() : { ...quote(), status, requiresConsent: false }),
    });
    await h.controller.refresh();
    await h.controller.confirm();
    assert.equal(h.current().phase, 'complete');
    assert.equal(h.posts.length, 0);
  });

test('foreign owner, job and campaign have distinct operation storage; invalid scope rejected', () => {
  const first = settlementScope(ownerId, campaignId, jobId);
  for (const ids of [
    [holdId, campaignId, jobId],
    [ownerId, holdId, jobId],
    [ownerId, campaignId, holdId],
  ])
    assert.notEqual(first.storageKey, settlementScope(...ids).storageKey);
  assert.throws(() => settlementScope('bad', campaignId, jobId));
});

test('unavailable owner read cannot reveal or submit a quote', async () => {
  const h = setup({
    read: async () => {
      throw new Error('404');
    },
  });
  await h.controller.refresh();
  await h.controller.confirm();
  assert.equal(h.current().quote, null);
  assert.equal(h.current().error, 'unavailable');
  assert.equal(h.posts.length, 0);
});

test('strict quote parser rejects mismatched identity, malformed sums/tariff and strips extra fields', () => {
  assert.deepEqual(
    readKnownSettlement({ ...quote(), privateText: 'must not retain' }, jobId),
    quote(),
  );
  for (const patch of [
    { jobId: ownerId },
    { holdId: 'bad' },
    { actualMicros: '0123' },
    { actualMicros: '124' },
    { noGameEffect: false },
    { requiresConsent: false },
    { rateVersion: 'unknown' },
    { captureSubunits: '247' },
    { releaseSubunits: '-1' },
    { reservedSubunits: '9223372036854775808' },
    { funding: {} },
  ])
    assert.throws(() => readKnownSettlement({ ...quote(), ...patch }, jobId));
  for (const bad of [null, [], 1, 'bad']) assert.throws(() => readKnownSettlement(bad, jobId));
});

test('all locales disclose limited consent, exact values and storage/uncertainty states', () => {
  for (const locale of ['en', 'ru', 'uk']) {
    assert.deepEqual(Object.keys(settlementMessages[locale]), Object.keys(settlementMessages.en));
    for (const value of Object.values(settlementMessages[locale])) assert.ok(value.trim());
  }
  const source = readFileSync(
    new URL('../../apps/web/components/game/known-npc-settlement.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /formatSparkSubunits\(amount, locale, 'exact'\)/);
  assert.match(source, /cache: 'no-store'/);
  assert.match(source, /storage: window.sessionStorage/);
  assert.match(source, /key=\{`\$\{user.id\}:\$\{campaignId\}:\$\{jobId\}`\}/);
  assert.match(source, /instance\?\.dispose\(\)/);
  assert.match(source, /role="status" aria-live="polite"/);
  assert.equal((source.match(/\.confirm\(\)/g) ?? []).length, 1);
  const route = readFileSync(
    new URL('../../apps/web/app/[[...path]]/page.tsx', import.meta.url),
    'utf8',
  );
  assert.match(route, /<Protected>\s*<KnownNpcSettlementPage/);
});
