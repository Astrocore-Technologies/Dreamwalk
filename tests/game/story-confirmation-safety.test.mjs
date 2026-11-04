import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import {
  formatSparkSubunits,
  providerMicrosToSparkSubunits,
} from '../../packages/contracts/dist/index.js';
import { providerSparkSubunits } from '../../apps/web/components/visual-authoring/spark-equivalent.ts';
import { providerBoundKnown } from '../../apps/web/components/game/narrative-guards.ts';

// Execute the actual component handlers with deterministic hooks/transport/time.
// This is not a browser test: layout and actual React scheduling remain CI coverage.
async function harness(filename, api = async () => ({}), locale = 'ru') {
  const source = await readFile(
    new URL(`../../apps/web/components/game/${filename}.tsx`, import.meta.url),
    'utf8',
  );
  const code = transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code;
  const cells = [],
    effects = [],
    timers = new Map();
  let cursor = 0,
    nextTimer = 0,
    tree,
    props;
  const react = {
    useCallback(fn, deps) {
      const index = cursor++;
      const old = cells[index];
      if (!old || deps.some((dep, i) => dep !== old.deps[i])) cells[index] = { deps, fn };
      return cells[index].fn;
    },
    useState(initial) {
      const index = cursor++;
      if (!cells[index]) cells[index] = { value: initial };
      return [
        cells[index].value,
        (value) => {
          cells[index].value = typeof value === 'function' ? value(cells[index].value) : value;
        },
      ];
    },
    useRef(value) {
      const index = cursor++;
      if (!cells[index]) cells[index] = { current: value };
      return cells[index];
    },
    useEffect(fn, deps) {
      const index = cursor++;
      const old = cells[index];
      if (!old || deps.some((dep, i) => dep !== old.deps[i])) {
        cells[index] = { deps, cleanup: old?.cleanup };
        effects.push(() => {
          cells[index].cleanup?.();
          cells[index].cleanup = fn();
        });
      }
    },
  };
  const jsx = (type, elementProps) => ({ type, props: elementProps });
  const copy = (key, values) => (values ? `${key}:${JSON.stringify(values)}` : key);
  class ApiError extends Error {}
  const module = { exports: {} };
  const imports = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    '../visual-authoring/spark-equivalent': { providerSparkSubunits },
    '@dreamwalk/contracts': { formatSparkSubunits, providerMicrosToSparkSubunits },
    '@/lib/client': { api, ApiError, errorMessage: (error) => error.message },
    '@/lib/i18n': { useT: () => ({ locale }) },
    '../ui': { Button: 'button', ErrorBox: 'error' },
    './story-reply-confirmation': { StoryReplyConfirmation: 'reply-confirmation' },
    './story-cost': { StoryCost: 'cost', RuntimeMapQuoteNotice: 'map-notice' },
    '../wallet-funding': { FundingBreakdown: 'funding', FundingNotice: 'funding-notice' },
    './narrative-guards': { providerBoundKnown },
    './story-messages': { useStoryText: () => copy },
    './story-feed.module.css': {},
  };
  new Function(
    'require',
    'module',
    'exports',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    code,
  )(
    (name) => {
      assert.ok(name in imports, name);
      return imports[name];
    },
    module,
    module.exports,
    (fn) => {
      timers.set(++nextTimer, fn);
      return nextTimer;
    },
    (id) => timers.delete(id),
    (fn) => {
      timers.set(++nextTimer, fn);
      return nextTimer;
    },
    (id) => timers.delete(id),
  );
  const Component =
    module.exports[
      { 'story-cost': 'StoryCost', 'story-reply-confirmation': 'StoryReplyConfirmation' }[filename]
    ] ?? Object.values(module.exports)[0];
  function render(next = props) {
    props = next;
    cursor = 0;
    tree = Component(props);
    while (effects.length) effects.shift()();
    return tree;
  }
  const nodes = (node = tree) =>
    node == null || typeof node !== 'object'
      ? []
      : [node, ...[].concat(node.props?.children ?? []).flatMap(nodes)];
  return {
    render,
    button(label) {
      const found = nodes().find((node) => node.type === 'button' && node.props.children === label);
      assert.ok(found, `Button ${label} exists`);
      return found.props.onClick;
    },
    elements(type) {
      return nodes().filter((node) => node.type === type);
    },
    async flush() {
      await Promise.resolve();
      await Promise.resolve();
      render();
    },
    has(label) {
      return nodes().some((node) => node.props?.children === label);
    },
    text() {
      return nodes()
        .map((node) => (typeof node.props?.children === 'string' ? node.props.children : ''))
        .filter(Boolean)
        .join(' ');
    },
    expire() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((fn) => fn());
    },
    unmount() {
      for (const cell of cells) cell?.cleanup?.();
    },
  };
}
const quote = () => ({
  status: 'quoted',
  quote: {
    id: 'quote-one',
    external: true,
    providerUpperMicros: 12500,
    chargeUnit: 'sparks',
    sparkReservedSubunits: '12500',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  },
});
const props = () => ({
  campaignId: 'campaign',
  turnId: 'turn',
  scope: 'round-one',
  disabled: false,
  onChanged: async () => {},
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const interruption of ['expiry', 'scope-change']) {
  test(`reply consent preserves the exact retry operation after in-flight ${interruption}`, async () => {
    const calls = [];
    let rejectFirst;
    const ui = await harness('story-reply-confirmation', async (path, options) => {
      calls.push({ path, body: JSON.parse(options.body) });
      if (path.endsWith('/quote')) return quote();
      if (calls.filter((call) => call.path.endsWith('/consent')).length === 1)
        return new Promise((_, reject) => {
          rejectFirst = reject;
        });
      return { status: 'authorized' };
    });
    const initial = props();
    ui.render(initial);
    ui.render();
    ui.button('refreshEstimate')();
    await tick();
    ui.render();
    const estimateOperation = calls[0].body.operationId;
    ui.button('confirm')();
    ui.render();
    if (interruption === 'expiry') ui.expire();
    else ui.render({ ...initial, scope: 'round-two' });
    ui.render();
    rejectFirst(new Error('NETWORK_ERROR'));
    await tick();
    ui.render();
    assert.equal(ui.has('retrySame'), true);
    ui.button('retrySame')();
    await tick();
    ui.render();
    const consents = calls.filter((call) => call.path.endsWith('/consent'));
    assert.equal(consents.length, 2);
    assert.deepEqual(consents[1], consents[0]);
    assert.equal(consents[0].body.operationId, estimateOperation);
    assert.equal(consents[0].body.consent, true);
  });
}

test('reply cancel makes no consent call; repeated synchronous confirmation dispatches once', async () => {
  const calls = [];
  let resolveConsent;
  const ui = await harness('story-reply-confirmation', async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    if (path.endsWith('/quote')) return quote();
    return new Promise((resolve) => {
      resolveConsent = resolve;
    });
  });
  ui.render(props());
  ui.render();
  ui.button('refreshEstimate')();
  await tick();
  ui.render();
  ui.button('dismiss')();
  ui.render();
  assert.equal(calls.length, 1);
  ui.button('refreshEstimate')();
  await tick();
  ui.render();
  const confirm = ui.button('confirm');
  confirm();
  confirm();
  assert.equal(calls.filter((call) => call.path.endsWith('/consent')).length, 1);
  resolveConsent({ status: 'authorized' });
  await tick();
  ui.render();
});

