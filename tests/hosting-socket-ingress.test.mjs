import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
const require = createRequire(import.meta.url);
const secret = 'synthetic-ingress-test-key-not-a-real-secret';
Object.assign(process.env, {
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:55432/not_connected',
  NODE_ENV: 'test',
  WEB_ORIGIN: 'https://web.example.test',
  DREAMWALK_REQUIRE_INGRESS_SECRET: 'true',
  DREAMWALK_INGRESS_SECRET: secret,
});
const { attachGameSockets } = require('../apps/api/src/game/game.socket.ts');
test('canonical-Origin socket upgrades only after synthetic session authorization and still checks each projection', async (t) => {
  const server = createServer();
  let authorizedCalls = 0;
  let projectionChecks = 0;
  const cookie = `dreamwalk_session=${'b'.repeat(64)}`;
  const wss = attachGameSockets(server, {
    onShutdown() {},
    async connected(req) {
      assert.equal(req.headers.cookie, cookie);
      authorizedCalls++;
      return { connectionEpoch: 1, actorId: 'synthetic-actor' };
    },
    async snapshot(req) {
      assert.equal(req.headers.cookie, cookie);
      projectionChecks++;
      return { connectionEpoch: 1, projectionRevision: 1, projection: { fixture: true } };
    },
    subscribe() {
      return () => {};
    },
    async delivered() {},
    async disconnected() {},
    async keepAlive() {},
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/v1/game/socket?campaignId=00000000-0000-4000-8000-000000000000`,
    {
      headers: { origin: process.env.WEB_ORIGIN, cookie, 'x-dreamwalk-ingress': secret },
    },
  );
  t.after(async () => {
    ws.terminate();
    for (const client of wss.clients) client.terminate();
    await Promise.all([
      new Promise((resolve) => wss.close(resolve)),
      new Promise((resolve) => server.close(resolve)),
    ]);
  });
  const snapshot = JSON.parse((await once(ws, 'message'))[0].toString());
  assert.equal(snapshot.type, 'snapshot');
  assert.equal(snapshot.projection.fixture, true);
  assert.equal(authorizedCalls, 1);
  assert.equal(projectionChecks, 1);
});
test('real socket upgrade requires exact Origin, ingress and session authorization', async () => {
  const server = createServer();
  let authorizedCalls = 0;
  const wss = attachGameSockets(server, {
    onShutdown() {},
    async connected() {
      authorizedCalls++;
      throw new Error('Synthetic missing session');
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  async function rejected(headers) {
    const ws = new WebSocket(
      `ws://127.0.0.1:${server.address().port}/api/v1/game/socket?campaignId=00000000-0000-4000-8000-000000000000`,
      { headers },
    );
    ws.on('error', () => {});
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('Timed out'));
      }, 2000);
      ws.on('open', () => {
        clearTimeout(timer);
        ws.terminate();
        reject(new Error('Unexpected authorization'));
      });
      ws.on('unexpected-response', (_req, response) => {
        clearTimeout(timer);
        response.resume();
        response.destroy();
        ws.terminate();
        resolve(response.statusCode);
      });
    });
  }
  try {
    assert.equal(await rejected({ origin: process.env.WEB_ORIGIN }), 403);
    assert.equal(
      await rejected({ origin: 'https://wrong.example', 'x-dreamwalk-ingress': secret }),
      403,
    );
    assert.equal(
      authorizedCalls,
      0,
      'foreign Origin cannot reach session authorization even with valid ingress',
    );
    assert.equal(
      await rejected({ origin: process.env.WEB_ORIGIN, 'x-dreamwalk-ingress': secret }),
      403,
    );
    assert.equal(authorizedCalls, 1, 'valid ingress must still invoke user-session authorization');
    assert.equal(await rejected({ origin: 'null', 'x-dreamwalk-ingress': secret }), 403);
    assert.equal(await rejected({ 'x-dreamwalk-ingress': secret }), 403);
    assert.equal(authorizedCalls, 1, 'missing Origin cannot reach session authorization');
    assert.equal(await rejected({ origin: 'https://wrong.example' }), 403);
    assert.equal(authorizedCalls, 1, 'missing ingress cannot reach session authorization');
  } finally {
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
