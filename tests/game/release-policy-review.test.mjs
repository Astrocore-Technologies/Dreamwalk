import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
const profile = {
  totalCapMicros: null,
  textCapMicros: null,
  imageCapMicros: null,
  aggregateCapMicros: null,
  text: { model: 'test', maxOutputTokens: 2048, storyPlanMaxOutputTokens: 8192 },
  image: { model: 'test' },
};
const preview = () => ({
  active: { revision: 1, hash: 'old', profile: null },
  proposed: { candidateFingerprint: 'new', profile, canApply: true, blockers: [] },
  pendingSparkHolds: [{ id: 'held', status: 'pending', reservedSubunits: '7888' }],
});
async function harness(api) {
  const code = transformSync(
    await readFile(
      new URL('../../apps/web/components/studio/release-policy-review.tsx', import.meta.url),
      'utf8',
    ),
    { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
  ).code;
  const cells = [];
  let cursor = 0,
    tree,
    closed = 0;
  const resource = {
    data: preview(),
    loading: false,
    error: '',
    setData(v) {
      this.data = v;
    },
    reload() {
      throw Error('unexpected reload');
    },
  };
  const jsx = (type, props) => ({ type, props });
  const hooks = {
    useState(v) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = v;
      return [cells[i], (n) => (cells[i] = n)];
    },
    useRef(v) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = { current: v };
      return cells[i];
    },
  };
  const mod = { exports: {} };
  const require = (name) => {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
    if (name === '@dreamwalk/contracts') return { formatSparkSubunits: (x) => x };
    if (name === '@/lib/client')
      return { api, errorMessage: (e) => e.message, useResource: () => resource };
    if (name === '@/lib/i18n') return { useT: () => ({ t: (x) => x }) };
    if (name === '../ui')
      return { Button: 'Button', ErrorBox: 'ErrorBox', Loading: 'Loading', Modal: 'Modal' };
    throw Error(name);
  };
  new Function('require', 'module', 'exports', code)(require, mod, mod.exports);
  const render = () => {
    cursor = 0;
    return (tree = mod.exports.ReleasePolicyReview({
      actorId: 'actor',
      name: 'Account',
      onClose: () => closed++,
    }));
  };
  const nodes = (value) =>
    Array.isArray(value)
      ? value.flatMap(nodes)
      : value && typeof value === 'object'
        ? [value, ...nodes(value.props?.children)]
        : [];
  render();
  return {
    render,
    resource,
    nodes: () => nodes(tree),
    button: (label) => nodes(tree).find((n) => n.type === 'Button' && n.props.children === label),
    close: () => tree.props.onClose(),
    closed: () => closed,
  };
}
test('admin review never adopts automatically; confirmation uses exact reviewed identity once', async () => {
  const calls = [];
  let resolve;
  const h = await harness((path, options) => {
    calls.push({ path, body: JSON.parse(options.body) });
    return new Promise((r) => (resolve = r));
  });
  assert.equal(calls.length, 0);
  const confirm = h.button('Подтвердить новый профиль');
  confirm.props.onClick();
  confirm.props.onClick();
  h.close();
  assert.equal(calls.length, 1);
  assert.equal(h.closed(), 0);
  assert.deepEqual(
    { ...calls[0].body, operationId: 'ignored' },
    {
      operationId: 'ignored',
      expectedRevision: 1,
      expectedHash: 'old',
      candidateFingerprint: 'new',
      consent: true,
    },
  );
  assert.equal(calls[0].path, '/generation/release-policy/actor/revisions');
  resolve({
    status: 'applied',
    operationId: calls[0].body.operationId,
    revision: 2,
    hash: 'new',
    candidateFingerprint: 'new',
  });
  await new Promise((r) => setImmediate(r));
  h.render();
  assert.equal(h.button('Подтвердить новый профиль'), undefined);
  h.close();
  assert.equal(h.closed(), 1);
});
test('unknown adoption response permits only GET recovery and detects completed adoption', async () => {
  const calls = [];
  const h = await harness(async (path, options) => {
    calls.push({ path, options });
    if (options) throw Error('lost response');
    return {
      ...preview(),
      active: { revision: 2, hash: 'new', profile },
      proposed: {
        ...preview().proposed,
        canApply: false,
        blockers: ['GENERATION_POLICY_UNCHANGED'],
      },
    };
  });
  h.button('Подтвердить новый профиль').props.onClick();
  await new Promise((r) => setImmediate(r));
  h.render();
  assert.equal(h.button('Подтвердить новый профиль'), undefined);
  h.button('Проверить состояние').props.onClick();
  await new Promise((r) => setImmediate(r));
  h.render();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options, undefined);
  assert.equal(h.button('Подтвердить новый профиль'), undefined);
});
test('blocked review cannot adopt even through stale handler invocation', async () => {
  let count = 0;
  const h = await harness(async () => count++);
  h.resource.data.proposed.canApply = false;
  h.render();
  assert.equal(h.button('Подтвердить новый профиль').props.disabled, true);
  h.button('Подтвердить новый профиль').props.onClick();
  await new Promise((r) => setImmediate(r));
  assert.equal(count, 0);
});

test('malformed successful HTTP response cannot falsely acknowledge adoption', async () => {
  for (const receipt of [
    null,
    {},
    {
      status: 'applied',
      operationId: 'wrong',
      revision: 2,
      hash: 'new',
      candidateFingerprint: 'new',
    },
  ]) {
    const h = await harness(async () => receipt);
    h.button('Подтвердить новый профиль').props.onClick();
    await new Promise((r) => setImmediate(r));
    h.render();
    assert.ok(h.button('Проверить состояние'));
    assert.equal(h.button('Подтвердить новый профиль'), undefined);
  }
});