for (const interruption of ['scope-change', 'unmount']) {
  test(`late reply estimate cannot become actionable after ${interruption}`, async () => {
    let resolveQuote;
    const ui = await harness(
      'story-reply-confirmation',
      () =>
        new Promise((resolve) => {
          resolveQuote = resolve;
        }),
    );
    const initial = props();
    ui.render(initial);
    ui.render();
    ui.button('refreshEstimate')();
    if (interruption === 'scope-change') ui.render({ ...initial, scope: 'round-two' });
    else ui.unmount();
    resolveQuote(quote());
    await tick();
    ui.render();
    assert.equal(ui.has('confirm'), false);
  });
}

test('Sparks estimate remains distinct from hold and demo units', async () => {
  const ui = await harness('story-cost');
  ui.render({
    quote: {
      credits: 0,
      external: true,
      chargeUnit: 'sparks',
      sparkReservedSubunits: '20000',
      estimatedTotalMicros: 12500,
      sparkRateVersion: 'api-cent-2-sparks-v2',
    },
  });
  assert.match(ui.text(), /estimatedCost:\{"amount":"2,50"\}/);
  assert.match(ui.text(), /estimatedHold:\{"amount":"2,00"\}/);
  ui.render({
    quote: { credits: 0, external: false, chargeUnit: 'sparks', sparkReservedSubunits: '12500' },
  });
  assert.match(ui.text(), /estimatedCost:\{"amount":"1,25"\}/);
  assert.match(ui.text(), /estimatedHold:\{"amount":"1,25"\}/);
  for (const sparkRateVersion of ['api-cent-1-spark-v1', undefined, 'unknown']) {
    ui.render({
      quote: {
        credits: 0,
        external: true,
        chargeUnit: 'sparks',
        sparkReservedSubunits: '20000',
        estimatedTotalMicros: 12500,
        sparkRateVersion,
      },
    });
    assert.match(
      ui.text(),
      sparkRateVersion === 'api-cent-1-spark-v1'
        ? /estimatedCost:\{"amount":"1,25"\}/
        : /estimatedCost:\{"amount":"2,00"\}/,
    );
    assert.match(ui.text(), /estimatedHold:\{"amount":"2,00"\}/);
  }
  ui.render({ quote: { credits: 0, external: false } });
  assert.equal(ui.text(), 'freeTurn');
  ui.render({ quote: { credits: 0, external: true } });
  assert.equal(ui.text(), 'noBound');
  ui.render({ quote: { credits: 0, external: true, providerUpperMicros: 12500 } });
  assert.match(ui.text(), /providerEstimateOnly/);
  assert.doesNotMatch(ui.text(), /estimatedHold/);
});

