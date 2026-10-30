/** Stage C: an explicit free mock request executes a bounded, durable real-world plan. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  db,
  startApi,
  stopApi,
  client,
  snapshot,
  command,
  operation,
  moveTo,
  until,
  path,
} from './support-runtime.mjs';
import { authoredDraft, storyInput } from './support-authored.mjs';
import { exportGameData, purgeGameData } from '../../scripts/game-data-requests.mjs';

await test(
  'authored mock NPC plans persist, move before giving, remember bounded facts and expose no private brain',
  { timeout: 45000 },
  async (t) => {
    try {
      await startApi();
      const a = await client().register();
      const npc = await a.request('/npcs', {
        name: 'Private gardener',
        secrets: 'PRIVATE_PLAN_SOURCE_SECRET',
      });
      const story = await a.request('/studio/adventures', storyInput()),
        draft = authoredDraft(npc.id);
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
      const read = async () =>
        (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id])).rows[0].state;
      const take = operation({ kind: 'pick_up', targetId: 'authored-key' });
      let accepted;
      await t.test(
        'one committed observed action is remembered exactly once, replay cannot duplicate facts',
        async () => {
          accepted = await command(a, id, take);
          assert.equal(accepted.status, 'committed');
          const before = (await read()).npcBrains.gardener.facts;
          assert.ok(before.some((f) => f.kind === 'item_taken'));
          assert.deepEqual(await command(a, id, take), accepted);
          assert.deepEqual((await read()).npcBrains.gardener.facts, before);
          const visible = JSON.stringify(await snapshot(a, id));
          for (const hidden of [
            'npcBrains',
            'PRIVATE_PLAN_SOURCE_SECRET',
            'patrolTarget',
            'nextDecisionTick',
            'npcDefinitions',
          ])
            assert.ok(!visible.includes(hidden));
        },
      );
      await t.test(
        'queued request survives hard crash and approach→owned give→patrol remains bounded',
        async () => {
          const request = {
            protocolVersion: 1,
            operationId: randomUUID(),
            type: 'npc.request',
            npcId: 'gardener',
          };
          const result = await command(a, id, request);
          assert.equal(result.status, 'committed');
          assert.ok(
            !(await snapshot(a, id)).projection.inventory.some((e) => e.id === 'authored-token'),
            'remote item is not granted immediately',
          );
          await stopApi('SIGKILL');
          await startApi();
          await until(
            () => snapshot(a, id),
            (s) => s.projection.inventory.some((e) => e.id === 'authored-token'),
            10000,
          );
          await until(
            () => snapshot(a, id),
            (s) => s.projection.entities.some((e) => e.id === 'gardener' && e.x === 6 && e.y === 3),
            10000,
          );
          const state = await read(),
            brain = state.npcBrains.gardener;
          assert.equal(state.entities['authored-token'].ownerId, `player-${a.user.id}`);
          assert.equal(state.entities.gardener.inventory.length, 0);
          assert.ok(brain.plan.length <= 3);
          assert.ok(brain.cursor >= brain.plan.length);
          assert.ok(brain.facts.some((f) => f.kind === 'helped'));
          assert.deepEqual(await command(a, id, request), result);
          await stopApi();
          await startApi();
          const restored = await read();
          assert.deepEqual(restored.npcBrains.gardener.facts, brain.facts);
          assert.equal(
            (await snapshot(a, id)).projection.inventory.filter((e) => e.id === 'authored-token')
              .length,
            1,
          );
        },
      );
      await t.test(
        'adversarial client proposals cannot mint items, alter wallet or address missing NPC',
        async () => {
          const wallet = await a.request('/wallet');
          const request = () => ({
            protocolVersion: 1,
            operationId: randomUUID(),
            type: 'npc.request',
            npcId: 'gardener',
          });
          await a.request(
            path(id, 'commands'),
            { ...request(), proposal: { actions: [{ kind: 'give', itemId: 'forged-gold' }] } },
            'POST',
            400,
          );
          assert.equal(
            (await command(a, id, { ...request(), npcId: 'not-visible-or-existent' })).status,
            'rejected',
          );
          assert.equal((await a.request('/wallet')).balance, wallet.balance);
          assert.ok(!(await read()).entities['forged-gold']);
        },
      );
      await t.test(
        'many real observed door changes keep at most sixteen deduplicated facts',
        async () => {
          await moveTo(a, id, { x: 5, y: 6 });
          assert.equal(
            (await command(a, id, operation({ kind: 'unlock', targetId: 'authored-door' }))).status,
            'committed',
          );
          for (let i = 0; i < 20; i++)
            assert.equal(
              (
                await command(
                  a,
                  id,
                  operation({ kind: i % 2 ? 'close' : 'open', targetId: 'authored-door' }),
                )
              ).status,
              'committed',
            );
          const facts = (await read()).npcBrains.gardener.facts;
          assert.equal(facts.length, 16);
          assert.equal(new Set(facts.map((f) => f.eventId)).size, 16);
          assert.ok(facts.every((f) => f.kind === 'door_changed'));
          await stopApi();
          await startApi();
          assert.deepEqual((await read()).npcBrains.gardener.facts, facts);
        },
      );
      await t.test(
        'revoking and immediately restoring source access cannot resurrect a queued NPC job',
        async () => {
          const guest = await client().register();
          const invitation = await a.request(`/studio/adventures/${story.id}/invitations`, {
            handle: guest.handle,
          });
          await guest.request(`/invitations/${invitation.id}/respond`, { decision: 'accept' });
          const { campaignId: guestCampaign } = await guest.request('/game/campaigns', {
            playableVersionId: versionId,
          });
          const requested = await command(guest, guestCampaign, {
            protocolVersion: 1,
            operationId: randomUUID(),
            type: 'npc.request',
            npcId: 'gardener',
          });
          assert.equal(requested.status, 'committed');
          await a.request(
            `/studio/adventures/${story.id}/invitations/${invitation.id}`,
            {},
            'DELETE',
          );
          const renewed = await a.request(`/studio/adventures/${story.id}/invitations`, {
            handle: guest.handle,
          });
          await guest.request(`/invitations/${renewed.id}/respond`, { decision: 'accept' });
          await snapshot(guest, guestCampaign);
          await delay(700);
          const jobs = (
            await db.query('SELECT status FROM game_npc_jobs WHERE campaign_id=$1', [guestCampaign])
          ).rows;
          assert.equal(jobs.length, 1);
          assert.equal(jobs[0].status, 'cancelled');
          const saved = (
            await db.query('SELECT state FROM game_campaigns WHERE id=$1', [guestCampaign])
          ).rows[0].state;
          assert.equal(saved.entities['authored-token'].ownerId, 'gardener');
          assert.equal(saved.npcBrains.gardener.plan.length, 0);
          const exports = await exportGameData(db, a.user.id);
          assert.ok(
            !JSON.stringify(exports).includes(guestCampaign),
            'author is not entitled to another player request metadata through account export',
          );
        },
      );
      await t.test(
        'NPC request export omits proposals and confirmed source erasure deletes durable jobs',
        async () => {
          await stopApi();
          const c = await db.connect();
          try {
            await c.query('BEGIN');
            const jobs = (await c.query('SELECT id FROM game_npc_jobs WHERE campaign_id=$1', [id]))
              .rows;
            assert.ok(jobs.length >= 1);
            const exported = (await exportGameData(c, a.user.id)).find((entry) => entry.id === id);
            assert.ok(exported.npcRequests.length >= 1);
            for (const request of exported.npcRequests) {
              assert.equal(request.proposal, undefined);
              assert.equal(request.requester_actor_id, undefined);
            }
            assert.ok(!JSON.stringify(exported).includes('PRIVATE_PLAN_SOURCE_SECRET'));
            await c.query("SELECT set_config('dreamwalk.erasure','confirmed',true)");
            await c.query('UPDATE users SET deleted_at=now() WHERE id=$1', [a.user.id]);
            await purgeGameData(c, a.user.id);
            assert.deepEqual(
              (await c.query('SELECT runtime_clock FROM game_campaigns WHERE id=$1', [id])).rows[0]
                .runtime_clock,
              {},
            );
            assert.equal(
              (await c.query('SELECT id FROM game_npc_jobs WHERE campaign_id=$1', [id])).rowCount,
              0,
            );
          } finally {
            await c.query('ROLLBACK');
            c.release();
          }
        },
      );
    } finally {
      await stopApi();
      await db.end();
    }
  },
);
