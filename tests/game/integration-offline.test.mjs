/** True offline pause preserves remaining durations, not expired absolute wall-clock deadlines. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
  db,
  startApi,
  stopApi,
  client,
  connect,
  snapshot,
  command,
  until,
  path,
} from './support-runtime.mjs';
import { authoredDraft, storyInput } from './support-authored.mjs';
const cmd = (type) => ({ protocolVersion: 1, operationId: randomUUID(), type });
const close = async (connection) => {
  const closed = once(connection.ws, 'close');
  connection.ws.close();
  await closed;
};
await test(
  'offline pause preserves round and queued-job remaining time across disconnect, crash and reconnect',
  { timeout: 90000 },
  async (t) => {
    try {
      await startApi();
      const a = await client().register(),
        b = await client().register();
      const story = await a.request('/studio/adventures', storyInput()),
        draft = authoredDraft();
      await a.request(
        `/studio/adventures/${story.id}/playable-draft`,
        { expectedRevision: 0, draft },
        'PUT',
      );
      const { versionId } = await a.request(`/studio/adventures/${story.id}/playable-versions`, {
        expectedRevision: 1,
      });
      const create = async () =>
        (await a.request('/game/campaigns', { playableVersionId: versionId })).campaignId;
      const read = async (id) =>
        (await db.query('SELECT state,runtime_clock FROM game_campaigns WHERE id=$1', [id]))
          .rows[0];
      await t.test(
        'all offline beyond original deadline and API restart retain remaining round exactly once',
        async () => {
          const id = await create(),
            active = await connect(a, id);
          assert.equal((await command(a, id, cmd('encounter.begin'))).status, 'committed');
          const before = await snapshot(a, id),
            encounterId = before.projection.encounter.id,
            originalDeadline = before.projection.encounter.deadlineMs;
          await close(active);
          const paused = await until(
            () => read(id),
            (r) => r.runtime_clock.paused,
          );
          const remaining = paused.runtime_clock.rounds[encounterId];
          assert.ok(remaining > 3000 && remaining <= 5000);
          await delay(6500);
          assert.ok(Date.now() > originalDeadline);
          const still = await read(id);
          assert.equal(still.state.tick, paused.state.tick);
          assert.deepEqual(still.state.npcBrains, paused.state.npcBrains);
          assert.deepEqual(still.runtime_clock, paused.runtime_clock);
          await stopApi('SIGKILL');
          await delay(1200);
          await startApi();
          assert.deepEqual(
            (await read(id)).runtime_clock,
            paused.runtime_clock,
            'health/startup must not resume world',
          );
          const connection = await connect(a, id),
            resumed = await snapshot(a, id),
            round = resumed.projection.encounter;
          assert.equal(round.round, 1);
          assert.equal(round.id, encounterId);
          const left = round.deadlineMs - resumed.serverNowMs;
          assert.ok(left >= remaining - 500 && left <= remaining + 100);
          assert.ok(round.deadlineMs > originalDeadline);
          assert.ok(resumed.projection.tick <= paused.state.tick + 10);
          const repeated = await snapshot(a, id);
          assert.equal(
            repeated.projection.encounter.deadlineMs,
            round.deadlineMs,
            'duplicate access must not extend remaining duration',
          );
          await delay(300);
          assert.equal((await snapshot(a, id)).projection.encounter.round, 1);
          await until(
            () => snapshot(a, id),
            (s) => s.projection.encounter?.round === 2,
            6500,
          );
          await close(connection);
        },
      );
      await t.test('one other online participant keeps the round clock running', async () => {
        const invitation = await a.request(`/studio/adventures/${story.id}/invitations`, {
          handle: b.handle,
        });
        await b.request(`/invitations/${invitation.id}/respond`, { decision: 'accept' });
        const id = await create();
        await a.request(path(id, 'invitations'), { username: b.handle });
        await b.request(path(id, 'accept'), {});
        const owner = await connect(a, id),
          guest = await connect(b, id);
        await command(a, id, cmd('encounter.begin'));
        const before = await snapshot(b, id),
          deadline = before.projection.encounter.deadlineMs;
        await close(owner);
        await delay(500);
        assert.equal((await snapshot(b, id)).projection.encounter.deadlineMs, deadline);
        assert.equal((await read(id)).runtime_clock.paused, false);
        await until(
          () => snapshot(b, id),
          (s) => s.projection.encounter?.round === 2,
          6000,
        );
        await close(guest);
      });
      await t.test(
        'queued mock job does not expire or act offline and resumes its saved budget',
        async () => {
          const id = await create(),
            active = await connect(a, id);
          assert.equal(
            (await command(a, id, { ...cmd('npc.request'), npcId: 'gardener' })).status,
            'committed',
          );
          await close(active);
          const paused = await until(
            () => read(id),
            (r) => r.runtime_clock.paused,
          );
          assert.equal(Object.keys(paused.runtime_clock.jobs).length, 1);
          const [jobId] = Object.keys(paused.runtime_clock.jobs);
          const original = (
            await db.query('SELECT status,deadline_at FROM game_npc_jobs WHERE id=$1', [jobId])
          ).rows[0];
          assert.equal(original.status, 'queued');
          await delay(8500);
          assert.ok(Date.now() > new Date(original.deadline_at).getTime());
          const offline = await read(id);
          assert.equal(offline.state.entities['authored-token'].ownerId, 'gardener');
          assert.equal(offline.state.tick, paused.state.tick);
          assert.equal(
            (await db.query('SELECT status FROM game_npc_jobs WHERE id=$1', [jobId])).rows[0]
              .status,
            'queued',
          );
          await connect(a, id);
          await until(
            () => snapshot(a, id),
            (s) => s.projection.inventory.some((e) => e.id === 'authored-token'),
            10000,
          );
          const completed = (
            await db.query('SELECT status,deadline_at FROM game_npc_jobs WHERE id=$1', [jobId])
          ).rows[0];
          assert.equal(completed.status, 'accepted');
          assert.ok(new Date(completed.deadline_at) > new Date(original.deadline_at));
        },
      );
      await t.test(
        'pre-clock migration default reconstructs queued job budget from the durable checkpoint',
        async () => {
          const id = await create(),
            active = await connect(a, id);
          const requested = await command(a, id, { ...cmd('npc.request'), npcId: 'gardener' });
          assert.equal(requested.status, 'committed');
          await close(active);
          const paused = await until(
            () => read(id),
            (r) => r.runtime_clock.paused,
          );
          const [jobId] = Object.keys(paused.runtime_clock.jobs);
          assert.ok(jobId);
          await stopApi();
          // Existing rows receive this exact default during migration015; old state and
          // job timestamps remain untouched, as does the durable updated_at checkpoint.
          await db.query(
            'UPDATE game_campaigns SET runtime_clock=\'{"paused":true,"capturedAtMs":0,"rounds":{},"jobs":{}}\' WHERE id=$1',
            [id],
          );
          const old = (await db.query('SELECT deadline_at FROM game_npc_jobs WHERE id=$1', [jobId]))
            .rows[0];
          await delay(8500);
          assert.ok(Date.now() > new Date(old.deadline_at).getTime());
          await startApi();
          await connect(a, id);
          await until(
            () => snapshot(a, id),
            (v) => v.projection.inventory.some((e) => e.id === 'authored-token'),
            10000,
          );
          const recovered = (
            await db.query('SELECT status,deadline_at FROM game_npc_jobs WHERE id=$1', [jobId])
          ).rows[0];
          assert.equal(recovered.status, 'accepted');
          assert.ok(new Date(recovered.deadline_at) > new Date(old.deadline_at));
          assert.equal(
            (await snapshot(a, id)).projection.inventory.filter((e) => e.id === 'authored-token')
              .length,
            1,
          );
          assert.ok((await read(id)).runtime_clock.capturedAtMs > 0);
        },
      );
    } finally {
      await stopApi();
      await db.end();
    }
  },
);