test('a malformed reply quote expiry cannot be consented even before its timer fires', async () => {
  const calls = [];
  const invalid = quote();
  invalid.quote.expiresAt = 'not-a-date';
  const ui = await harness('story-reply-confirmation', async (path) => {
    calls.push(path);
    return invalid;
  });
  ui.render(props());
  ui.render();
  ui.button('refreshEstimate')();
  await tick();
  ui.render();
  assert.equal(calls.length, 1);
  assert.equal(ui.has('confirm'), false);
  assert.equal(ui.elements('error')[0].props.message, 'expired');
});

test('world batch uses one aggregate quote and one immutable consent, never per-request approval', async () => {
  const calls = [];
  const ui = await harness('story-reply-confirmation', async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    return path.endsWith('/quote') ? quote() : { accepted: true, pending: true };
  });
  ui.render({
    ...props(),
    endpoint: '/game/campaigns/campaign/world-generation',
    worldBatch: true,
  });
  ui.render();
  assert.equal(ui.has('estimateWorld'), false);
  ui.expire();
  await tick();
  ui.render();
  ui.button('confirm')();
  await tick();
  ui.render();
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/game/campaigns/campaign/world-generation/quote',
      '/game/campaigns/campaign/world-generation/consent',
    ],
  );
  assert.equal(calls[1].body.operationId, calls[0].body.operationId);
  assert.equal(calls[1].body.consent, true);
  assert.equal('text' in calls[1].body, false);
});

