/** Real transport liveness: brief client stalls are safe; truly silent peers are bounded. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
  db,
  startApi,
  stopApi,
  client,
  connect,
  snapshot,
  actor,
  path,
  moveTo,
  until,
} from './support-runtime.mjs';
await test(
  'heartbeat tolerates a brief stalled client, safely stops movement and closes silent peers',
  { timeout: 30000 },
  async (t) => {
    try {
      await startApi();
      const a = await client().register();
      const { campaignId: id } = await a.request('/game/campaigns', { template: 'observatory-v1' });
      await t.test(
        '3.5 second client-only event-loop stall does not destroy a healthy session',
        async () => {
          const connection = await connect(a, id),
            before = await snapshot(a, id),
            p = actor(before);
          const input = {
            connectionEpoch: before.connectionEpoch,
            inputSeq: p.lastInputSeq + 1,
            movementGeneration: p.movementGeneration,
            target: { x: 9, y: 1 },
          };
          await a.request(path(id, 'move'), input);
          // API is a separate process. Only this client's JavaScript/pong processing is delayed.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3500);
          await delay(350);
          assert.equal(
            connection.ws.readyState,
            1,
            `Brief stall closed socket: ${JSON.stringify(connection.closes)}`,
          );
          const stopped = await snapshot(a, id),
            position = actor(stopped);
          assert.ok(
            position.movementGeneration > p.movementGeneration,
            'silence stops old movement without unnecessarily closing the socket',
          );
          await delay(300);
          const still = actor(await snapshot(a, id));
          assert.deepEqual([still.x, still.y], [position.x, position.y]);
          await a.request(path(id, 'move'), input, 'POST', 409);
          await moveTo(a, id, { x: 2, y: 6 });
          assert.equal(connection.ws.readyState, 1);
          connection.ws.close();
          await once(connection.ws, 'close');
        },
      );
      await t.test(
        'a peer that never answers ping is closed within the documented grace period',
        async () => {
          const connection = await connect(a, id, undefined, { autoPong: false });
          const closed = once(connection.ws, 'close'),
            start = Date.now();
          const before = await snapshot(a, id),
            p = actor(before);
          await a.request(path(id, 'move'), {
            connectionEpoch: before.connectionEpoch,
            inputSeq: p.lastInputSeq + 1,
            movementGeneration: p.movementGeneration,
            target: { x: 9, y: 1 },
          });
          await until(
            () => snapshot(a, id),
            (value) => actor(value).movementGeneration > p.movementGeneration,
            3500,
          );
          const [code] = await Promise.race([
            closed,
            delay(4500).then(() => {
              throw new Error('Silent peer exceeded heartbeat close bound');
            }),
          ]);
          assert.equal(code, 4000);
          assert.ok(Date.now() - start <= 6100);
        },
      );
    } finally {
      await stopApi();
      await db.end();
    }
  },
);
