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
const { reconfirmKnownStale } = exports;
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
  return { page, order, listeners, expected: { type: body.type, action: body.action } };
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