test('a refresh failure after acknowledged consent never becomes an uncertain new dispatch', async () => {
  const calls = [];
  const ui = await harness('story-reply-confirmation', async (path) => {
    calls.push(path);
    return path.endsWith('/quote') ? quote() : { accepted: true };
  });
  ui.render({
    ...props(),
    onChanged: async () => {
      throw new Error('REFRESH_FAILED');
    },
  });
  ui.render();
  ui.button('refreshEstimate')();
  await tick();
  ui.render();
  ui.button('confirm')();
  await tick();
  ui.render();
  assert.equal(ui.has('retrySame'), false);
  assert.equal(calls.length, 2);
});

test('cancel invalidates the quote synchronously before a stale confirm handler can run', async () => {
  const calls = [];
  const ui = await harness('story-reply-confirmation', async (path) => {
    calls.push(path);
    return quote();
  });
  ui.render(props());
  ui.render();
  ui.button('refreshEstimate')();
  await tick();
  ui.render();
  const staleConfirm = ui.button('confirm');
  ui.button('dismiss')();
  staleConfirm();
  await tick();
  assert.equal(calls.filter((path) => path.endsWith('/consent')).length, 0);
});

test('currency-aware story estimates pass the original allocation through without labeling total as Sparks', async () => {
  const ui = await harness('story-cost');
  const funding = {
    policyVersion: 'dreams-first-v1',
    dreamsReservedSubunits: '10000',
    sparksReservedSubunits: '2500',
    totalReservedSubunits: '12500',
    maxSparksSubunits: '12500',
    allocation: 'estimate',
  };
  const tree = ui.render({
    quote: {
      external: true,
      credits: 0,
      chargeUnit: 'sparks',
      sparkReservedSubunits: '12500',
      funding,
    },
  });
  assert.equal(tree.props.children[0].type, 'funding');
  assert.equal(tree.props.children[0].props.funding, funding);
  assert.equal(tree.props.children[1].type, 'funding-notice');
  assert.doesNotMatch(ui.text(), /estimatedHold|estimatedCost/);
});

test('world waiting shows metadata and preserves the standard consent action without automatic writes', async () => {
  const calls = [];
  let status = { available: true, pending: false, unknown: false, reason: 'awaiting_consent' };
  const ui = await harness('world-generation-confirmation', async (...args) => {
    calls.push(args);
    return status;
  });
  const props = { campaignId: 'campaign', scope: 'round-22', disabled: false, access: 'owner' };
  ui.render(props);
  await ui.flush();
  assert.equal(ui.elements('reply-confirmation').length, 1);
  assert.equal(
    ui.elements('reply-confirmation')[0].props.endpoint,
    '/game/campaigns/campaign/world-generation',
  );
  assert.equal(ui.elements('reply-confirmation')[0].props.worldBatch, true);
  assert.ok(
    calls.every((args) => args.length === 1),
    'polling performs GET only',
  );
  ui.render({ ...props, membershipError: true });
  assert.equal(ui.elements('error')[0].props.message, 'worldMembersError');
  assert.equal(
    ui.elements('reply-confirmation').length,
    1,
    'a verified owner keeps uncertain consent mounted during member refresh failures',
  );
  assert.equal(ui.elements('reply-confirmation')[0].props.disabled, true);
  ui.render({ ...props, membershipPending: true });
  assert.equal(ui.has('worldCheckingOwner'), true);
  assert.equal(
    ui.elements('reply-confirmation')[0].props.disabled,
    true,
    'retry does not re-enable consent before membership verification',
  );
  ui.render(props);
  assert.equal(ui.elements('reply-confirmation')[0].props.disabled, false);
  ui.render({ ...props, scope: 'new-world-revision' });
  assert.equal(
    ui.elements('reply-confirmation').length,
    1,
    'scope refresh retains the immutable consent controller',
  );
  await ui.flush();
  ui.unmount();
  for (const [reason, copy] of [
    ['manual_authorization_required', 'worldManualAuthorization'],
    ['unavailable', 'worldGenerationUnavailable'],
    ['no_pending_generation', 'worldNoPendingGeneration'],
  ]) {
    status = { available: false, pending: false, unknown: false, reason };
    const waiting = await harness('world-generation-confirmation', async () => status);
    waiting.render(props);
    await waiting.flush();
    assert.equal(waiting.has(copy), true);
    assert.equal(waiting.elements('reply-confirmation').length, 0);
    waiting.unmount();
  }
  const unknown = await harness('world-generation-confirmation', async () => ({
    available: false,
    pending: true,
    unknown: true,
  }));
  unknown.render(props);
  await unknown.flush();
  assert.equal(unknown.has('worldCostUnresolved'), true);
  assert.equal(unknown.elements('reply-confirmation').length, 0);
  unknown.unmount();
});

