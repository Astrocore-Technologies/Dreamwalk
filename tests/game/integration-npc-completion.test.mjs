/** End-to-end completion boundaries: normal dialogue, OOC, moderator sandbox and confirmed intents. */
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
  actor,
  path,
  command,
  operation,
  moveTo,
  until,
  connect,
} from './support-runtime.mjs';
import { authoredDraft, storyInput } from './support-authored.mjs';
import { purgeGameData, exportGameData } from '../../scripts/game-data-requests.mjs';
const state = async (id) =>
  (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id])).rows[0].state;
async function fixture(owner, change = () => {}, visibility = 'private') {
  const story = await owner.request('/studio/adventures', storyInput(visibility)),
    draft = authoredDraft();
  draft.npcBehavior = 'reactive-v1';
  draft.npcs[0].x = 4;
  draft.npcs[0].y = 2;
  draft.npcs[0].goal = 'patrol';
  draft.npcs[0].patrolTarget = { x: 4, y: 2 };
  draft.objects[1].x = 4;
  draft.objects[1].y = 2;
  draft.npcs[0].personality = {
    role: 'guard',
    values: ['duty'],
    taboos: ['disclose_private'],
    speechStyle: 'SECRET_STYLE',
    publicSpeechStyle: 'formal',
  };
  draft.npcs[0].initialFacts = [
    {
      id: 'code',
      title: 'SECRET_INTERNAL_TITLE',
      text: 'PERMITTED_PASS_472',
      disclosure: 'asked',
      publicQuestion: 'What is the pass?',
    },
    { id: 'sealed', title: 'HIDDEN_NEVER_TITLE', text: 'NEVER_PASS_917', disclosure: 'never' },
  ];
  change(draft);
  await owner.request(
    `/studio/adventures/${story.id}/playable-draft`,
    { expectedRevision: 0, draft },
    'PUT',
  );
  if (visibility === 'public') return { story, draft };
  const { versionId } = await owner.request(`/studio/adventures/${story.id}/playable-versions`, {
    expectedRevision: 1,
  });
  const { campaignId } = await owner.request('/game/campaigns', { playableVersionId: versionId });
  return { story, draft, campaignId, versionId };
}
async function join(owner, guest, f) {
  const inv = await owner.request(`/studio/adventures/${f.story.id}/invitations`, {
    handle: guest.handle,
  });
  await guest.request(`/invitations/${inv.id}/respond`, { decision: 'accept' });
  await owner.request(path(f.campaignId, 'invitations'), { username: guest.handle });
  await guest.request(path(f.campaignId, 'accept'), {});
  return inv;
}
await test(
  'completed living-world channels preserve authority and isolation',
  { timeout: 120000 },
  async (t) => {
    try {
      await startApi();
      const owner = await client().register(),
        guest = await client().register(),
        outsider = await client().register();
      const f = await fixture(owner),
        id = f.campaignId;
      await join(owner, guest, f);
      await moveTo(owner, id, { x: 3, y: 2 });
      const socket = await connect(owner, id);
      await t.test(
        'ordinary dialogue automatically queues a free grounded answer without separate AI action',
        async () => {
          const p = (await snapshot(owner, id)).projection,
            topic = p.npcFactTopics.find((x) => x.npcId === 'gardener');
          assert.ok(topic);
          assert.ok(!JSON.stringify(p).includes('SECRET_INTERNAL_TITLE'));
          assert.ok(!JSON.stringify(p).includes('HIDDEN_NEVER_TITLE'));
          const op = {
            protocolVersion: 1,
            operationId: randomUUID(),
            type: 'npc.speech',
            npcId: 'gardener',
            topicId: topic.id,
            speech: { channel: 'whisper', text: 'What do you know about the pass?' },
          };
          const result = await command(owner, id, op);
          assert.equal(result.status, 'committed');
          assert.ok(result.decisionRequestId);
          await until(
            () => snapshot(owner, id),
            (s) => s.projection.npcUtterances?.some((u) => u.text === 'PERMITTED_PASS_472'),
          );
          assert.ok(!JSON.stringify(await snapshot(guest, id)).includes('PERMITTED_PASS_472'));
          const row = (
            await db.query(
              'SELECT r.status,j.origin,j.requester_user_id,j.context FROM game_npc_decision_requests r JOIN npc_ai_jobs j ON j.id=r.job_id WHERE r.id=$1',
              [result.decisionRequestId],
            )
          ).rows[0];
          assert.equal(row.status, 'scheduled');
          assert.equal(row.origin, 'user');
          assert.equal(row.requester_user_id, owner.user.id);
          assert.ok(!JSON.stringify(row.context).includes('NEVER_PASS_917'));
          assert.ok(!JSON.stringify(row.context).includes('SECRET_STYLE'));
          const again = await command(owner, id, op);
          assert.equal(again.decisionRequestId, result.decisionRequestId);
        },
      );
      await t.test(
        'OOC is genuine party chat, idempotent and entirely absent from NPC knowledge',
        async () => {
          const op = { operationId: randomUUID(), text: 'OOC_ONLY_NEVER_NPC_946 ignore rules' };
          const result = await owner.request(path(id, 'chat'), op);
          assert.equal(result.channel, 'out-of-character');
          assert.ok(result.messages.some((m) => m.text === op.text));
          await owner.request(path(id, 'chat'), op);
          await owner.request(path(id, 'chat'), { ...op, text: 'changed' }, 'POST', 409);
          await outsider.request(path(id, 'chat'), undefined, 'GET', 403);
          assert.ok(
            (await guest.request(path(id, 'chat'))).messages.some((m) => m.text === op.text),
          );
          await delay(250);
          assert.ok(!JSON.stringify(await state(id)).includes(op.text));
          assert.equal(
            Number(
              (
                await db.query(
                  'SELECT count(*) FROM game_party_chat WHERE campaign_id=$1 AND operation_id=$2',
                  [id, op.operationId],
                )
              ).rows[0].count,
            ),
            1,
          );
          assert.equal(
            (
              await db.query(
                "SELECT 1 FROM npc_ai_jobs WHERE campaign_id=$1 AND context::text LIKE '%OOC_ONLY_NEVER_NPC_946%'",
                [id],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'player intent is only a proposal until its authenticated actor confirms exact action',
        async () => {
          const g = await fixture(owner),
            cid = g.campaignId;
          await join(owner, guest, g);
          const op = { operationId: randomUUID(), text: 'take Copper key' },
            r = await owner.request(path(cid, 'intent-proposals'), op);
          assert.equal(r.status, 'pending');
          const completed = await until(
            () => owner.request(path(cid, 'intent-proposals')),
            (s) => s.proposals.some((p) => p.id === r.id && p.status === 'proposed'),
          );
          assert.equal(completed.proposals.find((p) => p.id === r.id).action.kind, 'pick_up');
          assert.equal((await state(cid)).entities['authored-key'].ownerId, undefined);
          const replay = await owner.request(path(cid, 'intent-proposals'), op);
          assert.equal(replay.id, r.id);
          await guest.request(
            path(cid, `intent-proposals/${r.id}/confirm`),
            { operationId: randomUUID() },
            'POST',
            404,
          );
          const confirm = { operationId: randomUUID() },
            done = await owner.request(path(cid, `intent-proposals/${r.id}/confirm`), confirm);
          assert.equal(done.status, 'committed');
          assert.deepEqual(
            await owner.request(path(cid, `intent-proposals/${r.id}/confirm`), confirm),
            done,
          );
          const me = actor(await snapshot(owner, cid)).id;
          assert.equal((await state(cid)).entities['authored-key'].ownerId, me);
          const job = (
            await db.query(
              "SELECT context,subject_kind,requester_user_id FROM npc_ai_jobs WHERE campaign_id=$1 AND purpose='intent'",
              [cid],
            )
          ).rows[0];
          assert.equal(job.subject_kind, 'player');
          assert.equal(job.requester_user_id, owner.user.id);
          assert.ok(!JSON.stringify(job.context).includes('npcBrains'));
          assert.ok(!JSON.stringify(job.context).includes('NEVER_PASS_917'));
        },
      );
      await t.test(
        'ambiguous intent asks for clarification and stale confirmed readsets are rejected',
        async () => {
          const g = await fixture(owner),
            cid = g.campaignId;
          const unknown = await owner.request(path(cid, 'intent-proposals'), {
            operationId: randomUUID(),
            text: 'do something impossible',
          });
          await until(
            () => owner.request(path(cid, 'intent-proposals')),
            (s) => s.proposals.some((p) => p.id === unknown.id && p.status === 'clarification'),
          );
          const wait = await owner.request(path(cid, 'intent-proposals'), {
            operationId: randomUUID(),
            text: 'wait',
          });
          await until(
            () => owner.request(path(cid, 'intent-proposals')),
            (s) => s.proposals.some((p) => p.id === wait.id && p.status === 'proposed'),
          );
          await moveTo(owner, cid, { x: 2, y: 3 });
          const result = await owner.request(path(cid, `intent-proposals/${wait.id}/confirm`), {
            operationId: randomUUID(),
          });
          assert.equal(result.status, 'rejected');
          assert.equal(result.code, 'STALE_STATE');
        },
      );
      await t.test(
        'conditional promise requires the addressed recipient acceptance before owned item transfer',
        async () => {
          const g = await fixture(owner, (d) => {
              d.npcs[0].personality.role = 'helper';
              d.npcs[0].promiseTemplates = [
                {
                  id: 'gift',
                  itemId: 'authored-token',
                  offerOn: 'addressed',
                  conditions: [{ kind: 'recipient_near' }],
                  dueTicks: 600,
                  requiresAcceptance: true,
                },
              ];
            }),
            cid = g.campaignId;
          await join(owner, guest, g);
          await moveTo(owner, cid, { x: 3, y: 2 });
          await command(owner, cid, {
            protocolVersion: 1,
            operationId: randomUUID(),
            type: 'npc.speech',
            npcId: 'gardener',
            speech: { channel: 'whisper', text: 'Can you help?' },
          });
          const pending = await until(
            () => state(cid),
            (s) => s.npcBrains.gardener.living.obligations.some((o) => o.status === 'proposed'),
          );
          const promise = pending.npcBrains.gardener.living.obligations.find(
            (o) => o.status === 'proposed',
          );
          assert.equal(pending.entities['authored-token'].ownerId, 'gardener');
          const denied = await command(guest, cid, {
            protocolVersion: 1,
            operationId: randomUUID(),
            type: 'npc.promise',
            npcId: 'gardener',
            promiseId: promise.id,
            decision: 'accept',
          });
          assert.equal(denied.status, 'rejected');
          const accepted = await command(owner, cid, {
            protocolVersion: 1,
            operationId: randomUUID(),
            type: 'npc.promise',
            npcId: 'gardener',
            promiseId: promise.id,
            decision: 'accept',
          });
          assert.equal(accepted.status, 'committed');
          await until(
            () => state(cid),
            (s) =>
              s.npcBrains.gardener.living.obligations.some(
                (o) => o.id === promise.id && o.status === 'fulfilled',
              ),
          );
        },
      );
      await t.test(
        'invalid provider intent becomes terminal instead of polling forever or occupying quota',
        async () => {
          const g = await fixture(owner),
            cid = g.campaignId;
          const blocker = await db.connect();
          await blocker.query('SELECT pg_advisory_lock(hashtext($1))', [`npc-ai:${cid}`]);
          let proposed;
          try {
            proposed = await owner.request(path(cid, 'intent-proposals'), {
              operationId: randomUUID(),
              text: 'wait',
            });
            await stopApi('SIGKILL');
            await db.query(
              `UPDATE game_npc_decision_requests SET context=jsonb_set(context,'{mockProposal}','{"kind":"invalid"}'::jsonb) WHERE id=(SELECT decision_request_id FROM game_player_intent_proposals WHERE id=$1)`,
              [proposed.id],
            );
          } finally {
            await blocker.query('SELECT pg_advisory_unlock(hashtext($1))', [`npc-ai:${cid}`]);
            blocker.release();
          }
          await startApi();
          const terminal = await until(
            () => owner.request(path(cid, 'intent-proposals')),
            (r) => r.proposals.find((p) => p.id === proposed.id)?.status === 'cancelled',
          );
          assert.equal(
            terminal.proposals.find((p) => p.id === proposed.id).code,
            'DECISION_UNAVAILABLE',
          );
          assert.equal(
            Number(
              (
                await db.query(
                  "SELECT count(*) FROM game_player_intent_proposals WHERE campaign_id=$1 AND status='pending'",
                  [cid],
                )
              ).rows[0].count,
            ),
            0,
          );
        },
      );
      await t.test(
        'non-item inspect promise is offered, accepted and fulfilled by a real action',
        async () => {
          const g = await fixture(owner, (d) => {
            d.npcs[0].promiseTemplates = [
              {
                id: 'inspection',
                promisedAction: { kind: 'inspect', targetId: 'authored-key' },
                offerOn: 'addressed',
                conditions: [{ kind: 'recipient_near' }],
                dueTicks: 600,
                requiresAcceptance: true,
              },
            ];
          });
          const cid = g.campaignId;
          await moveTo(owner, cid, { x: 3, y: 2 });
          await command(owner, cid, {
            protocolVersion: 1,
            operationId: randomUUID(),
            type: 'npc.speech',
            npcId: 'gardener',
            speech: { channel: 'whisper', text: 'Please inspect the key.' },
          });
          const pending = await until(
            () => state(cid),
            (s) => s.npcBrains.gardener.living.obligations.some((o) => o.status === 'proposed'),
          );
          const promise = pending.npcBrains.gardener.living.obligations.find(
            (o) => o.status === 'proposed',
          );
          assert.deepEqual(promise.promisedAction, { kind: 'inspect', targetId: 'authored-key' });
          assert.equal(promise.itemId, undefined);
          const accepted = await command(owner, cid, {
            protocolVersion: 1,
            operationId: randomUUID(),
            type: 'npc.promise',
            npcId: 'gardener',
            promiseId: promise.id,
            decision: 'accept',
          });
          assert.equal(accepted.status, 'committed');
          await until(
            () => state(cid),
            (s) =>
              s.npcBrains.gardener.living.obligations.some(
                (o) => o.id === promise.id && o.status === 'fulfilled',
              ),
          );
        },
      );
      await t.test('moderator sandbox uses only exact pending immutable submission', async () => {
        const g = await fixture(owner, () => {}, 'public');
        await owner.request(`/studio/adventures/${g.story.id}/submit`, {});
        await db.query("UPDATE users SET role='admin' WHERE id=$1", [outsider.user.id]);
        const review = await outsider.request(`/admin/adventures/${g.story.id}/playable-review`),
          body = { versionId: review.versionId, npcId: 'gardener', ticks: 20 };
        const route = `/admin/adventures/${g.story.id}/npc-preview`;
        await owner.request(route, body, 'POST', 404);
        const p = await outsider.request(route, body);
        assert.equal(p.review, true);
        assert.equal(p.versionId, review.versionId);
        assert.ok(p.brain.living.observations.some((o) => o.definitionText === 'NEVER_PASS_917'));
        await outsider.request(route, { ...body, versionId: randomUUID() }, 'POST', 404);
        const changed = structuredClone(g.draft);
        changed.maps[0].label = 'New draft';
        await owner.request(
          `/studio/adventures/${g.story.id}/playable-draft`,
          { expectedRevision: 1, draft: changed },
          'PUT',
        );
        await outsider.request(route, body, 'POST', 404);
      });
      await t.test(
        'only campaign owner can explicitly grant/revoke bounded sponsorship',
        async () => {
          const body = {
            operationId: randomUUID(),
            consent: true,
            totalCredits: 0,
            perOperationCredits: 0,
            maxOperations: 3,
            totalProviderMicros: 0,
            perOperationProviderMicros: 0,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            purposes: ['speech', 'plan', 'intent'],
          };
          await guest.request(path(id, 'ai/sponsors'), body, 'POST', 403);
          await owner.request(path(id, 'ai/sponsors'), { ...body, consent: false }, 'POST', 400);
          const grant = await owner.request(path(id, 'ai/sponsors'), body);
          assert.ok(grant.sponsors.length);
          const sid = grant.sponsors[0].id;
          await owner.request(path(id, `ai/sponsors/${sid}`), {}, 'DELETE');
          assert.ok(
            !(await owner.request(path(id, 'ai/sponsors'))).sponsors.some(
              (s) => s.id === sid && s.status === 'active',
            ),
          );
        },
      );
      await t.test(
        'significant observed event schedules one actorless system decision, not tick-based calls',
        async () => {
          const g = await fixture(owner),
            cid = g.campaignId;
          await command(owner, cid, operation({ kind: 'pick_up', targetId: 'authored-key' }));
          await until(
            () =>
              db.query(
                "SELECT r.*,j.origin,j.requester_user_id FROM game_npc_decision_requests r JOIN npc_ai_jobs j ON j.id=r.job_id WHERE r.campaign_id=$1 AND r.purpose='plan'",
                [cid],
              ),
            (r) => r.rows.length > 0,
          );
          const rows = (
            await db.query(
              "SELECT r.cause_key,j.origin,j.requester_user_id FROM game_npc_decision_requests r JOIN npc_ai_jobs j ON j.id=r.job_id WHERE r.campaign_id=$1 AND r.purpose='plan'",
              [cid],
            )
          ).rows;
          assert.ok(rows.every((r) => r.origin === 'system' && r.requester_user_id === null));
          assert.equal(new Set(rows.map((r) => r.cause_key)).size, rows.length);
          await delay(300);
          assert.ok(
            Number(
              (
                await db.query(
                  "SELECT count(*) FROM game_npc_decision_requests WHERE campaign_id=$1 AND purpose='plan'",
                  [cid],
                )
              ).rows[0].count,
            ) <= 3,
          );
        },
      );
      await t.test(
        'explicit sponsor attempt cap causes free local fallback without extra provider job',
        async () => {
          const g = await fixture(owner),
            cid = g.campaignId;
          await moveTo(owner, cid, { x: 3, y: 2 });
          await owner.request(path(cid, 'ai/sponsors'), {
            operationId: randomUUID(),
            consent: true,
            totalCredits: 0,
            perOperationCredits: 0,
            maxOperations: 1,
            totalProviderMicros: 0,
            perOperationProviderMicros: 0,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            purposes: ['speech'],
          });
          const topic = (await snapshot(owner, cid)).projection.npcFactTopics[0].id;
          const talk = () =>
            command(owner, cid, {
              protocolVersion: 1,
              operationId: randomUUID(),
              type: 'npc.speech',
              npcId: 'gardener',
              topicId: topic,
              speech: { channel: 'whisper', text: 'Tell me the pass' },
            });
          const first = await talk();
          await until(
            () =>
              db.query('SELECT status FROM game_npc_decision_requests WHERE id=$1', [
                first.decisionRequestId,
              ]),
            (r) => r.rows[0].status === 'scheduled',
          );
          await until(
            () => db.query('SELECT status FROM npc_ai_jobs WHERE campaign_id=$1', [cid]),
            (r) => r.rows.some((j) => j.status === 'committed'),
          );
          const second = await talk();
          await until(
            () =>
              db.query('SELECT status FROM game_npc_decision_requests WHERE id=$1', [
                second.decisionRequestId,
              ]),
            (r) => r.rows[0].status === 'fallback',
          );
          const jobs = (
            await db.query(
              'SELECT origin,payer_user_id,requester_user_id FROM npc_ai_jobs WHERE campaign_id=$1',
              [cid],
            )
          ).rows;
          assert.equal(jobs.length, 1);
          assert.equal(jobs[0].origin, 'system');
          assert.equal(jobs[0].payer_user_id, owner.user.id);
          assert.equal(jobs[0].requester_user_id, null);
        },
      );
      await t.test(
        'durable ordinary dialogue survives crash before provider queue and responds once',
        async () => {
          const g = await fixture(owner),
            cid = g.campaignId;
          await moveTo(owner, cid, { x: 3, y: 2 });
          const topic = (await snapshot(owner, cid)).projection.npcFactTopics[0].id;
          const lock = await db.connect();
          await lock.query('BEGIN');
          await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            `npc-ai:${cid}`,
          ]);
          let req;
          try {
            req = await command(owner, cid, {
              protocolVersion: 1,
              operationId: randomUUID(),
              type: 'npc.speech',
              npcId: 'gardener',
              topicId: topic,
              speech: { channel: 'whisper', text: 'Recover this answer' },
            });
            await stopApi('SIGKILL');
          } finally {
            await lock.query('ROLLBACK');
            lock.release();
          }
          await startApi();
          await snapshot(owner, cid);
          await until(
            () => snapshot(owner, cid),
            (s) => s.projection.npcUtterances?.some((u) => u.text === 'PERMITTED_PASS_472'),
          );
          assert.equal(
            Number(
              (
                await db.query('SELECT count(*) FROM npc_ai_jobs WHERE operation_id=$1', [
                  req.decisionRequestId,
                ])
              ).rows[0].count,
            ),
            1,
          );
        },
      );
      await t.test(
        'source revoke and regrant cannot resurrect a persisted pre-revoke dialogue request',
        async () => {
          const g = await fixture(owner),
            cid = g.campaignId,
            inv = await join(owner, guest, g);
          await moveTo(guest, cid, { x: 3, y: 2 });
          const topic = (await snapshot(guest, cid)).projection.npcFactTopics[0].id;
          const lock = await db.connect();
          await lock.query('BEGIN');
          await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            `npc-ai:${cid}`,
          ]);
          let req;
          try {
            req = await command(guest, cid, {
              protocolVersion: 1,
              operationId: randomUUID(),
              type: 'npc.speech',
              npcId: 'gardener',
              topicId: topic,
              speech: { channel: 'whisper', text: 'Do not resurrect this request' },
            });
            await stopApi('SIGKILL');
          } finally {
            await lock.query('ROLLBACK');
            lock.release();
          }
          await startApi();
          await owner.request(
            `/studio/adventures/${g.story.id}/invitations/${inv.id}`,
            {},
            'DELETE',
          );
          const again = await owner.request(`/studio/adventures/${g.story.id}/invitations`, {
            handle: guest.handle,
          });
          await guest.request(`/invitations/${again.id}/respond`, { decision: 'accept' });
          await snapshot(guest, cid);
          await delay(400);
          const row = (
            await db.query('SELECT status,context FROM game_npc_decision_requests WHERE id=$1', [
              req.decisionRequestId,
            ])
          ).rows[0];
          assert.equal(row.status, 'cancelled');
          assert.deepEqual(row.context, {});
          assert.equal(
            (
              await db.query('SELECT 1 FROM npc_ai_jobs WHERE operation_id=$1', [
                req.decisionRequestId,
              ])
            ).rowCount,
            0,
          );
          assert.ok(
            !(await snapshot(guest, cid)).projection.npcUtterances.some(
              (u) => u.text === 'PERMITTED_PASS_472',
            ),
          );
        },
      );
      await t.test(
        'account export/purge isolates OOC and pending decisions from other party private data',
        async () => {
          const text = 'GUEST_OOC_ERASE_644';
          await guest.request(path(id, 'chat'), { operationId: randomUUID(), text });
          const c = await db.connect();
          await c.query('BEGIN');
          try {
            const exported = await exportGameData(c, guest.user.id);
            assert.ok(JSON.stringify(exported).includes(text));
            assert.ok(!JSON.stringify(exported).includes('OOC_ONLY_NEVER_NPC_946'));
            assert.ok(!JSON.stringify(exported).includes('contextHash'));
            await c.query("SELECT set_config('dreamwalk.erasure','confirmed',true)");
            await c.query('UPDATE users SET deleted_at=now() WHERE id=$1', [guest.user.id]);
            await purgeGameData(c, guest.user.id);
            assert.equal(
              (
                await c.query('SELECT 1 FROM game_party_chat WHERE sender_user_id=$1', [
                  guest.user.id,
                ])
              ).rowCount,
              0,
            );
            assert.ok(
              (
                await c.query('SELECT 1 FROM game_party_chat WHERE sender_user_id=$1', [
                  owner.user.id,
                ])
              ).rowCount > 0,
            );
          } finally {
            await c.query('ROLLBACK');
            c.release();
          }
        },
      );
      socket.ws.terminate();
    } finally {
      await stopApi();
      await db.end();
    }
  },
);
