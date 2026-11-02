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
test('real socket upgrade requires ingress AND Origin before session authorization', async () => {
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
    assert.equal(authorizedCalls, 0);
    assert.equal(
      await rejected({ origin: process.env.WEB_ORIGIN, 'x-dreamwalk-ingress': secret }),
      403,
    );
    assert.equal(authorizedCalls, 1, 'valid ingress must still invoke user-session authorization');
  } finally {
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
