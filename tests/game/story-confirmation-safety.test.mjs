import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import * as spatialRecovery from '../../apps/web/components/game/spatial-recovery.ts';
import * as storyGuards from '../../apps/web/components/game/story-turn-guards.ts';
import { projectionTurnFence } from '../../apps/web/components/game/turn-ui.ts';
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
    useId: () => 'hint',
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
    'lucide-react': { Send: 'send-icon', Compass: 'compass' },
    '../visual-authoring/sparks-cost': { SparkReceiptCost: 'receipt' },
    '@/components/ui': {
      Button: 'button',
      ErrorBox: 'error',
      Textarea: 'textarea',
      Modal: 'modal',
    },
    './world-generation-confirmation': { WorldGenerationConfirmation: 'world-status' },
    './living-notices': { noticeLabels: {} },
    './use-story-scroll': { useStoryScroll: () => ({}) },
    './story-turn-guards': storyGuards,
    './spatial-recovery': spatialRecovery,
    './turn-ui': { projectionTurnFence },
    './turn-messages': { useTurnText: () => copy },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    '../visual-authoring/spark-equivalent': { providerSparkSubunits },
    '@dreamwalk/contracts': { formatSparkSubunits, providerMicrosToSparkSubunits },
    '@/lib/client': { api, ApiError, errorMessage: (error) => error.message },
    '@/lib/i18n': { useT: () => ({ locale, t: copy }), getLocale: () => locale },
    '../ui': { Button: 'button', ErrorBox: 'error' },
    './story-reply-confirmation': { StoryReplyConfirmation: 'reply-confirmation' },
    './story-cost': { StoryCost: 'cost', RuntimeMapQuoteNotice: 'map-notice' },
    '../wallet-funding': { FundingBreakdown: 'funding', FundingNotice: 'funding-notice' },
    './narrative-guards': { providerBoundKnown },
    './story-messages': { useStoryText: () => copy },
    '../assets/image-messages': { useImageText: () => copy },
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
    'window',
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
    { addEventListener() {}, removeEventListener() {} },
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
  const nodes = (node) =>
    node == null || typeof node !== 'object'
      ? []
      : Array.isArray(node)
        ? node.flatMap(nodes)
        : [node, ...[].concat(node.props?.children ?? []).flatMap(nodes)];
  return {
    render,
    apiError(status) {
      return Object.assign(new ApiError(`HTTP_${status}`), { status });
    },
    button(label) {
      const found = nodes(tree).find(
        (node) => node.type === 'button' && [].concat(node.props.children ?? []).includes(label),
      );
      assert.ok(found, `Button ${label} exists`);
      return found.props.onClick;
    },
    elements(type) {
      return nodes(tree).filter((node) => node.type === type);
    },
    async flush() {
      await Promise.resolve();
      await Promise.resolve();
      render();
    },
    has(label) {
      return nodes(tree).some((node) => node.props?.children === label);
    },
    text() {
      return nodes(tree)
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
  assert.notEqual(
    calls[1].body.operationId,
    calls[0].body.operationId,
    'cancel abandons the previous quote identity',
  );
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

test('new-location world waiting preserves explicit consent without automatic writes', async () => {
  const calls = [];
  let status = {
    available: true,
    pending: false,
    unknown: false,
    reason: 'awaiting_consent',
    generatedLocationImages: 1,
  };
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

for (const status of [409, 408, 500]) {
  test(`quote HTTP ${status} ${status === 409 ? 'retires a rejected' : 'preserves an uncertain'} operation identity`, async () => {
    const calls = [];
    const ui = await harness('story-reply-confirmation', async (path, options) => {
      calls.push({ path, body: JSON.parse(options.body) });
      if (calls.length === 1) throw ui.apiError(status);
      return quote();
    });
    ui.render(props());
    ui.button('refreshEstimate')();
    await tick();
    ui.render();
    ui.button('refreshEstimate')();
    await tick();
    ui.render();
    assert.equal(calls[1].body.operationId === calls[0].body.operationId, status !== 409);
    assert.ok(calls.every((call) => call.path.endsWith('/quote')));
    ui.unmount();
  });
}

test('definitively rejected consent retires its quote before the next manual estimate', async () => {
  const calls = [];
  const ui = await harness('story-reply-confirmation', async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    if (path.endsWith('/consent')) throw ui.apiError(409);
    return quote();
  });
  ui.render(props());
  ui.button('refreshEstimate')();
  await tick();
  ui.render();
  ui.button('confirm')();
  await tick();
  ui.render();
  assert.equal(ui.has('retrySame'), false);
  ui.button('refreshEstimate')();
  await tick();
  ui.render();
  assert.equal(calls.length, 3);
  assert.notEqual(calls[2].body.operationId, calls[0].body.operationId);
  assert.equal(calls[1].body.operationId, calls[0].body.operationId);
  ui.unmount();
});

test('expiry checked at click time retires the old quote even before the timer runs', async () => {
  const calls = [];
  const prepared = quote();
  const ui = await harness('story-reply-confirmation', async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    return calls.length === 1 ? prepared : quote();
  });
  ui.render(props());
  ui.button('refreshEstimate')();
  await tick();
  ui.render();
  const now = Date.now;
  try {
    Date.now = () => Date.parse(prepared.quote.expiresAt) + 1;
    ui.button('confirm')();
  } finally {
    Date.now = now;
  }
  await tick();
  ui.render();
  assert.equal(calls.length, 1, 'expired confirmation never reaches the server');
  ui.button('refreshEstimate')();
  await tick();
  ui.render();
  assert.notEqual(calls[1].body.operationId, calls[0].body.operationId);
  ui.unmount();
});

test('a returned invalid quote is retired rather than indefinitely replayed', async () => {
  const calls = [];
  const ui = await harness('story-reply-confirmation', async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    return calls.length === 1 ? { quote: { external: true } } : quote();
  });
  ui.render(props());
  ui.button('refreshEstimate')();
  await tick();
  ui.render();
  assert.equal(ui.has('confirm'), false);
  ui.button('refreshEstimate')();
  await tick();
  ui.render();
  assert.notEqual(calls[1].body.operationId, calls[0].body.operationId);
  assert.equal(ui.has('confirm'), true);
  ui.unmount();
});

test('ordinary world status never mounts consent or makes writes, including across polling', async () => {
  const calls = [];
  const ui = await harness('world-generation-confirmation', async (...args) => {
    calls.push(args);
    return { available: true, pending: false, forecast: { estimatedSparkSubunits: '12500' } };
  });
  ui.render({ campaignId: 'campaign', scope: 'round-22', disabled: false, access: 'owner' });
  await ui.flush();
  assert.equal(ui.elements('reply-confirmation').length, 0);
  assert.equal(ui.has('worldCostForecastHint'), true, 'base estimate explains its limited scope');
  assert.match(ui.text(), /worldCostForecast:/);
  ui.expire();
  await ui.flush();
  assert.equal(ui.elements('reply-confirmation').length, 0);
  assert.ok(
    calls.every((args) => args.length === 1),
    'polling only reads status',
  );
  ui.unmount();
});

const composerProps = () => ({
  campaignId: 'campaign',
  disabled: false,
  recipient: null,
  projection: {
    actorId: 'hero',
    map: { id: 'room', exits: [] },
    entities: [],
    inventory: [],
    turn: { roundId: 'round', phaseEpoch: 1, phase: 'player' },
  },
  onClearRecipient() {},
  onWorldRefresh() {},
});
const localPostQuote = () => ({
  status: 'quoted',
  turnId: 'turn-one',
  actionPreview: [],
  quote: {
    id: 'local-quote',
    provider: 'local-turn-resolver',
    requiresConsent: false,
    external: false,
    credits: 0,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  },
});

test('one Send quotes and posts once without mounting confirmation, with immutable uncertain retry', async () => {
  const calls = [];
  let releaseQuote;
  const ui = await harness('unified-story', async (path, options) => {
    if (!options?.body)
      return { canSubmit: true, canonRevision: 4, entries: [], turns: [], configuration: {} };
    const body = JSON.parse(options.body);
    calls.push({ path, body });
    if (path.endsWith('/quote'))
      return new Promise((resolve) => {
        releaseQuote = resolve;
      });
    throw new Error('NETWORK_ERROR');
  });
  ui.render(composerProps());
  await ui.flush();
  ui.elements('textarea')[0].props.onChange({ target: { value: 'Я осматриваю дверь' } });
  ui.render();
  const send = ui.elements('form')[0].props.onSubmit;
  send({ preventDefault() {} });
  send({ preventDefault() {} });
  assert.equal(calls.length, 1);
  releaseQuote(localPostQuote());
  await tick();
  ui.render();
  assert.equal(calls.length, 2, 'the first Send also submits');
  assert.equal(ui.has('confirm'), false);
  assert.equal(ui.has('retrySame'), true);
  assert.equal(
    calls[1].body.automaticKnownCostPolicy,
    undefined,
    'free Send never accepts paid policy',
  );
  assert.equal(calls[1].body.text, calls[0].body.text);
  assert.equal(calls[1].body.operationId, calls[0].body.operationId);
  ui.button('retrySame')();
  await tick();
  ui.render();
  assert.deepEqual(calls[2], calls[1], 'unknown outcome retries the exact submission');
  ui.unmount();
});

test('ordinary ambiguous quote displays an error without clarification or automatic submission', async () => {
  const calls = [];
  const ui = await harness('unified-story', async (path, options) => {
    if (!options?.body)
      return { canSubmit: true, canonRevision: 4, entries: [], turns: [], configuration: {} };
    calls.push(path);
    return { status: 'clarification', code: 'AMBIGUOUS' };
  });
  ui.render(composerProps());
  await ui.flush();
  ui.elements('textarea')[0].props.onChange({ target: { value: '*неоднозначно*' } });
  ui.render();
  ui.elements('form')[0].props.onSubmit({ preventDefault() {} });
  await tick();
  ui.render();
  assert.equal(calls.length, 1);
  assert.equal(ui.has('confirm'), false);
  assert.equal(ui.has('ambiguous'), false);
  assert.ok(ui.elements('error').some((node) => node.props.message === 'postingRejected'));
  ui.unmount();
});

test('new-location Send retains one explicit quote confirmation', async () => {
  const writes = [];
  const ui = await harness('unified-story', async (path, options) => {
    if (!options?.body)
      return { canSubmit: true, canonRevision: 4, entries: [], turns: [], configuration: {} };
    writes.push(path);
    const result = localPostQuote();
    result.quote.generatedLocationImages = 1;
    result.quote.estimateRiskConsentRequired = true;
    return result;
  });
  ui.render(composerProps());
  await ui.flush();
  ui.elements('textarea')[0].props.onChange({ target: { value: 'Новая локация' } });
  ui.render();
  ui.elements('form')[0].props.onSubmit({ preventDefault() {} });
  await tick();
  ui.render();
  assert.equal(writes.length, 1);
  assert.equal(ui.has('confirm'), true);
  ui.unmount();
});

for (const [state, copy] of [
  ['pending', 'worldPending'],
  ['blocked', 'worldGenerationBlocked'],
]) {
  test('ordinary world ' + state + ' is informational without consent', async () => {
    const ui = await harness('world-generation-confirmation', async () => ({
      available: true,
      pending: false,
      ordinary: { state, code: null },
    }));
    ui.render({ campaignId: 'campaign', scope: 'round', disabled: false, access: 'owner' });
    await ui.flush();
    assert.equal(ui.elements('reply-confirmation').length, 0);
    assert.ok(ui.has(copy) || ui.elements('error').some((node) => node.props.message === copy));
    ui.unmount();
  });
}

for (const state of ['blocked', 'pending']) {
  test('unknown world outcome overrides ordinary ' + state, async () => {
    const ui = await harness('world-generation-confirmation', async () => ({
      available: true,
      pending: false,
      unknown: true,
      ordinary: { state, code: 'IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED' },
      generatedLocationImages: 1,
    }));
    ui.render({ campaignId: 'campaign', scope: 'round', disabled: false, access: 'owner' });
    await ui.flush();
    assert.equal(ui.has('worldCostUnresolved'), true);
    assert.equal(ui.elements('reply-confirmation').length, 0);
    ui.unmount();
  });
}
test('media-required block retains explicit confirmation while ordinary blocks explain cause', async () => {
  for (const [code, expected] of [
    ['IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED', null],
    ['INSUFFICIENT_SPARKS', 'Недостаточно искр для этой операции.'],
    ['PROVIDER_UNAVAILABLE', 'worldProviderUnavailable'],
    ['PROVIDER_BUDGET_EXCEEDED', 'worldProviderBudget'],
  ]) {
    const ui = await harness('world-generation-confirmation', async () => ({
      available: true,
      pending: false,
      ordinary: { state: 'blocked', code },
    }));
    ui.render({ campaignId: 'campaign', scope: 'round', disabled: false, access: 'owner' });
    await ui.flush();
    assert.equal(ui.elements('reply-confirmation').length, expected === null ? 1 : 0);
    if (expected) assert.ok(ui.elements('error').some((node) => node.props.message === expected));
    ui.unmount();
  }
});

test('contradictory local quote never auto-posts or offers ordinary consent', async () => {
  for (const contradiction of [
    { requiresConsent: true },
    { requiresConsent: undefined },
    { chargeUnit: 'sparks' },
    { sparkReservedSubunits: '1' },
    { sparkReservedSubunits: 'invalid' },
  ]) {
    const writes = [];
    const ui = await harness('unified-story', async (path, options) => {
      if (!options?.body)
        return { canSubmit: true, canonRevision: 4, entries: [], turns: [], configuration: {} };
      writes.push(path);
      const result = localPostQuote();
      Object.assign(result.quote, contradiction);
      return result;
    });
    ui.render(composerProps());
    await ui.flush();
    ui.elements('textarea')[0].props.onChange({ target: { value: 'Осматриваю дверь' } });
    ui.render();
    ui.elements('form')[0].props.onSubmit({ preventDefault() {} });
    await tick();
    ui.render();
    assert.equal(writes.length, 1);
    assert.equal(ui.has('confirm'), false);
    assert.ok(ui.elements('error').some((node) => node.props.message === 'postingRejected'));
    ui.unmount();
  }
});

test('ordinary successful post stays compact without instructions, deferred notice or confirmation', async () => {
  const calls = [];
  let receipt;
  const ui = await harness('unified-story', async (path, options) => {
    if (!options?.body)
      return {
        canSubmit: true,
        canonRevision: 4,
        entries: [],
        turns: receipt ? [receipt] : [],
        configuration: {},
      };
    const input = JSON.parse(options.body);
    calls.push({ path, input });
    if (path.endsWith('/quote')) return localPostQuote();
    receipt = {
      id: input.turnId,
      operationId: input.operationId,
      status: 'committed',
      code: 'NPC_REPLY_DEFERRED',
    };
    return receipt;
  });
  ui.render(composerProps());
  await ui.flush();
  assert.equal(ui.has('worldBatchPosting'), false);
  ui.elements('textarea')[0].props.onChange({ target: { value: 'Осматриваю двор' } });
  ui.render();
  ui.elements('form')[0].props.onSubmit({ preventDefault() {} });
  await tick();
  ui.render();
  assert.equal(calls.length, 2, 'one Send quotes and posts');
  assert.equal(ui.elements('textarea')[0].props.value, '');
  assert.equal(ui.has('worldBatchPosting'), false);
  assert.equal(ui.has('worldCostForecastHint'), false);
  assert.equal(ui.has('deferred'), false);
  assert.equal(ui.has('confirm'), false);
  assert.equal(ui.elements('reply-confirmation').length, 0);
  ui.unmount();
});

test('one explicit compound confirmation covers text plus image risk without automatic consent', async () => {
  const calls = [];
  const prepared = quote();
  Object.assign(prepared.quote, { generatedLocationImages: 2, estimateRiskConsentRequired: true });
  const ui = await harness('story-reply-confirmation', async (path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    return path.endsWith('/quote') ? prepared : { accepted: true };
  });
  ui.render(props());
  ui.button('refreshEstimate')();
  await tick();
  ui.render();
  assert.equal(calls.length, 1);
  assert.ok(ui.text().includes('В оценку входит новая локация'));
  ui.button('confirm')();
  await tick();
  ui.render();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.consent, true);
  assert.equal(calls[1].body.estimateRiskConsent, true);
  assert.equal(calls[1].body.quoteId, prepared.quote.id);
  ui.unmount();
});

