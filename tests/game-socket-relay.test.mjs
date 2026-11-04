import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import {
  relayGameSocket,
  socketRelayTarget,
  openGameSocketRelay,
} from '../apps/web/lib/game-socket-relay.ts';

const env = {
  VERCEL: '1',
  API_URL: 'https://api.example.test',
  WEB_ORIGIN: 'https://web.example.test',
  DREAMWALK_INGRESS_SECRET: 'a'.repeat(40),
};
const campaign = '12345678-1234-1234-1234-123456789012';
const request = (headers = {}) =>
  new Request(
    `https://web.example.test/api/v1/game/socket?campaignId=${campaign}&url=https://attacker.test`,
    {
      headers: {
        origin: env.WEB_ORIGIN,
        cookie: `dreamwalk_session=${'b'.repeat(64)}`,
        ...headers,
      },
    },
  );
test('relay target and headers stay fixed while the owner-approved origin pause preserves session and secret checks', () => {
  const target = socketRelayTarget(
    request({ authorization: 'ignored', 'x-dreamwalk-ingress': 'spoof' }),
    env,
  );
  assert.equal(target.url, `wss://api.example.test/api/v1/game/socket?campaignId=${campaign}`);
  assert.deepEqual(Object.keys(target.headers).sort(), ['cookie', 'origin', 'x-dreamwalk-ingress']);
  assert.equal(target.headers['x-dreamwalk-ingress'], env.DREAMWALK_INGRESS_SECRET);
  assert.equal(
    socketRelayTarget(request({ origin: 'https://attacker.test' }), env).headers.origin,
    env.WEB_ORIGIN,
  );
  assert.throws(() => socketRelayTarget(request({ cookie: '' }), env));
  assert.throws(() => socketRelayTarget(request(), { ...env, DREAMWALK_INGRESS_SECRET: '' }));
  assert.throws(() =>
    socketRelayTarget(request(), { ...env, API_URL: 'https://u:p@api.example.test' }),
  );
  assert.equal(socketRelayTarget(request(), { ...env, VERCEL: undefined }), null);
});
async function fixture(t, { autoPong = true, lifetime = 280000 } = {}) {
  const backend = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const frontend = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 8192 });
  await Promise.all([once(backend, 'listening'), once(frontend, 'listening')]);
  const upstreamConnection = once(backend, 'connection');
  const browserConnection = once(frontend, 'connection');
  const browser = new WebSocket(`ws://127.0.0.1:${frontend.address().port}`, { autoPong });
  const [browserServer] = await browserConnection;
  const upstream = new WebSocket(`ws://127.0.0.1:${backend.address().port}`, { autoPong: false });
  relayGameSocket(browserServer, upstream, lifetime);
  const [backendSocket] = await upstreamConnection;
  await delay(10);
  t.after(async () => {
    for (const socket of [browser, browserServer, upstream, backendSocket]) socket.terminate();
    await Promise.all([
      new Promise((r) => frontend.close(r)),
      new Promise((r) => backend.close(r)),
    ]);
  });
  return { browser, backendSocket };
}
test('real WS relay sends each operation once and preserves session-revocation close code', async (t) => {
  const { browser, backendSocket } = await fixture(t);
  let count = 0;
  backendSocket.on('message', () => count++);
  const command = once(backendSocket, 'message');
  browser.send('{"type":"command","operationId":"one"}');
  assert.equal((await command)[0].toString(), '{"type":"command","operationId":"one"}');
  const snapshot = once(browser, 'message');
  backendSocket.send('{"type":"snapshot"}');
  assert.equal((await snapshot)[0].toString(), '{"type":"snapshot"}');
  const closed = once(browser, 'close');
  backendSocket.close(4001);
  assert.equal((await closed)[0], 4001);
  assert.equal(count, 1);
});
test('upstream ping is answered only by a responsive browser, not relay autoPong', async (t) => {
  const { browser, backendSocket } = await fixture(t, { autoPong: false });
  let pongs = 0;
  backendSocket.on('pong', () => pongs++);
  const ping = once(browser, 'ping');
  backendSocket.ping('challenge');
  assert.equal((await ping)[0].toString(), 'challenge');
  await delay(30);
  assert.equal(pongs, 0);
  const pong = once(backendSocket, 'pong');
  browser.pong('challenge');
  assert.equal((await pong)[0].toString(), 'challenge');
});
test('relay lifetime closes both ends for normal reconnect without replay', async (t) => {
  const { browser, backendSocket } = await fixture(t, { lifetime: 100 });
  const closes = await Promise.all([once(browser, 'close'), once(backendSocket, 'close')]);
  assert.deepEqual(
    closes.map((v) => v[0]),
    [1012, 1012],
  );
});
test('binary commands are rejected before reaching API', async (t) => {
  const { browser, backendSocket } = await fixture(t);
  let messages = 0;
  backendSocket.on('message', () => messages++);
  const closed = once(browser, 'close');
  browser.send(Buffer.from('unsafe'));
  assert.equal((await closed)[0], 1009);
  assert.equal(messages, 0);
});

