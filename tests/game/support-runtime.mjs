/** Shared isolated API/WS harness. Never targets the managed preview. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import WebSocket from 'ws';

const base = process.env.TEST_GAME_API_URL;
for (const url of [base, process.env.DATABASE_URL])
  assert.ok(
    url && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname),
    'Disposable local services required',
  );
const origin = process.env.WEB_ORIGIN;
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let api;
const sockets = new Set();
async function until(read, predicate, timeout = 6000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(120);
  } while (Date.now() < deadline);
  assert.fail('Expected game state did not arrive before bounded deadline');
}
async function startApi() {
  api = spawn(process.execPath, ['apps/api/dist/main.js'], {
    env: process.env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  api.stderr.on('data', () => {}); // Do not echo private requests, cookies or SQL parameters.
  await until(
    async () => {
      if (api.exitCode !== null) assert.fail(`API exited during startup (${api.exitCode})`);
      return fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })
        .then((r) => r.ok)
        .catch(() => false);
    },
    Boolean,
    15000,
  );
}
async function stopApi(signal = 'SIGTERM') {
  if (signal === 'SIGKILL' && api && api.exitCode === null && api.signalCode === null) {
    const exited = once(api, 'exit');
    api.kill('SIGKILL');
    await exited;
  }
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  if (!api || api.exitCode !== null || api.signalCode !== null) return;
  const exited = once(api, 'exit');
  const deadline = setTimeout(() => api.kill('SIGKILL'), 8000);
  api.kill('SIGTERM');
  try {
    await exited;
  } finally {
    clearTimeout(deadline);
  }
}
function client() {
  let cookie = '';
  return {
    user: null,
    handle: '',
    email: '',
    get cookie() {
      return cookie;
    },
    async request(path, body, method = body === undefined ? 'GET' : 'POST', expected) {
      const response = await fetch(base + path, {
        // Bound transport waits without turning concurrent development compilation into a
        // false domain failure. Gameplay tick/deadline assertions retain their own limits.
        signal: AbortSignal.timeout(15000),
        method,
        headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const updated = response.headers.getSetCookie();
      if (updated.length) cookie = updated.map((v) => v.split(';')[0]).join('; ');
      const value = await response.json();
      if (expected !== undefined)
        assert.equal(
          response.status,
          expected,
          `${method} ${path}: ${value.code ?? value.status ?? 'unexpected status'}`,
        );
      else
        assert.ok(response.ok, `${method} ${path}: ${response.status}/${value.code ?? 'unknown'}`);
      return value;
    },
    async register() {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
      this.handle = `game_${suffix}`;
      this.email = `game-${suffix}@example.test`;
      this.user = (
        await this.request(
          '/auth/register',
          {
            email: this.email,
            handle: this.handle,
            name: 'Game QA',
            password: `Synthetic-${randomUUID()}!`,
          },
          'POST',
          201,
        )
      ).user;
      return this;
    },
  };
}
const path = (id, suffix) => `/game/campaigns/${id}/${suffix}`;
const snapshot = (c, id) => c.request(path(id, 'snapshot'));
const actor = (snap) => snap.projection.entities.find((e) => e.id === snap.projection.actorId);
const operation = (action) => ({
  protocolVersion: 1,
  operationId: randomUUID(),
  type: 'action',
  action,
});
const command = (c, id, body) => c.request(path(id, 'commands'), body);
async function moveTo(c, id, target) {
  const snap = await snapshot(c, id),
    a = actor(snap);
  await c.request(path(id, 'move'), {
    connectionEpoch: snap.connectionEpoch,
    inputSeq: (a.lastInputSeq ?? 0) + 1,
    movementGeneration: a.movementGeneration,
    target,
  });
  return until(
    () => snapshot(c, id),
    (s) => {
      const p = actor(s);
      return p.x === target.x && p.y === target.y;
    },
    10000,
  );
}
async function connect(c, id, suppliedOrigin = origin, options = {}) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + `/game/socket?campaignId=${id}`, {
    autoPong: options.autoPong ?? true,
    headers: { origin: suppliedOrigin, ...(c.cookie ? { cookie: c.cookie } : {}) },
  });
  sockets.add(ws);
  const messages = [];
  const closes = [];
  ws.on('close', (code, reason) =>
    closes.push({ code, reason: reason.toString(), time: Date.now() }),
  );
  ws.on('message', (raw) => {
    messages.push(JSON.parse(raw.toString()));
    if (messages.length > 150) messages.shift();
  });
  await once(ws, 'open');
  await until(() => messages.find((m) => m.type === 'snapshot'), Boolean);
  return { ws, messages, closes };
}
async function rejectedSocket(c, id, suppliedOrigin = origin) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + `/game/socket?campaignId=${id}`, {
    headers: { origin: suppliedOrigin, ...(c.cookie ? { cookie: c.cookie } : {}) },
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('Handshake rejection timed out'));
    }, 4000);
    ws.on('open', () => {
      clearTimeout(timeout);
      ws.terminate();
      reject(new Error('Unauthorized socket opened'));
    });
    ws.on('unexpected-response', (_req, response) => {
      clearTimeout(timeout);
      response.resume();
      ws.terminate();
      resolve(response.statusCode);
    });
    ws.on('error', () => {});
  });
}

export {
  db,
  until,
  startApi,
  stopApi,
  client,
  path,
  snapshot,
  actor,
  operation,
  command,
  moveTo,
  connect,
  rejectedSocket,
};