test('location picker sends a free direct transition once and stays open after a rejected move', async () => {
  const ui = await harness('location-picker');
  let calls = 0,
    finish;
  const p = {
    projection: {
      map: { id: 'origin' },
      locations: [
        { id: 'origin', label: 'Here' },
        { id: 'cafe', label: 'Cafe' },
      ],
    },
    disabled: false,
    onTravel: async () => {
      calls++;
      return new Promise((resolve) => (finish = resolve));
    },
  };
  ui.render(p);
  ui.render();
  ui.button('Выбрать локацию')();
  ui.render();
  assert.equal(ui.elements('modal').length, 1);
  ui.button('Here')();
  assert.equal(calls, 0);
  ui.button('Cafe')();
  ui.button('Cafe')();
  assert.equal(calls, 1);
  finish(false);
  await tick();
  ui.render();
  assert.equal(ui.elements('modal').length, 1);
  ui.button('Cafe')();
  assert.equal(calls, 2);
  finish(true);
  await tick();
  ui.render();
  assert.equal(ui.elements('modal').length, 0);
  ui.unmount();
});
test('location picker closes when the authoritative map changes and cannot act while disabled', async () => {
  const ui = await harness('location-picker');
  let calls = 0;
  const p = {
    projection: {
      map: { id: 'origin' },
      locations: [
        { id: 'origin', label: 'Here' },
        { id: 'cafe', label: 'Cafe' },
      ],
    },
    disabled: false,
    onTravel: async () => {
      calls++;
      return true;
    },
  };
  ui.render(p);
  ui.render();
  ui.button('Выбрать локацию')();
  ui.render();
  ui.render({ ...p, disabled: true });
  ui.button('Cafe')();
  assert.equal(calls, 0);
  ui.render({ ...p, projection: { ...p.projection, map: { id: 'cafe' } } });
  ui.render();
  assert.equal(ui.elements('modal').length, 0);
  ui.unmount();
});