test('oversized client frames never reach the API and close the peer', async (t) => {
  const { browser, backendSocket } = await fixture(t);
  let messages = 0;
  backendSocket.on('message', () => messages++);
  const closed = once(browser, 'close');
  browser.send('x'.repeat(8193));
  assert.equal((await closed)[0], 1009);
  assert.equal(messages, 0);
});

test('browser disconnect tears down upstream rather than retaining a live game lease', async (t) => {
  const { browser, backendSocket } = await fixture(t);
  const closed = once(backendSocket, 'close');
  browser.close(1000);
  assert.equal((await closed)[0], 1000);
});

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent = [];
  code = null;
  send(data, _options, callback) {
    this.sent.push(data);
    callback?.();
  }
  close(code) {
    this.code = code;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code);
  }
  terminate() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1006);
  }
  ping() {}
  pong() {}
}
test('connection queue is bounded and is never replayed after overflow', () => {
  const browser = new FakeSocket(),
    upstream = new FakeSocket();
  upstream.readyState = WebSocket.CONNECTING;
  relayGameSocket(browser, upstream);
  for (let i = 0; i < 9; i++) browser.emit('message', Buffer.from('{}'), false);
  assert.equal(browser.code, 1013);
  upstream.emit('open');
  assert.equal(upstream.sent.length, 0);
});
test('backpressure closes both ends without sending another operation', () => {
  const browser = new FakeSocket(),
    upstream = new FakeSocket();
  upstream.bufferedAmount = 1024 * 1024;
  relayGameSocket(browser, upstream);
  browser.emit('message', Buffer.from('{}'), false);
  assert.equal(browser.code, 1013);
  assert.equal(upstream.sent.length, 0);
});

for (const status of [401, 403, 500]) {
  test(`upstream handshake ${status} maps to the correct browser close without retry`, async (t) => {
    let attempts = 0;
    const backend = createServer((_req, res) => {
      attempts++;
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end('not forwarded');
    });
    backend.listen(0, '127.0.0.1');
    const frontend = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await Promise.all([once(backend, 'listening'), once(frontend, 'listening')]);
    const connected = once(frontend, 'connection');
    const browser = new WebSocket(`ws://127.0.0.1:${frontend.address().port}`);
    const closed = once(browser, 'close');
    const [browserServer] = await connected;
    openGameSocketRelay(browserServer, {
      url: `ws://127.0.0.1:${backend.address().port}/api/v1/game/socket`,
      headers: {
        cookie: 'synthetic',
        origin: env.WEB_ORIGIN,
        'x-dreamwalk-ingress': env.DREAMWALK_INGRESS_SECRET,
      },
    });
    t.after(async () => {
      browser.terminate();
      browserServer.terminate();
      await Promise.all([
        new Promise((r) => frontend.close(r)),
        new Promise((r) => backend.close(r)),
      ]);
    });
    assert.equal((await closed)[0], status === 500 ? 1011 : 1008);
    assert.equal(attempts, 1);
  });
}