test('unverified members and non-owners see safe guidance without reading private generation status', async () => {
  let calls = 0;
  const ui = await harness('world-generation-confirmation', async () => {
    calls++;
    throw new Error('unexpected private read');
  });
  const props = { campaignId: 'campaign', scope: 'round-22', disabled: false };
  ui.render({ ...props, access: 'error' });
  await ui.flush();
  assert.equal(ui.elements('error')[0].props.message, 'worldMembersError');
  ui.render({ ...props, access: 'loading' });
  assert.equal(ui.has('worldCheckingOwner'), true);
  ui.render({ ...props, access: 'member' });
  assert.equal(ui.has('worldOwnerReview'), true);
  assert.equal(calls, 0);
  assert.equal(ui.elements('reply-confirmation').length, 0);
  ui.unmount();
});

test('game page propagates membership revalidation instead of treating cleared retry errors as success', async () => {
  const source = await readFile(
    new URL('../../apps/web/components/game/game-page.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /members\.error\s*\? 'error'\s*:\s*members\.loading \|\| !members\.data \|\| !user\s*\? 'loading'/,
  );
});

test('live world pricing prepares once per scope, refreshes after expiry, and never consents itself', async () => {
  const calls = [];
  const ui = await harness('story-reply-confirmation', async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    return quote();
  });
  const initial = { ...props(), worldBatch: true };
  ui.render(initial);
  assert.equal(calls.length, 0, 'the calculation is debounced');
  assert.equal(ui.has('worldCostCalculating'), true);
  ui.expire();
  await tick();
  ui.render();
  assert.equal(calls.length, 1);
  assert.equal(ui.has('confirm'), true);
  assert.equal(ui.has('dismiss'), false, 'no redundant quote panel/cancel in the live row');
  ui.render();
  await tick();
  assert.equal(calls.length, 1);
  ui.expire();
  ui.render();
  ui.expire();
  await tick();
  ui.render();
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].body.operationId, calls[0].body.operationId);
  ui.render({ ...initial, scope: 'round-two' });
  ui.expire();
  await tick();
  ui.render();
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.path.endsWith('/quote')));
  ui.unmount();
});

test('a failed live quote stops retrying until requested and reuses its uncertain operation', async () => {
  const calls = [];
  const ui = await harness('story-reply-confirmation', async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    if (calls.length === 1) throw new Error('NETWORK_ERROR');
    return quote();
  });
  ui.render({ ...props(), worldBatch: true });
  ui.expire();
  await tick();
  ui.render();
  assert.equal(ui.has('retryEstimate'), true);
  ui.expire();
  await tick();
  ui.render();
  assert.equal(calls.length, 1);
  ui.button('retryEstimate')();
  await tick();
  ui.render();
  assert.equal(calls[1].body.operationId, calls[0].body.operationId);
  assert.equal(ui.has('confirm'), true);
  ui.unmount();
});

test('live quote drops a late old-scope result and pauses while membership is disabled', async () => {
  const calls = [];
  let resolve;
  const ui = await harness('story-reply-confirmation', async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    return calls.length === 1
      ? new Promise((done) => {
          resolve = done;
        })
      : quote();
  });
  const initial = { ...props(), worldBatch: true, disabled: true };
  ui.render(initial);
  ui.expire();
  assert.equal(calls.length, 0);
  ui.render({ ...initial, disabled: false });
  ui.expire();
  ui.render({ ...initial, disabled: false, scope: 'round-two' });
  resolve(quote());
  await tick();
  ui.render();
  assert.equal(ui.has('confirm'), false);
  ui.expire();
  await tick();
  ui.render();
  assert.equal(ui.has('confirm'), true);
  assert.equal(calls.length, 2);
  ui.unmount();
});