test('declining a new location synchronously disables stale paid confirmation and retries only the same cancellation', async () => {
  const calls = [];
  let attempts = 0;
  const ui = await harness('story-reply-confirmation', async (path) => {
    calls.push(path);
    return quote();
  });
  ui.render({
    ...props(),
    onDecline: async () => {
      attempts++;
      if (attempts === 1) throw new Error('response lost');
    },
  });
  ui.render();
  ui.button('refreshEstimate')();
  await tick();
  ui.render();
  const staleConfirm = ui.button('confirm');
  ui.button('declineLocation')();
  staleConfirm();
  await tick();
  ui.render();
  assert.equal(calls.filter((path) => path.endsWith('/consent')).length, 0);
  assert.equal(ui.has('confirm'), false);
  assert.match(ui.text(), /declineUnknown/);
  ui.button('retrySame')();
  await tick();
  ui.render();
  assert.equal(attempts, 2);
  assert.equal(calls.filter((path) => path.endsWith('/consent')).length, 0);
});
test('declining a location is available even when pricing fails and never dispatches generation', async () => {
  let declined = 0;
  const ui = await harness('story-reply-confirmation', async () => {
    throw new Error('estimate failed');
  });
  ui.render({
    ...props(),
    onDecline: async () => {
      declined++;
    },
  });
  ui.render();
  ui.button('refreshEstimate')();
  await tick();
  ui.render();
  assert.equal(ui.has('declineLocation'), true);
  ui.button('declineLocation')();
  await tick();
  assert.equal(declined, 1);
});

