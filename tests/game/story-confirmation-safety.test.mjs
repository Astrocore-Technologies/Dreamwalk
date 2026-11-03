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
    './story-cost': { StoryCost: 'cost' },
    './narrative-guards': { providerBoundKnown },
    './story-messages': { useStoryText: () => copy },
    './story-feed.module.css': {},
  };
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', code)(
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
  );
  const Component = Object.values(module.exports)[0];
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
  ui.button('confirm')();
  await tick();
  ui.render();
  assert.equal(calls.length, 1);
  assert.equal(ui.has('confirm'), false);
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
  ui.button('estimateWorld')();
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
