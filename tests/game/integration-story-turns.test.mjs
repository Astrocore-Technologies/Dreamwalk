/** Unified turns through real authentication, PostgreSQL and delayed local-only provider jobs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { storyInput } from './support-authored.mjs';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client, until } from './support-runtime.mjs';
import { exportStoryTurnData } from '../../scripts/story-turn-data-requests.mjs';
import { purgeGameData } from '../../scripts/game-data-requests.mjs';
const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db.js');
const { Auth } = require('../../apps/api/dist/auth.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const { PlayableService } = require('../../apps/api/dist/game/playable.service.js');
const { GameService } = require('../../apps/api/dist/game/game.service.js');
const { GameController } = require('../../apps/api/dist/game/game.controller.js');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
const { InvitationsController } = require('../../apps/api/dist/invitations.js');
const { Content } = require('../../apps/api/dist/content.js');
const {
  applyNpcSpeech,
  createCompleteObservatoryDraft,
} = require('../../packages/game-core/dist/index.js');
const database = new Db();
const turn = async (id) =>
  (await db.query('SELECT * FROM game_story_turns WHERE id=$1', [id])).rows[0];
const job = async (id) => (await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [id])).rows[0];
const errorCode = (code) => (error) => error?.getResponse?.().code === code;
await test(
  'one unified player turn preserves ordered mechanics, privacy and once-only generation',
  { timeout: 180000 },
  async (t) => {
    let game;
    try {
      await startApi();
      const owner = await client().register(),
        guest = await client().register(),
        outsider = await client().register();
      const source = await owner.request('/adventures/old-observatory?view=published');
      const ids = [];
      for (let i = 0; i < 14; i++) {
        const { campaignId } = await owner.request('/game/campaigns', {
          playableVersionId: source.playableVersionId,
        });
        await owner.request(`/game/campaigns/${campaignId}/invitations`, {
          username: guest.handle,
        });
        await guest.request(`/game/campaigns/${campaignId}/accept`, {});
        ids.push(campaignId);
      }
      const privateStory = await owner.request('/studio/adventures', storyInput('private'));
      await owner.request(
        `/studio/adventures/${privateStory.id}/playable-draft`,
        { expectedRevision: 0, draft: createCompleteObservatoryDraft() },
        'PUT',
      );
      const version = await owner.request(
        `/studio/adventures/${privateStory.id}/playable-versions`,
        { expectedRevision: 1 },
      );
      const sourceInvite = await owner.request(
        `/studio/adventures/${privateStory.id}/invitations`,
        { handle: guest.handle },
      );
      await guest.request(`/invitations/${sourceInvite.id}/respond`, { decision: 'accept' });
      const privateCampaign = await owner.request('/game/campaigns', {
        playableVersionId: version.versionId,
      });
      await owner.request(`/game/campaigns/${privateCampaign.campaignId}/invitations`, {
        username: guest.handle,
      });
      await guest.request(`/game/campaigns/${privateCampaign.campaignId}/accept`, {});
      ids.push(privateCampaign.campaignId);
      await stopApi();
      const pending = new Map();
      let calls = 0;
      const provider = {
        id: `story-fixture-${randomUUID()}`,
        version: 'v1',
        external: false,
        generate: (request) => {
          calls++;
          return new Promise((resolve) => pending.set(request.jobId, { request, resolve }));
        },
      };
      const ai = new NpcAiEngine(database, provider, { timeoutMs: 20000 });
      const auth = new Auth(database),
        art = new AssetReuseService(database);
      let controller;
      function instantiate() {
        game = new GameService(database, auth, new PlayableService(database, auth, art), ai, art);
        clearInterval(game.timer);
        controller = new GameController(game);
      }
      instantiate();
      const req = { headers: { cookie: owner.cookie } },
        other = { headers: { cookie: guest.cookie } },
        foreign = { headers: { cookie: outsider.cookie } };
      const actor = `player-${owner.user.id}`,
        otherActor = `player-${guest.user.id}`;
      async function prepare(id) {
        await controller.snapshot(req, id);
        const live = game.live.get(id);
        Object.assign(live.state.entities[actor], { x: 5, y: 4 });
        Object.assign(live.state.entities[otherActor], { x: 6, y: 5 });
        Object.assign(live.state.entities.key, { x: 5, y: 5 });
        for (const brain of Object.values(live.state.npcBrains)) {
          brain.plan = [];
          brain.cursor = 0;
          brain.nextDecisionTick = 999999;
        }
        await game.persist(id, live, live.state, 'test.story.fixture');
        return live;
      }
      const input = (id, text = '*inspect key* Hello', extra = {}) => ({
        operationId: randomUUID(),
        text,
        channel: 'say',
        targetNpcId: 'keeper',
        expectedCanonRevision: game.live.get(id).state.narrativeCanon?.revision ?? 0,
        ...extra,
      });
      async function quoted(id, body, user = req) {
        const quote = await controller.storyQuote(user, id, body);
        assert.equal(quote.status, 'quoted');
        return { body, quote };
      }
      async function queued(id, q, user = req, preconfirm = true) {
        const body = {
          ...q.body,
          turnId: q.quote.turnId,
          quoteId: q.quote.quote.id,
          consent: true,
          ...(preconfirm && q.quote.actionPreview.length
            ? { confirmedActionHash: q.quote.confirmationHash }
            : {}),
        };
        const receipt = await controller.storySubmit(user, id, body);
        assert.equal(receipt.status, 'queued');
        await game.processDecisionRequests(id, game.live.get(id));
        const r = await until(
          async () =>
            (
              await db.query('SELECT job_id FROM game_npc_decision_requests WHERE id=$1', [
                receipt.id,
              ])
            ).rows[0],
          (r) => !!r?.job_id,
        );
        await until(async () => pending.has(r.job_id), Boolean);
        return { ...q, submit: body, id: receipt.id, jobId: r.job_id, p: pending.get(r.job_id) };
      }
      async function received(q, proposal = q.p.request.context.mockProposal) {
        q.p.resolve({
          proposal,
          requestId: `fixture-${q.jobId}`,
          usage: { inputTokens: 1, outputTokens: 1, costMicros: 0 },
        });
        await until(
          () => job(q.jobId),
          (r) => r.status === 'result_received',
        );
      }
      async function complete(id, q, proposal) {
        await received(q, proposal);
        await game.processAi(id, game.live.get(id));
        return turn(q.id);
      }
      const feed = (id, user = req) => controller.storyFeed(user, id);
      async function interpreted(id) {
        const q = await queued(id, await quoted(id, input(id, '*consider the key* Hello')));
        const proposal = structuredClone(q.p.request.context.mockProposal);
        proposal.status = 'ready';
        proposal.code = null;
        proposal.narrative = null;
        proposal.steps = [
          { segmentIndex: 0, action: { kind: 'inspect', targetId: 'key' }, reply: null },
          { segmentIndex: 1, action: null, reply: { text: 'We can inspect the key.' } },
        ];
        const r = await complete(id, q, proposal);
        assert.equal(r.status, 'awaiting_confirmation');
        return { ...q, proposalHash: r.proposal_hash };
      }
      await t.test(
        'same quote and concurrent submit produce one job, ordered outcome before speech, replay once',
        async () => {
          const id = ids[0];
          await prepare(id);
          const q = await quoted(id, input(id));
          assert.deepEqual(await controller.storyQuote(req, id, q.body), q.quote);
          assert.equal((await feed(id, other)).turns.length, 0);
          const run = await queued(id, q);
          const results = await Promise.all([
            controller.storySubmit(req, id, run.submit),
            controller.storySubmit(req, id, run.submit),
          ]);
          assert.ok(results.every((r) => r.id === run.id));
          const context = run.p.request.context;
          assert.deepEqual(
            context.segments.map((s) => s.kind),
            ['attempt', 'speech'],
          );
          assert.ok(
            context.actionOutcomes?.length,
            'provider must receive authoritative attempt outcome',
          );
          assert.equal((await complete(id, run)).status, 'committed');
          const mine = await feed(id),
            theirs = await feed(id, other);
          assert.deepEqual(
            mine.entries.filter((e) => e.turnId === run.id).map((e) => e.kind),
            ['attempt', 'outcome', 'speech', 'npc_reply'],
          );
          assert.equal(theirs.turns.length, 0);
          assert.ok(theirs.entries.some((e) => e.turnId === run.id));
          assert.equal((await controller.storySubmit(req, id, run.submit)).status, 'committed');
          assert.equal(
            (await db.query('SELECT count(*)::int n FROM npc_ai_jobs WHERE campaign_id=$1', [id]))
              .rows[0].n,
            1,
          );
          assert.equal(
            (
              await db.query('SELECT count(*)::int n FROM game_story_feed WHERE turn_id=$1', [
                run.id,
              ])
            ).rows[0].n,
            4,
          );
        },
      );
      await t.test(
        'whisper input, replies and pending proposal never reach another member or outsider',
        async () => {
          const id = ids[1];
          await prepare(id);
          const q = await queued(
            id,
            await quoted(id, input(id, '*wait* PRIVATE_UNIFIED_CANARY', { channel: 'whisper' })),
          );
          assert.ok(!JSON.stringify(await feed(id, other)).includes('PRIVATE_UNIFIED_CANARY'));
          await assert.rejects(() => feed(id, foreign));
          const proposal = structuredClone(q.p.request.context.mockProposal);
          proposal.steps[1].reply = { text: 'PRIVATE_REPLY_CANARY' };
          assert.equal((await complete(id, q, proposal)).status, 'committed');
          const visible = JSON.stringify(await feed(id, other));
          assert.ok(!visible.includes('PRIVATE_UNIFIED_CANARY'));
          assert.ok(!visible.includes('PRIVATE_REPLY_CANARY'));
          assert.ok(JSON.stringify(await feed(id)).includes('PRIVATE_REPLY_CANARY'));
          assert.equal(game.live.get(id).state.narrativeCanon?.revision ?? 0, 0);
        },
      );
      await t.test(
        'unsupported walking and private world extension clarify before creating a job',
        async () => {
          const id = ids[2];
          await prepare(id);
          const before = calls;
          for (const [body, code] of [
            [input(id, '*walk to keeper* Hello'), 'WALK_FIRST'],
            [
              input(id, 'Create a room', { channel: 'whisper', targetNpcId: undefined }),
              'PRIVATE_STORY_EXTENSION',
            ],
          ]) {
            const q = await controller.storyQuote(req, id, body);
            assert.equal(q.status, 'clarification');
            assert.equal(q.code, code);
          }
          assert.equal(calls, before);
          assert.equal(
            (
              await db.query('SELECT count(*)::int n FROM game_story_turns WHERE campaign_id=$1', [
                id,
              ])
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test('OOC stays out of provider, NPC memory and story feed', async () => {
        const id = ids[2],
          before = calls,
          brain = JSON.stringify(game.live.get(id).state.npcBrains);
        await controller.sendChat(req, id, {
          operationId: randomUUID(),
          text: 'OOC_NOT_WORLD_CANARY',
        });
        assert.ok(
          JSON.stringify(await controller.chat(other, id)).includes('OOC_NOT_WORLD_CANARY'),
        );
        assert.equal(calls, before);
        assert.equal(JSON.stringify(game.live.get(id).state.npcBrains), brain);
        assert.ok(!JSON.stringify(await feed(id)).includes('OOC_NOT_WORLD_CANARY'));
      });
      await t.test(
        'provider-interpreted action requires stored confirmation, then commits once without another call',
        async () => {
          const id = ids[3];
          await prepare(id);
          const q = await interpreted(id),
            before = calls;
          assert.equal((await feed(id)).entries.filter((e) => e.turnId === q.id).length, 0);
          await assert.rejects(
            () =>
              controller.storyConfirm(other, id, q.id, {
                operationId: randomUUID(),
                proposalHash: q.proposalHash,
                decision: 'accept',
              }),
            errorCode('NOT_FOUND'),
          );
          const confirm = {
            operationId: randomUUID(),
            proposalHash: q.proposalHash,
            decision: 'accept',
          };
          assert.equal((await controller.storyConfirm(req, id, q.id, confirm)).status, 'committed');
          assert.equal((await controller.storyConfirm(req, id, q.id, confirm)).status, 'committed');
          assert.equal(calls, before);
          assert.equal(
            (await db.query('SELECT count(*)::int n FROM game_story_feed WHERE turn_id=$1', [q.id]))
              .rows[0].n,
            4,
          );
        },
      );
      await t.test(
        'changed target state makes confirmation stale without a second generation',
        async () => {
          const id = ids[4],
            live = await prepare(id),
            q = await interpreted(id),
            before = calls;
          live.state.entities.key.x = 7;
          await game.persist(id, live, live.state, 'test.target.changed');
          assert.equal(
            (
              await controller.storyConfirm(req, id, q.id, {
                operationId: randomUUID(),
                proposalHash: q.proposalHash,
                decision: 'accept',
              })
            ).status,
            'stale',
          );
          assert.equal(calls, before);
          assert.equal((await feed(id)).entries.filter((e) => e.turnId === q.id).length, 0);
        },
      );
      await t.test(
        'a provider cannot extend shared narrative from a targeted private whisper',
        async () => {
          const id = ids[5];
          await prepare(id);
          const q = await queued(
            id,
            await quoted(id, input(id, 'PRIVATE_EXTENSION_CANARY', { channel: 'whisper' })),
          );
          const proposal = structuredClone(q.p.request.context.mockProposal);
          proposal.narrative = {
            narration: 'PRIVATE_EXTENSION_CANARY',
            newScene: null,
            newNpc: null,
            evidenceIds: [],
          };
          assert.equal((await complete(id, q, proposal)).status, 'stale');
          assert.ok(!JSON.stringify(await feed(id, other)).includes('PRIVATE_EXTENSION_CANARY'));
        },
      );
      await t.test(
        'ordinary director turn extends canon and persists public entries without foreign input receipts',
        async () => {
          const id = ids[6];
          await prepare(id);
          const q = await queued(
            id,
            await quoted(id, input(id, 'Explore a connected room', { targetNpcId: undefined })),
          );
          assert.equal((await complete(id, q)).status, 'committed');
          assert.equal(game.live.get(id).state.narrativeCanon.revision, 1);
          const second = await queued(
            id,
            await quoted(
              id,
              input(id, 'Continue the confirmed story', { targetNpcId: undefined }),
              other,
            ),
            other,
          );
          assert.equal((await complete(id, second)).status, 'committed');
          assert.equal(game.live.get(id).state.narrativeCanon.revision, 2);
          assert.equal((await feed(id)).turns.length, 1);
          assert.equal((await feed(id, other)).turns.length, 1);
        },
      );
      await t.test(
        'legacy whispered speech adapts to feed without widening its audience',
        async () => {
          const id = ids[7],
            live = await prepare(id);
          const r = applyNpcSpeech(live.state, actor, 'keeper', {
            channel: 'whisper',
            text: 'LEGACY_PRIVATE_CANARY',
          });
          assert.equal(r.error, undefined);
          await game.persist(id, live, r.state, 'test.legacy.speech');
          assert.ok(JSON.stringify(await feed(id)).includes('LEGACY_PRIVATE_CANARY'));
          assert.ok(!JSON.stringify(await feed(id, other)).includes('LEGACY_PRIVATE_CANARY'));
        },
      );
      await t.test(
        'legacy durable history beyond hot last sixteen remains ordered and excludes pending input',
        async () => {
          const id = ids[7];
          for (let i = 0; i < 19; i++) {
            const oldId = randomUUID(),
              committed = i < 18;
            await db.query(
              "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,requester_user_id,recipient_actor_id,context,status) VALUES($1::uuid,$2,$3,'narrative',$1::uuid::text,$4,$3,'{}',$5)",
              [oldId, id, actor, owner.user.id, committed ? 'committed' : 'queued'],
            );
            await db.query(
              "INSERT INTO game_narrative_turns(id,campaign_id,requester_user_id,actor_id,operation_id,request_hash,expected_canon_revision,input_text,status,consent,result,created_at,committed_at) VALUES($1,$2,$3,$4,$5,'legacy-fixture',0,$6,$7,true,$8,now()+($9 * interval '1 second'),now()+($9 * interval '1 second'))",
              [
                oldId,
                id,
                owner.user.id,
                actor,
                randomUUID(),
                committed ? `LEGACY_INPUT_${i}` : 'LEGACY_PENDING_PRIVATE',
                committed ? 'committed' : 'pending',
                JSON.stringify({ narration: `LEGACY_RESULT_${i}`, tick: i }),
                i,
              ],
            );
          }
          const f = await feed(id, other),
            text = JSON.stringify(f);
          for (let i = 0; i < 18; i++) {
            assert.ok(text.includes(`LEGACY_INPUT_${i}`));
            assert.ok(text.includes(`LEGACY_RESULT_${i}`));
          }
          assert.ok(!text.includes('LEGACY_PENDING_PRIVATE'));
          for (const e of f.entries.filter((e) => e.id.startsWith('legacy-narrative-input:'))) {
            const pair = f.entries.filter((x) => x.turnId === e.turnId);
            assert.deepEqual(
              pair.map((x) => x.kind),
              ['speech', 'narration'],
            );
          }
        },
      );
      await t.test(
        'story transaction waits for user lock before acquiring the campaign lock',
        async () => {
          const id = ids[10];
          await prepare(id);
          const q = await quoted(id, input(id, 'Lock ordering question'));
          const held = await db.connect(),
            probe = await db.connect();
          let request;
          try {
            await held.query('BEGIN');
            await held.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner.user.id]);
            const pid = (await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            const body = {
              ...q.body,
              turnId: q.quote.turnId,
              quoteId: q.quote.quote.id,
              consent: true,
            };
            request = controller.storySubmit(req, id, body);
            await until(
              async () =>
                Number(
                  (
                    await db.query(
                      'SELECT count(*) n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
                      [pid],
                    )
                  ).rows[0].n,
                ),
              (n) => n > 0,
            );
            await probe.query('BEGIN');
            await probe.query('SELECT id FROM game_campaigns WHERE id=$1 FOR UPDATE NOWAIT', [id]);
            await probe.query('ROLLBACK');
            await held.query('ROLLBACK');
            assert.equal((await request).status, 'queued');
            await game.processDecisionRequests(id, game.live.get(id));
            const r = await until(
              async () =>
                (
                  await db.query('SELECT job_id FROM game_npc_decision_requests WHERE id=$1', [
                    q.quote.turnId,
                  ])
                ).rows[0],
              (r) => !!r?.job_id,
            );
            await until(async () => pending.has(r.job_id), Boolean);
            assert.equal(
              (
                await complete(id, {
                  id: q.quote.turnId,
                  jobId: r.job_id,
                  p: pending.get(r.job_id),
                })
              ).status,
              'committed',
            );
          } finally {
            await held.query('ROLLBACK');
            await probe.query('ROLLBACK');
            if (request) await request.catch(() => {});
            held.release();
            probe.release();
          }
        },
      );
      await t.test(
        'changed provider contract invalidates quoted consent before dispatch',
        async () => {
          const id = ids[11];
          await prepare(id);
          const q = await quoted(id, input(id, 'Provider version question')),
            before = calls;
          const body = {
            ...q.body,
            turnId: q.quote.turnId,
            quoteId: q.quote.quote.id,
            consent: true,
          };
          provider.version = 'v2';
          try {
            await controller.storySubmit(req, id, body);
            await game.processDecisionRequests(id, game.live.get(id));
            assert.equal((await turn(q.quote.turnId)).status, 'stale');
            assert.equal(calls, before);
          } finally {
            provider.version = 'v1';
          }
        },
      );
      await t.test(
        'failed inferred action clarifies atomically; known failed attempt is an explicit outcome, never success',
        async () => {
          const id = ids[12],
            live = await prepare(id);
          Object.assign(live.state.entities[actor], { x: 9, y: 5 });
          Object.assign(live.state.entities.keeper, { x: 9, y: 4 });
          await game.persist(id, live, live.state, 'test.locked.door');
          const q = await queued(id, await quoted(id, input(id, '*make a way* Hello')));
          const p = structuredClone(q.p.request.context.mockProposal);
          p.status = 'ready';
          p.code = null;
          p.narrative = null;
          p.steps = [
            { segmentIndex: 0, action: { kind: 'open', targetId: 'door' }, reply: null },
            { segmentIndex: 1, action: null, reply: { text: 'The door is open now.' } },
          ];
          assert.equal((await complete(id, q, p)).status, 'clarification');
          assert.equal(live.state.entities.door.locked, true);
          const clarification = (await feed(id)).entries.filter((e) => e.turnId === q.id);
          assert.deepEqual(
            clarification.map((e) => e.kind),
            ['outcome'],
          );
          assert.ok(clarification.every((e) => !e.text && e.code === 'UNSUPPORTED'));
          const known = await queued(id, await quoted(id, input(id, '*open door* Hello')));
          assert.ok(
            known.p.request.context.actionOutcomes.some((o) => o.code !== 'ACTION_SUCCEEDED'),
          );
          assert.equal((await complete(id, known)).status, 'committed');
          const outcome = (await feed(id)).entries.find(
            (e) => e.turnId === known.id && e.kind === 'outcome',
          );
          assert.notEqual(outcome.code, 'ACTION_SUCCEEDED');
          assert.equal(live.state.entities.door.locked, true);
        },
      );
      await t.test(
        'feed insertion failure rolls back world, turn and provider settlement atomically',
        async () => {
          const id = ids[13],
            live = await prepare(id),
            q = await queued(
              id,
              await quoted(id, input(id, 'Add a connected room', { targetNpcId: undefined })),
            );
          await received(q);
          await db.query(
            `CREATE FUNCTION test_story_feed_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.campaign_id='${id}'::uuid THEN RAISE EXCEPTION 'SYNTHETIC_STORY_FEED_FAILURE'; END IF; RETURN NEW; END $$`,
          );
          await db.query(
            'CREATE TRIGGER test_story_feed_failure BEFORE INSERT ON game_story_feed FOR EACH ROW EXECUTE FUNCTION test_story_feed_failure()',
          );
          try {
            await assert.rejects(() => game.processAi(id, live), /SYNTHETIC_STORY_FEED_FAILURE/);
            assert.equal((await turn(q.id)).status, 'queued');
            assert.equal((await job(q.jobId)).status, 'result_received');
            assert.equal(live.state.narrativeCanon?.revision ?? 0, 0);
            assert.equal(
              (
                await db.query('SELECT count(*)::int n FROM game_story_feed WHERE turn_id=$1', [
                  q.id,
                ])
              ).rows[0].n,
              0,
            );
          } finally {
            await db.query('DROP TRIGGER test_story_feed_failure ON game_story_feed');
            await db.query('DROP FUNCTION test_story_feed_failure()');
          }
          const before = calls;
          await game.processAi(id, live);
          assert.equal((await turn(q.id)).status, 'committed');
          assert.equal(calls, before);
        },
      );
      await t.test(
        'private source revocation cancels delayed consent and denies feed despite accepted campaign membership',
        async () => {
          const id = ids[14];
          await prepare(id);
          const q = await queued(
            id,
            await quoted(id, input(id, 'Private source question'), other),
            other,
          );
          const invitations = new InvitationsController(
            database,
            auth,
            new Content(database, auth),
          );
          await invitations.revoke(privateStory.id, sourceInvite.id, req);
          await assert.rejects(() => feed(id, other));
          q.p.resolve({
            proposal: q.p.request.context.mockProposal,
            requestId: 'revoked-source-result',
            usage: { inputTokens: 1, outputTokens: 1, costMicros: 0 },
          });
          await until(async () => !ai.inFlight.has(id), Boolean);
          assert.ok(['cancelled', 'stale'].includes((await job(q.jobId)).status));
          await game.processAi(id, game.live.get(id));
          assert.equal((await turn(q.id)).status, 'failed');
          assert.equal(
            (await db.query('SELECT count(*)::int n FROM game_story_feed WHERE turn_id=$1', [q.id]))
              .rows[0].n,
            0,
          );
        },
      );
      await t.test(
        'pending confirmation and exact feed survive real API restart; offline time does not consume gameplay expiry',
        async () => {
          const id = ids[9];
          await prepare(id);
          const q = await interpreted(id),
            before = calls;
          const tick = game.live.get(id).state.tick;
          // Five gameplay ticks is a synthetic short window; wall-clock offline time must not spend it.
          await db.query('UPDATE game_story_turns SET valid_until_tick=$2 WHERE id=$1', [
            q.id,
            tick + 5,
          ]);
          const storedEntries = (await feed(ids[0])).entries.filter((e) => e.turnId);
          await game.onModuleDestroy();
          game = undefined;
          await delay(400);
          const stored = (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id]))
            .rows[0].state;
          assert.equal(stored.tick, tick);
          await startApi();
          const resumed = await owner.request(`/game/campaigns/${id}/turns/feed`);
          assert.equal(resumed.turns.find((t) => t.id === q.id).status, 'awaiting_confirmation');
          const restored = await owner.request(`/game/campaigns/${ids[0]}/turns/feed`);
          assert.deepEqual(
            restored.entries.filter((e) => e.turnId).map((e) => e.id),
            storedEntries.map((e) => e.id),
          );
          // Feed reads do not touch presence; the following explicit confirmation resumes safely.
          const confirmed = await owner.request(`/game/campaigns/${id}/turns/${q.id}/confirm`, {
            operationId: randomUUID(),
            proposalHash: q.proposalHash,
            decision: 'accept',
          });
          assert.equal(confirmed.status, 'committed');
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM npc_ai_jobs WHERE campaign_id=$1 AND purpose='story_turn'",
                [id],
              )
            ).rows[0].n,
            1,
          );
          await stopApi();
          instantiate();
          assert.equal(calls, before);
        },
      );
      await t.test(
        'erasure removes derived turns and keeps anti-replay tombstones without another call',
        async () => {
          const id = ids[8];
          await prepare(id);
          const q = await queued(
            id,
            await quoted(id, input(id, 'ERASED_TURN_CANARY'), other),
            other,
          );
          assert.equal((await complete(id, q)).status, 'committed');
          const own = await queued(
            id,
            await quoted(id, input(id, 'A response to the earlier statement')),
          );
          assert.equal((await complete(id, own)).status, 'committed');
          const exports = await database.tx((c) => exportStoryTurnData(c, owner.user.id));
          assert.ok(!JSON.stringify(exports).includes('ERASED_TURN_CANARY'));
          const live = game.live.get(id);
          live.state.entities.key.ownerId = actor;
          live.state.entities[actor].inventory.push('key');
          await game.persist(id, live, live.state, 'test.retained.inventory');
          const late = await queued(id, await quoted(id, input(id, 'Late derived response')));
          const before = calls;
          await database.tx(async (c) => {
            await c.query("SELECT set_config('dreamwalk.erasure','confirmed',true)");
            await c.query('UPDATE users SET deleted_at=now() WHERE id=$1', [guest.user.id]);
            await purgeGameData(c, guest.user.id);
          });
          late.p.resolve({
            proposal: late.p.request.context.mockProposal,
            requestId: 'late-private-response',
            usage: { inputTokens: 1, outputTokens: 1, costMicros: 0 },
          });
          await until(async () => !ai.inFlight.has(id), Boolean);
          await game.processAi(id, game.live.get(id));
          assert.deepEqual((await job(late.jobId)).context, {});
          assert.equal((await turn(late.id)).erased_at instanceof Date, true);
          assert.ok(!JSON.stringify(await feed(id)).includes('ERASED_TURN_CANARY'));
          assert.ok(game.live.get(id).state.entities[actor].inventory.includes('key'));
          await assert.rejects(
            () => controller.storySubmit(req, id, own.submit),
            errorCode('DATA_ERASED'),
          );
          assert.equal(calls, before);
          // External operator writes invalidate every loaded campaign through the normal access fence.
          for (const campaignId of ids) await controller.snapshot(req, campaignId);
        },
      );
    } finally {
      if (game) await game.onModuleDestroy();
      await stopApi();
      await database.pool.end();
      await db.end();
    }
  },
);