test('definite decline refusal restores pricing and decline controls in the same scope', async () => {
  const calls = [];
  const ui = await harness('story-reply-confirmation', async (path) => {
    calls.push(path);
    return quote();
  });
  ui.render({
    ...props(),
    onDecline: async () => {
      throw ui.apiError(409);
    },
  });
  ui.render();
  ui.button('refreshEstimate')();
  await tick();
  ui.render();
  ui.button('declineLocation')();
  await tick();
  ui.render();
  assert.equal(ui.has('declineLocation'), true);
  assert.doesNotMatch(ui.text(), /declineUnknown/);
  ui.button('refreshEstimate')();
  await tick();
  ui.render();
  assert.equal(calls.filter((path) => path.endsWith('/quote')).length, 2);
  assert.equal(calls.filter((path) => path.endsWith('/consent')).length, 0);
  assert.equal(ui.has('confirm'), true);
});
test('uncertain decline clears quote timers and retains the exact cancellation when props change', async () => {
  let prices = 0,
    original = 0,
    newer = 0;
  const ui = await harness('story-reply-confirmation', async () => {
    prices++;
    return quote();
  });
  const p = {
    ...props(),
    worldBatch: true,
    onDecline: async () => {
      original++;
      if (original === 1) throw new Error('lost response');
    },
  };
  ui.render(p);
  ui.render();
  ui.expire();
  await tick();
  ui.render();
  ui.button('declineLocation')();
  await tick();
  ui.render();
  ui.render({
    ...p,
    onDecline: async () => {
      newer++;
    },
  });
  ui.expire();
  await tick();
  ui.render();
  assert.equal(prices, 1);
  assert.equal(ui.has('confirm'), false);
  ui.button('retrySame')();
  await tick();
  ui.render();
  assert.equal(original, 2);
  assert.equal(newer, 0);
  assert.equal(prices, 1);
});

