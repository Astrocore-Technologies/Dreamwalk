/** Memory-only scheduling regression: no database, credentials, or provider calls. */
const test = require('node:test');
const assert = require('node:assert/strict');
const configPath = require.resolve('../../apps/api/dist/config.js');
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: { config: { NODE_ENV: 'test', AI_PROVIDER: 'mock', GLOBAL_SPEND_CAP: 0 } },
};
const { GameService } = require('../../apps/api/dist/game/game.service.js');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  let tick;
  const original = global.setInterval;
  global.setInterval = (callback) => {
    tick = callback;
    return { unref() {} };
  };
  let service;
  try {
    const forbidden = new Proxy(
      {},
      {
        get: (_target, key) =>
          key === 'attachRuntimeStateReader'
            ? (reader) => {
                assert.equal(typeof reader, 'function');
              }
            : () => {
                throw new Error('No external work allowed in scheduler test');
              },
      },
    );
    service = new GameService(forbidden, forbidden, forbidden, forbidden, {
      attachRuntimeStateReader() {},
    });
  } finally {
    global.setInterval = original;
  }
  // A loaded campaign always has state. This scheduler-only fixture is not a
  // turn-based round and must never authorize generation through the timer.
  service.live.set('campaign', { state: {} });
  return { service, tick };
}

test('world step gets a FIFO turn even when polling never leaves an idle gap', async () => {
  const { service, tick } = harness();
  const order = [];
  let release;
  const poll = service.serial(
    'campaign',
    () =>
      new Promise((resolve) => {
        release = () => {
          order.push('first poll');
          resolve();
        };
      }),
  );
  await flush();
  service.advance = async () => {
    order.push('world');
  };
  tick();
  const nextPoll = service.serial('campaign', async () => {
    order.push('next poll');
  });
  // A burst of timer callbacks must not create catch-up world steps.
  for (let i = 0; i < 50; i++) tick();
  release();
  await Promise.all([poll, nextPoll]);
  await flush();
  assert.deepEqual(order, ['first poll', 'world', 'next poll']);
  assert.equal(service.scheduledAdvances.size, 0);
  tick();
  await flush();
  assert.deepEqual(order, ['first poll', 'world', 'next poll', 'world']);
});

test('an executing world step is coalesced and a failed step can retry', async () => {
  const { service, tick } = harness();
  let calls = 0,
    reject;
  service.advance = () => {
    calls++;
    return new Promise((_, fail) => {
      reject = fail;
    });
  };
  tick();
  await flush();
  for (let i = 0; i < 50; i++) tick();
  assert.equal(calls, 1);
  reject(new Error('synthetic database failure'));
  await flush();
  assert.equal(service.scheduledAdvances.size, 0);
  service.advance = async () => {
    calls++;
  };
  tick();
  await flush();
  assert.equal(calls, 2);
});

test('campaigns schedule independently without bypassing their serial queues', async () => {
  const { service, tick } = harness();
  service.live.set('other', { state: {} });
  const calls = [];
  let release;
  const blocked = service.serial(
    'campaign',
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await flush();
  service.advance = async (id) => {
    calls.push(id);
  };
  tick();
  await flush();
  assert.deepEqual(calls, ['other']);
  release();
  await blocked;
  await flush();
  assert.deepEqual(calls, ['other', 'campaign']);
});