test('unknown consent recovery never automatically creates another paid operation', async () => {
  const calls = [];
  let failed = false;
  const ui = await harness('story-reply-confirmation', async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    if (path.endsWith('/quote')) return quote();
    if (!failed) {
      failed = true;
      throw new Error('NETWORK_ERROR');
    }
    return { accepted: true };
  });
  ui.render({
    ...props(),
    worldBatch: true,
    onChanged: async () => {
      throw new Error('STATUS_FAILED');
    },
  });
  ui.expire();
  await tick();
  ui.render();
  ui.button('confirm')();
  await tick();
  ui.render();
  assert.equal(ui.has('retrySame'), true);
  ui.expire();
  assert.equal(calls.length, 2);
  ui.button('retrySame')();
  await tick();
  ui.render();
  ui.expire();
  await tick();
  ui.render();
  assert.equal(calls.length, 3);
  assert.equal(
    ui.has('retryEstimate'),
    false,
    'acknowledged dispatch never offers a replacement quote',
  );
  assert.deepEqual(calls[2], calls[1]);
  ui.unmount();
});

test('player phase shows a live local forecast without quote or consent and preserves unresolved billing', async () => {
  const calls = [];
  let status = {
    available: false,
    pending: false,
    forecast: {
      estimatedSparkSubunits: '12500',
      estimatedTotalMicros: 6250,
      requestCount: 2,
      basis: 'local_round_forecast',
      includesMapAnalysis: false,
      finalQuoteRequired: true,
    },
  };
  let failed = false;
  const ui = await harness('world-generation-confirmation', async (...args) => {
    calls.push(args);
    if (failed) throw new Error('STATUS_FAILED');
    return status;
  });
  const initial = {
    campaignId: 'campaign',
    scope: 'round-one',
    disabled: false,
    access: 'owner',
    phase: 'players',
  };
  ui.render(initial);
  await ui.flush();
  assert.match(ui.text(), /worldCostForecast/);
  assert.equal(ui.elements('reply-confirmation').length, 0);
  assert.ok(calls.every((args) => args.length === 1));
  status = { ...status, pending: false, unknown: true };
  ui.render({ ...initial, scope: 'round-two' });
  await ui.flush();
  assert.equal(ui.has('worldCostUnresolved'), true);
  assert.doesNotMatch(ui.text(), /worldCostForecast/);
  failed = true;
  ui.render({ ...initial, scope: 'round-three' });
  await ui.flush();
  assert.equal(
    ui.has('worldCostUnresolved'),
    true,
    'failed read must retain the previous uncertainty',
  );
  assert.equal(ui.elements('reply-confirmation').length, 0);
  ui.unmount();
});

test('game toolbar shows both account-bound currencies and refreshes after round changes', async () => {
  const room = await readFile(
    new URL('../../apps/web/components/game/game-page.tsx', import.meta.url),
    'utf8',
  );
  const wallet = await readFile(
    new URL('../../apps/web/components/game/game-wallet.tsx', import.meta.url),
    'utf8',
  );
  assert.match(room, /<GameWallet\s+ownerId=\{user\.id\}/);
  assert.match(wallet, /<SparksBalance ownerId=\{ownerId\}/);
  assert.match(wallet, /<DreamsBalance ownerId=\{ownerId\}/);
  assert.match(wallet, /\[ownerId, scope\]/);
  assert.match(wallet, /SPARKS_REFRESH_EVENT/);
  assert.doesNotMatch(wallet, /campaign.*ownerId|\/consent|\/quote/);
});