for (const marked of [true, false]) {
  test(`world image policy ${marked ? 'acceptance' : 'legacy exclusion'} survives unknown-response retries`, async () => {
    const calls = [];
    let consentCount = 0;
    const quoted = quote();
    if (marked)
      Object.assign(quoted.quote, {
        automaticKnownCostPolicy: 'known-cost-v1',
        automaticKnownCostPolicyHash: 'a'.repeat(64),
        generatedLocationImages: 1,
      });
    const ui = await harness('story-reply-confirmation', async (path, options) => {
      calls.push({ path, body: JSON.parse(options.body) });
      if (path.endsWith('/quote')) return quoted;
      if (++consentCount === 1) throw new Error('NETWORK_ERROR');
      return {};
    });
    ui.render({ ...props(), worldBatch: true });
    ui.expire();
    await tick();
    ui.render();
    assert.equal(calls.filter((call) => call.path.endsWith('/consent')).length, 0);
    ui.button('confirm')();
    await tick();
    ui.render({ ...props(), worldBatch: true, scope: 'changed' });
    ui.button('retrySame')();
    await tick();
    ui.render();
    const accepted = calls.filter((call) => call.path.endsWith('/consent'));
    assert.equal(accepted.length, 2);
    assert.deepEqual(accepted[0].body, accepted[1].body);
    assert.equal(
      accepted[0].body.automaticKnownCostPolicyHash,
      marked ? 'a'.repeat(64) : undefined,
    );
    ui.unmount();
  });
}
test('combined price discloses quoted image policy only for explicitly marked requests', async () => {
  for (const marked of [false, true]) {
    const value = quote().quote;
    if (marked)
      Object.assign(value, {
        automaticKnownCostPolicy: 'known-cost-v1',
        automaticKnownCostPolicyHash: 'b'.repeat(64),
      });
    const ui = await harness('story-cost');
    ui.render({ quote: value });
    assert.equal(ui.has('automaticKnownCostNotice'), marked);
  }
});

