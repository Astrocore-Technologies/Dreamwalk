import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const exports = {};
new Function(
  'exports',
  'require',
  ts.transpileModule(
    readFileSync(new URL('../e2e/support/map-actions.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText,
)(exports, (name) => (name === '@playwright/test' ? require(name) : {}));
const { reconfirmKnownStale, assertCoordinationFence } = exports;
function fixture() {
  const order = [],
    listeners = new Set();
  const body = {
    type: 'action',
    action: { kind: 'pick_up', targetId: 'key' },
    operationId: 'unique',
  };
  const response = {
    ok: () => true,
    request: () => ({ postDataJSON: () => body }),
    json: async () => ({ status: 'committed', operationId: body.operationId }),
  };
  const page = {
    on: (_event, listener) => listeners.add(listener),
    off: (_event, listener) => listeners.delete(listener),
    waitForResponse: () => {
      order.push('armed');
      return Promise.resolve(response);
    },
  };
  return {
    page,
    order,
    listeners,
    body,
    response,
    expected: { type: body.type, action: body.action },
  };
}
test('actual receipt helper arms only after UI preparation, before click, without extending timeouts', async () => {
  const f = fixture();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const task = reconfirmKnownStale(
    f.page,
    'campaign',
    f.expected,
    async () => {
      f.order.push('click');
    },
    async () => {
      f.order.push('prepare');
      assert.equal(f.listeners.size, 1);
      await pending;
      f.order.push('ready');
    },
  );
  await Promise.resolve();
  assert.deepEqual(f.order, ['prepare']);
  release();
  await task;
  assert.deepEqual(f.order, ['prepare', 'ready', 'armed', 'armed', 'click']);
  assert.equal(f.listeners.size, 0);
});
test('failed preparation removes watcher and never arms or sends a command', async () => {
  const f = fixture();
  await assert.rejects(
    reconfirmKnownStale(
      f.page,
      'campaign',
      f.expected,
      async () => {
        f.order.push('click');
      },
      async () => {
        throw Error('UI_NOT_READY');
      },
    ),
    /UI_NOT_READY/,
  );
  assert.deepEqual(f.order, []);
  assert.equal(f.listeners.size, 0);
});

const waitIntent = {
  encounterId: 'encounter-3',
  generation: 1,
  round: 1,
  intentRevision: 1,
  action: { kind: 'wait' },
  ready: true,
};
for (const changed of [
  { round: 2 },
  { generation: 2 },
  { encounterId: 'other' },
  { intentRevision: 2 },
  { action: { kind: 'move' } },
  { ready: false },
]) {
  test(`explicit confirmation rejects changed intent ${JSON.stringify(changed)}`, async () => {
    const f = fixture();
    f.body.type = 'encounter.intent';
    f.body.intent = { ...waitIntent, ...changed };
    let clicks = 0;
    await assert.rejects(
      reconfirmKnownStale(
        f.page,
        'campaign',
        { type: 'encounter.intent', intent: waitIntent },
        async () => {
          clicks++;
        },
      ),
    );
    assert.equal(clicks, 1);
    assert.equal(f.listeners.size, 0);
  });
}
test('fresh snapshot cannot cross round/generation or already accepted intent', () => {
  const projection = {
    actorId: 'hero',
    encounter: { id: 'encounter-3', generation: 1, round: 1, phase: 'planning', intents: {} },
  };
  const expected = { type: 'encounter.intent', intent: waitIntent };
  assertCoordinationFence(projection, expected);
  for (const changed of [
    { round: 2 },
    { generation: 2 },
    { intents: { hero: {} } },
    { id: 'other' },
    { phase: 'completed' },
  ]) {
    assert.throws(() =>
      assertCoordinationFence(
        { ...projection, encounter: { ...projection.encounter, ...changed } },
        expected,
      ),
    );
  }
});
for (const outcome of ['unknown', 'HTTP', 'other-rejection', 'effectful-rejection']) {
  test(`${outcome} is never automatically retried`, async () => {
    const f = fixture();
    f.response.ok = () => outcome !== 'HTTP';
    f.response.json = async () => ({
      operationId: f.body.operationId,
      status: outcome === 'unknown' ? 'unknown' : 'rejected',
      code: outcome === 'other-rejection' ? 'FORBIDDEN' : 'STALE_STATE',
      events: outcome === 'effectful-rejection' ? [{}] : [],
    });
    let clicks = 0;
    await assert.rejects(
      reconfirmKnownStale(f.page, 'campaign', f.expected, async () => {
        clicks++;
      }),
    );
    assert.equal(clicks, 1);
    assert.equal(f.listeners.size, 0);
  });
}
test('planning confirmation observes and rejects unintended stop requests', async () => {
  const f = fixture();
  f.body.type = 'encounter.intent';
  f.body.intent = waitIntent;
  await assert.rejects(
    reconfirmKnownStale(
      f.page,
      'campaign',
      { type: 'encounter.intent', intent: waitIntent },
      async () => {
        for (const listener of f.listeners)
          listener({
            method: () => 'POST',
            url: () => 'http://localhost/api/v1/game/campaigns/campaign/stop',
          });
      },
    ),
    /stop/i,
  );
  assert.equal(f.listeners.size, 0);
});

function staleFixture(commitAt) {
  const f = fixture();
  let arms = 0,
    clicks = 0,
    notices = 0;
  f.page.getByText = () => ({
    _apiName: 'Locator',
    _expect: async () => {
      notices++;
      return { matches: true, log: [] };
    },
  });
  f.page.waitForResponse = () => {
    const attempt = Math.floor(arms++ / 2) + 1;
    const projection = {
      actorId: 'hero',
      map: { id: 'courtyard' },
      revision: attempt + 1,
      encounter: { id: 'encounter-3', generation: 1, round: 1, phase: 'planning', intents: {} },
    };
    if (arms % 2 === 0)
      return Promise.resolve({ ok: () => true, json: async () => ({ projection }) });
    const body = {
      type: 'encounter.intent',
      intent: waitIntent,
      operationId: `decision-${attempt}`,
      expectedRevision: attempt,
    };
    return Promise.resolve({
      ok: () => true,
      request: () => ({ postDataJSON: () => body }),
      json: async () => ({
        operationId: body.operationId,
        status: attempt === commitAt ? 'committed' : 'rejected',
        code: 'STALE_STATE',
        events: [],
        projection,
      }),
    });
  };
  return {
    f,
    run: () =>
      reconfirmKnownStale(
        f.page,
        'campaign',
        { type: 'encounter.intent', intent: waitIntent },
        async () => {
          clicks++;
        },
      ),
    counts: () => ({ clicks, notices }),
  };
}
test('known no-effect stale receipt requires refreshed state and visible notice before fresh UI decision', async () => {
  const f = staleFixture(2);
  await f.run();
  assert.deepEqual(f.counts(), { clicks: 2, notices: 1 });
  assert.equal(f.f.listeners.size, 0);
});
test('explicit reconfirmation retains the existing three-decision bound', async () => {
  const f = staleFixture(Infinity);
  await assert.rejects(f.run(), /Three explicit decisions exhausted/);
  assert.deepEqual(f.counts(), { clicks: 3, notices: 3 });
  assert.equal(f.f.listeners.size, 0);
});
