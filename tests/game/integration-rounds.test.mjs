/** Stage B: persistent authored multi-round encounters use normal API and real deadlines. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  db,
  startApi,
  stopApi,
  client,
  snapshot,
  actor,
  path,
  command,
  operation,
  moveTo,
  until,
} from './support-runtime.mjs';
import { authoredDraft, storyInput } from './support-authored.mjs';
const cmd = (type, extra = {}) => ({
  protocolVersion: 1,
  operationId: randomUUID(),
  type,
  ...extra,
});
const intent = (encounter, action = { kind: 'wait' }) =>
  cmd('encounter.intent', {
    intent: {
      encounterId: encounter.id,
      generation: encounter.generation,
      round: encounter.round,
      intentRevision: 1,
      action,
      ready: true,
    },
  });
await test(
  'authored rounds queue entry at boundaries, survive restart, flee and end without global pause',
  { timeout: 45000 },
  async (t) => {
    try {
      await startApi();
      const a = await client().register(),
        b = await client().register(),
        c = await client().register();
      const story = await a.request('/studio/adventures', storyInput()),
        draft = authoredDraft();
      draft.roundPolicy.maxRounds = 4;
      // No NPC in the round fixture: NPC autonomy is verified independently.
      draft.npcs = [];
      draft.objects = draft.objects.filter((o) => !o.ownerNpcId);
      await a.request(
        `/studio/adventures/${story.id}/playable-draft`,
        { expectedRevision: 0, draft },
        'PUT',
      );
      const { versionId } = await a.request(`/studio/adventures/${story.id}/playable-versions`, {
        expectedRevision: 1,
      });
      const { campaignId: id } = await a.request('/game/campaigns', {
        playableVersionId: versionId,
      });
      for (const member of [b, c]) {
        const invitation = await a.request(`/studio/adventures/${story.id}/invitations`, {
          handle: member.handle,
        });
        await member.request(`/invitations/${invitation.id}/respond`, { decision: 'accept' });
        await a.request(path(id, 'invitations'), { username: member.handle });
        await member.request(path(id, 'accept'), {});
      }
      await moveTo(b, id, { x: 5, y: 2 });
      await moveTo(c, id, { x: 7, y: 6 });
      assert.equal(
        (await command(c, id, operation({ kind: 'transition', targetId: 'garden-exit' }))).status,
        'committed',
      );
      let round1, round2;
      await t.test(
        'join is queued, outside players do not act early, another map keeps moving',
        async () => {
          // A visible-world revision can advance between a click and admission.
          // Rejection must have no round effect; a fresh explicit operation may then commit once.
          const rejected = await command(a, id, cmd('encounter.begin', { expectedRevision: 0 }));
          assert.equal(rejected.status, 'rejected');
          assert.equal(rejected.code, 'STALE_STATE');
          assert.deepEqual(rejected.events, []);
          assert.equal(rejected.projection.encounter, undefined);
          const refreshed = await snapshot(a, id);
          const begin = cmd('encounter.begin', {
            expectedRevision: refreshed.projection.revision,
          });
          const committed = await command(a, id, begin);
          assert.equal(committed.status, 'committed');
          const replayed = await command(a, id, begin);
          assert.equal(replayed.status, 'committed');
          assert.equal(replayed.projection.encounter.id, committed.projection.encounter.id);
          assert.equal(
            Number(
              (
                await db.query(
                  'SELECT count(*) FROM game_operations WHERE campaign_id=$1 AND operation_id=$2',
                  [id, begin.operationId],
                )
              ).rows[0].count,
            ),
            1,
          );
          round1 = (await snapshot(a, id)).projection.encounter;
          assert.equal(round1.round, 1);
          const waiting = await snapshot(b, id);
          assert.ok(!waiting.projection.encounter);
          assert.ok(waiting.projection.nearbyEncounters.some((e) => e.id === round1.id));
          assert.equal(
            (await command(b, id, cmd('encounter.join', { encounterId: round1.id }))).status,
            'committed',
          );
          assert.ok(
            !(await snapshot(b, id)).projection.encounter,
            'join request cannot enter mid-round',
          );
          assert.equal((await command(b, id, intent(round1))).status, 'rejected');
          await moveTo(c, id, { x: 4, y: 2 });
          assert.equal((await snapshot(c, id)).projection.map.id, 'garden');
          assert.equal((await command(a, id, intent(round1))).status, 'committed');
          const joined = await until(
            () => snapshot(b, id),
            (s) => s.projection.encounter?.round === 2,
          );
          round2 = joined.projection.encounter;
          assert.equal(round2.id, round1.id);
          assert.ok(actor(joined).encounterId);
          assert.equal(
            (await command(a, id, intent(round1))).status,
            'rejected',
            'stale round cannot be replayed as a fresh operation',
          );
        },
      );
      await t.test(
        'persisted deadline advances exactly one round after restart and stale input stays invalid',
        async () => {
          const before = await snapshot(b, id),
            previous = actor(before),
            deadline = before.projection.encounter.deadlineMs;
          await stopApi('SIGKILL');
          await startApi();
          const restored = await snapshot(b, id);
          assert.equal(restored.projection.encounter.round, 2);
          const retainedMs = restored.projection.encounter.deadlineMs - restored.serverNowMs;
          const previousMs = deadline - before.serverNowMs;
          assert.ok(retainedMs >= previousMs - 1200 && retainedMs <= previousMs + 500);
          await b.request(
            path(id, 'move'),
            {
              connectionEpoch: before.connectionEpoch,
              inputSeq: previous.lastInputSeq + 1,
              movementGeneration: previous.movementGeneration,
              target: { x: 5, y: 2 },
            },
            'POST',
            409,
          );
          const advanced = await until(
            () => snapshot(a, id),
            (s) => s.projection.encounter?.round === 3,
            8000,
          );
          assert.equal(advanced.projection.encounter.id, round2.id);
          assert.ok(advanced.projection.encounter.deadlineMs > deadline);
          assert.equal((await snapshot(b, id)).projection.encounter.round, 3);
          await moveTo(c, id, { x: 5, y: 2 });
        },
      );
      await t.test(
        'flee exits at resolution, remaining participant continues and consensual end releases control',
        async () => {
          const round3 = (await snapshot(a, id)).projection.encounter;
          assert.equal(
            (await command(b, id, intent(round3, { kind: 'flee' }))).status,
            'committed',
          );
          assert.ok(
            (await snapshot(b, id)).projection.encounter,
            'flee must not resolve before the round boundary',
          );
          assert.equal((await command(a, id, intent(round3))).status, 'committed');
          await until(
            () => snapshot(a, id),
            (s) => s.projection.encounter?.round === 4,
          );
          const departed = await snapshot(b, id);
          assert.ok(!departed.projection.encounter);
          assert.ok(!actor(departed).encounterId);
          assert.equal((await command(a, id, cmd('encounter.end'))).status, 'committed');
          const ended = await until(
            () => snapshot(a, id),
            (s) => !s.projection.encounter,
          );
          assert.ok(!actor(ended).encounterId);
          assert.equal((await command(b, id, intent(round3))).status, 'rejected');
          await moveTo(a, id, { x: 3, y: 2 });
          assert.ok(!(await snapshot(c, id)).projection.encounter);
          const persisted = (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id]))
            .rows[0].state;
          assert.equal(persisted.encounters[round1.id].phase, 'completed');
        },
      );
    } finally {
      await stopApi();
      await db.end();
    }
  },
);