for (const marked of [true, false]) {
  test(`direct reply ${marked ? 'accepts quoted' : 'omits legacy'} policy in original consent and exact retry`, async () => {
    const calls = [];
    const result = quote();
    if (marked) result.quote.automaticKnownCostPolicy = 'known-cost-v1';
    const ui = await harness('story-reply-confirmation', async (path, options) => {
      calls.push({ path, body: JSON.parse(options.body) });
      if (path.endsWith('/quote')) return result;
      throw new Error('NETWORK_ERROR');
    });
    ui.render(props());
    ui.render();
    ui.button('refreshEstimate')();
    await tick();
    ui.render();
    assert.deepEqual(Object.keys(calls[0].body), ['operationId']);
    ui.button('confirm')();
    await tick();
    ui.render();
    ui.button('retrySame')();
    await tick();
    ui.render();
    assert.equal(calls[1].body.automaticKnownCostPolicy, marked ? 'known-cost-v1' : undefined);
    assert.equal(calls[1].body.automaticKnownCostPolicyHash, undefined);
    assert.deepEqual(calls[1], calls[2]);
    ui.unmount();
  });
  test(`direct story ${marked ? 'accepts quoted' : 'omits legacy'} policy only after existing confirmation`, async () => {
    const calls = [];
    const result = { ...localPostQuote(), ...quote(), turnId: 'turn-one', actionPreview: [] };
    if (marked) result.quote.automaticKnownCostPolicy = 'known-cost-v1';
    const ui = await harness('unified-story', async (path, options) => {
      if (!options?.body)
        return {
          canSubmit: true,
          canonRevision: 4,
          entries: [],
          turns: [],
          configuration: { enabled: true, provider: 'openai', externalCallsEnabled: true },
        };
      calls.push({ path, body: JSON.parse(options.body) });
      if (path.endsWith('/quote')) return result;
      throw new Error('NETWORK_ERROR');
    });
    const p = composerProps();
    delete p.projection.turn;
    ui.render(p);
    await ui.flush();
    ui.elements('textarea')[0].props.onChange({ target: { value: 'Ответ персонажу' } });
    ui.render();
    ui.elements('form')[0].props.onSubmit({ preventDefault() {} });
    await tick();
    ui.render();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.automaticKnownCostPolicy, undefined);
    assert.equal(ui.has('confirm'), true);
    ui.elements('form')[0].props.onSubmit({ preventDefault() {} });
    await tick();
    ui.render();
    assert.equal(calls[1].body.automaticKnownCostPolicy, marked ? 'known-cost-v1' : undefined);
    ui.button('retrySame')();
    await tick();
    ui.render();
    assert.deepEqual(calls[1], calls[2]);
    ui.unmount();
  });
}

test('direct text policy disclosure needs the exact quote marker, not an image hash', async () => {
  for (const marker of [undefined, 'known-cost-v1']) {
    const ui = await harness('story-cost');
    ui.render({ quote: { ...quote().quote, automaticKnownCostPolicy: marker } });
    assert.equal(ui.has('automaticKnownCostNotice'), marker === 'known-cost-v1');
  }
});

for (const [status, jobStatus, sparkStatus, sparkCapturedSubunits, message] of [
  ['ready', 'applied', 'settled', '213', 'locationReady'],
  ['failed', 'stale', 'settled', '213', 'locationFailed'],
  ['unknown', 'unknown', 'pending', null, 'locationUnknown'],
  ['queued', 'queued', 'held', null, 'locationPreparing'],
  ['unknown', undefined, undefined, undefined, 'locationUnknown'],
])
  test(`travel receipt exposes ${status}/${sparkStatus ?? 'no hold'} grounding without a new request`, async () => {
    const grounding = {
      status,
      jobStatus,
      sparkStatus,
      ...(sparkStatus ? { sparkReservedSubunits: '345', sparkCapturedSubunits } : {}),
    };
    const turn = {
      id: 'travel-turn',
      status: 'committed',
      travel: {
        destinationName: 'Cafe',
        status: status === 'ready' ? 'committed' : 'accepted',
        imageStatus: 'admitted',
        sparkStatus: 'settled',
        sparkReservedSubunits: '100',
        sparkCapturedSubunits: '80',
        grounding,
      },
    };
    const calls = [];
    const ui = await harness('unified-story', async (...args) => {
      calls.push(args);
      return { canSubmit: true, canonRevision: 4, entries: [], turns: [turn], configuration: {} };
    });
    ui.render(composerProps());
    await ui.flush();
    assert.match(ui.text(), new RegExp(message));
    const costs = ui.elements('receipt').map((node) => node.props.receipt);
    assert.ok(
      costs.some((r) => r.sparkCapturedSubunits === '80'),
      'image cost remains separate',
    );
    const actual = costs.find((r) => r.sparkReservedSubunits === '345');
    if (sparkStatus) {
      assert.ok(
        ui
          .elements('p')
          .some((node) => [].concat(node.props.children ?? []).includes('locationGroundingCost')),
      );
      assert.deepEqual(actual, { ...grounding, generationCost: null });
    } else assert.equal(actual, undefined, 'no synthetic zero/refund for an absent hold');
    assert.ok(
      calls.every((args) => !args[1]?.body && (!args[1]?.method || args[1].method === 'GET')),
      'receipt reads do not dispatch or consent',
    );
    ui.unmount();
  });

const autonomousReceipt = (id, outcome, amount) => ({
  id,
  createdAt: '2026-01-02T12:30:00.000Z',
  status: 'settled',
  outcome,
  reservedSubunits: '10000',
  capturedSubunits: amount,
  funding: { dreamsCapturedSubunits: '0', sparksCapturedSubunits: amount },
});
for (const locale of ['ru', 'en', 'uk']) {
  test(`autonomous receipt pagination reads only and retains the current unknown-liability warning (${locale})`, async () => {
    const calls = [];
    let finishOlder;
    const current = {
      available: false,
      pending: true,
      unknown: true,
      speechReceipts: [autonomousReceipt('new', 'delivered', '1664')],
      speechReceiptNext: 'older-cursor',
    };
    const ui = await harness(
      'world-generation-confirmation',
      (...args) => {
        calls.push(args);
        return args[0].includes('?')
          ? new Promise((resolve) => {
              finishOlder = resolve;
            })
          : Promise.resolve(current);
      },
      locale,
    );
    ui.render({
      campaignId: 'campaign',
      scope: 'round',
      disabled: false,
      access: 'owner',
      phase: 'players',
    });
    await ui.flush();
    assert.equal(ui.has('worldSpeechDelivered'), true);
    assert.equal(ui.elements('time').length, 1);
    assert.equal(ui.has('worldCostUnresolved'), true);
    ui.button('worldSpeechOlder')();
    ui.render();
    assert.equal(ui.has('worldSpeechDelivered'), false, 'old receipt page disappears immediately');
    assert.equal(ui.has('worldCostUnresolved'), true, 'billing gate is not the receipt page');
    finishOlder({
      ...current,
      speechReceipts: [autonomousReceipt('old', 'failed', '888')],
      speechReceiptNext: undefined,
    });
    await ui.flush();
    assert.equal(ui.has('worldSpeechFailed'), true);
    assert.equal(ui.has('worldSpeechDelivered'), false);
    assert.equal(ui.has('worldCostUnresolved'), true);
    ui.button('worldSpeechNewest')();
    ui.render();
    await ui.flush();
    assert.equal(ui.has('worldSpeechDelivered'), true);
    assert.equal(ui.has('worldSpeechFailed'), false);
    assert.deepEqual(
      calls.map((args) => args[0]),
      [
        '/game/campaigns/campaign/world-generation',
        '/game/campaigns/campaign/world-generation?speechReceiptBefore=older-cursor',
        '/game/campaigns/campaign/world-generation',
      ],
    );
    assert.ok(
      calls.every((args) => args.length === 1),
      'no quote, consent, retry or mutation',
    );
    ui.unmount();
  });
}

for (const interruption of ['campaign', 'access']) {
  test(`late autonomous receipt page cannot cross ${interruption} boundary`, async () => {
    const calls = [];
    let finishOlder;
    const initial = {
      campaignId: 'campaign',
      scope: 'round',
      disabled: false,
      access: 'owner',
      phase: 'players',
    };
    const ui = await harness('world-generation-confirmation', (...args) => {
      calls.push(args);
      if (args[0].includes('?'))
        return new Promise((resolve) => {
          finishOlder = resolve;
        });
      return Promise.resolve({
        available: false,
        pending: false,
        speechReceipts: [autonomousReceipt('new', 'delivered', '1664')],
        speechReceiptNext: 'older-cursor',
      });
    });
    ui.render(initial);
    await ui.flush();
    ui.button('worldSpeechOlder')();
    ui.render();
    ui.render({
      ...initial,
      ...(interruption === 'campaign' ? { campaignId: 'other' } : { access: 'member' }),
    });
    assert.equal(ui.has('worldSpeechDelivered'), false);
    finishOlder({
      available: false,
      pending: false,
      speechReceipts: [autonomousReceipt('old', 'failed', '888')],
    });
    await ui.flush();
    assert.equal(ui.has('worldSpeechFailed'), false, 'late old-page reply is ignored');
    if (interruption === 'access') ui.render(initial);
    ui.expire();
    await ui.flush();
    assert.equal(ui.has('worldSpeechFailed'), false);
    assert.ok(
      !calls.slice(2).some((args) => args[0].includes('speechReceiptBefore')),
      'page cursor resets at the ownership/campaign boundary',
    );
    assert.ok(calls.every((args) => args.length === 1));
    ui.unmount();
  });
}

test('failed older receipt read does not display a stale page or erase current unknown liability', async () => {
  const calls = [];
  const ui = await harness('world-generation-confirmation', async (...args) => {
    calls.push(args);
    if (args[0].includes('?')) throw Error('STATUS_FAILED');
    return {
      available: false,
      pending: true,
      unknown: true,
      speechReceipts: [autonomousReceipt('new', 'silent', '555')],
      speechReceiptNext: 'older-cursor',
    };
  });
  ui.render({
    campaignId: 'campaign',
    scope: 'round',
    disabled: false,
    access: 'owner',
    phase: 'players',
  });
  await ui.flush();
  assert.equal(ui.has('worldSpeechSilent'), true);
  ui.button('worldSpeechOlder')();
  ui.render();
  await ui.flush();
  assert.equal(ui.has('worldSpeechSilent'), false);
  assert.equal(ui.has('worldCostUnresolved'), true);
  assert.equal(ui.elements('reply-confirmation').length, 0);
  assert.ok(calls.every((args) => args.length === 1));
  ui.unmount();
});

for (const locale of ['ru', 'en', 'uk']) {
  test(`bounded ordinary speech skip is explained without intermediate consent or a fake charge (${locale})`, async () => {
    const calls = [];
    const ui = await harness(
      'world-generation-confirmation',
      async (...args) => {
        calls.push(args);
        return {
          available: false,
          pending: false,
          speechSkips: [
            {
              id: 'skip-one',
              createdAt: '2026-01-02T12:30:00.000Z',
              reason: 'allowance_exhausted',
            },
            {
              id: 'skip-two',
              createdAt: '2026-01-02T12:31:00.000Z',
              reason: 'allowance_unavailable',
            },
            {
              id: 'skip-three',
              createdAt: '2026-01-02T12:32:00.000Z',
              reason: 'legacy_uncovered',
            },
          ],
        };
      },
      locale,
    );
    const initial = {
      campaignId: 'campaign',
      scope: 'round',
      disabled: false,
      access: 'owner',
      phase: 'world',
    };
    ui.render(initial);
    await ui.flush();
    assert.equal(ui.has('worldSpeechSkipExhausted'), true);
    assert.equal(ui.has('worldSpeechSkipUnavailable'), true);
    assert.equal(ui.has('worldSpeechSkipLegacy'), true);
    assert.equal(ui.elements('reply-confirmation').length, 0);
    assert.equal(ui.has('worldSpeechReceipts'), false);
    assert.equal(ui.has('worldPending'), false);
    ui.render({ ...initial, phase: 'players' });
    await ui.flush();
    assert.equal(ui.elements('reply-confirmation').length, 0);
    ui.render({ ...initial, access: 'member', phase: 'players' });
    assert.equal(ui.has('worldSpeechSkipExhausted'), false);
    assert.equal(ui.has('worldSpeechSkipUnavailable'), false);
    assert.equal(ui.has('worldSpeechSkipLegacy'), false);
    assert.ok(
      calls.every((args) => args.length === 1),
      'status only; no additional consent/quote',
    );
    ui.unmount();
  });
}
