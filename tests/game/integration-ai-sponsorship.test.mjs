/** No external calls: real PostgreSQL + injected deterministic providers/transports only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client } from './support-runtime.mjs';
import { purgeNpcAiData, exportNpcAiSponsors } from '../../scripts/npc-ai-data-requests.mjs';
const require = createRequire(import.meta.url);
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
const { MockNpcProvider } = require('../../apps/api/dist/ai/provider.js');
const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider.js');
const { readNpcAiConfiguration } = require('../../apps/api/dist/ai/config.js');
const { Db } = require('../../apps/api/dist/db.js');
const database = new Db();
const code = (expected) => (e) => e?.getResponse?.().code === expected;
const context = () => ({
  contextHash: randomUUID(),
  mockProposal: { actions: [{ kind: 'wait' }] },
});
await test(
  'explicit campaign sponsor and real OpenAI protocol boundary, no paid traffic',
  { timeout: 120000 },
  async (t) => {
    try {
      await startApi();
      const owner = await client().register(),
        other = await client().register();
      await db.query('UPDATE wallets SET balance=100 WHERE user_id=$1', [owner.user.id]);
      const { campaignId } = await owner.request('/game/campaigns', { template: 'observatory-v1' });
      const mock = new MockNpcProvider({ costMicros: 4 });
      const provider = {
        id: 'sponsor-test-' + randomUUID(),
        version: 'v1',
        external: false,
        generate: mock.generate.bind(mock),
      };
      const engine = new NpcAiEngine(database, provider, {
        creditPrice: 3,
        providerUpperMicros: 10,
        providerCapMicros: 1000,
      });
      const grantInput = () => ({
        operationId: randomUUID(),
        consent: true,
        totalCredits: 9,
        perOperationCredits: 3,
        maxOperations: 3,
        totalProviderMicros: 30,
        perOperationProviderMicros: 10,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        purposes: ['plan'],
      });
      const queue = (id, npc = 'keeper', operationId = randomUUID()) =>
        engine.queue({
          scope: { campaignId, npcId: npc, origin: 'system', purpose: 'plan' },
          sponsorId: id,
          operationId,
          context: context(),
        });
      let grant;
      await t.test(
        'explicit owner-only consent pins budgets; repeated grant is idempotent',
        async () => {
          const b = grantInput();
          await assert.rejects(
            () => engine.grantSponsor(campaignId, other.user.id, b),
            code('FORBIDDEN'),
          );
          await assert.rejects(() =>
            engine.grantSponsor(campaignId, owner.user.id, { ...b, consent: false }),
          );
          grant = await engine.grantSponsor(campaignId, owner.user.id, b);
          assert.deepEqual(await engine.grantSponsor(campaignId, owner.user.id, b), grant);
          assert.equal(grant.remainingOperations, 3);
          assert.equal(await engine.activeSponsor(campaignId, 'plan'), grant.id);
          assert.equal(await engine.activeSponsor(campaignId, 'speech'), undefined);
        },
      );
      await t.test(
        'system origin remains actorless, payer hold and capture are exactly once',
        async () => {
          const job = await queue(grant.id);
          const row = (await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [job.id])).rows[0];
          assert.equal(row.origin, 'system');
          assert.equal(row.requester_user_id, null);
          assert.equal(row.payer_user_id, owner.user.id);
          assert.equal((await engine.wallet(owner.user.id)).reserved, 3);
          await engine.run(job.id, async () => true);
          await database.tx((c) => engine.finalize(c, job.id, 'committed'));
          await database.tx((c) => engine.finalize(c, job.id, 'committed'));
          assert.equal((await engine.wallet(owner.user.id)).balance, 97);
          const g = (await engine.sponsors(campaignId, owner.user.id))[0];
          assert.equal(g.remainingCredits, 6);
          assert.equal(g.remainingOperations, 2);
          assert.equal(g.remainingProviderMicros, 20);
        },
      );
      await t.test(
        'parallel attempts obey cumulative operation/provider ceiling even after cancellation',
        async () => {
          const jobs = await Promise.all([queue(grant.id, 'keeper'), queue(grant.id, 'helper')]);
          await Promise.all(jobs.map((j) => engine.cancel(j.id)));
          await assert.rejects(() => queue(grant.id), code('SPONSOR_BUDGET_EXCEEDED'));
          const g = (await engine.sponsors(campaignId, owner.user.id))[0];
          assert.equal(g.remainingOperations, 0);
          assert.equal(g.remainingCredits, 6);
          await engine.revokeSponsor(campaignId, owner.user.id, grant.id);
        },
      );
      await t.test(
        'revocation after provider completion prevents capture; consent cannot resurrect',
        async () => {
          const g = await engine.grantSponsor(campaignId, owner.user.id, grantInput()),
            j = await queue(g.id);
          await engine.run(j.id, async () => true);
          await engine.revokeSponsor(campaignId, owner.user.id, g.id);
          await assert.rejects(() => database.tx((c) => engine.finalize(c, j.id, 'committed')));
          await engine.sweep(campaignId);
          assert.equal((await engine.wallet(owner.user.id)).reserved, 0);
          await assert.rejects(() => queue(g.id), code('SPONSOR_UNAVAILABLE'));
        },
      );
      await t.test(
        'expired consent stops dispatch and membership revoke/regrant invalidates grant',
        async () => {
          const g = await engine.grantSponsor(campaignId, owner.user.id, grantInput()),
            j = await queue(g.id);
          await db.query(
            "UPDATE npc_ai_sponsors SET expires_at=now()-interval '1 second' WHERE id=$1",
            [g.id],
          );
          await engine.run(j.id, async () => true);
          assert.equal((await engine.ready(campaignId)).length, 0);
          await engine.revokeSponsor(campaignId, owner.user.id, g.id);
          const next = await engine.grantSponsor(campaignId, owner.user.id, grantInput());
          await db.query(
            "UPDATE game_members SET status='revoked' WHERE campaign_id=$1 AND user_id=$2",
            [campaignId, owner.user.id],
          );
          await db.query(
            "UPDATE game_members SET status='accepted' WHERE campaign_id=$1 AND user_id=$2",
            [campaignId, owner.user.id],
          );
          await assert.rejects(() => queue(next.id), code('SPONSOR_UNAVAILABLE'));
          const removed = await engine.grantSponsor(campaignId, owner.user.id, grantInput());
          const membership = (
            await db.query('SELECT * FROM game_members WHERE campaign_id=$1 AND user_id=$2', [
              campaignId,
              owner.user.id,
            ])
          ).rows[0];
          await database.tx(async (c) => {
            // This synthetic deletion models the explicitly authorized erasure path.
            // Keep immutable hero protection enabled for ordinary application writes.
            await c.query("SELECT set_config('dreamwalk.erasure','confirmed',true)");
            await c.query('DELETE FROM game_members WHERE campaign_id=$1 AND user_id=$2', [
              campaignId,
              owner.user.id,
            ]);
          });
          await db.query(
            "INSERT INTO game_members(campaign_id,user_id,actor_id,status) VALUES($1,$2,$3,'accepted')",
            [campaignId, owner.user.id, membership.actor_id],
          );
          await assert.rejects(() => queue(removed.id), code('SPONSOR_UNAVAILABLE'));
        },
      );
      await t.test(
        'sponsor exports contain consent limits; erasure scrubs payer and revokes grants',
        async () => {
          const g = await engine.grantSponsor(campaignId, owner.user.id, grantInput());
          assert.ok(
            (await exportNpcAiSponsors(database.pool, owner.user.id)).some((x) => x.id === g.id),
          );
          await database.tx((c) => purgeNpcAiData(c, owner.user.id, [{ id: campaignId }]));
          const row = (await db.query('SELECT * FROM npc_ai_sponsors WHERE id=$1', [g.id])).rows[0];
          assert.equal(row.payer_user_id, null);
          assert.ok(row.revoked_at);
          assert.equal(row.request_hash, 'erased');
        },
      );
      await t.test(
        'OpenAI concrete Responses request is strict, private, bounded and correctly parses usage',
        async () => {
          const config = {
            enabled: true,
            apiKey: 'synthetic-test-key',
            model: 'explicit-test-model',
            version: 'test',
            maxInputBytes: 64000,
            maxOutputTokens: 100,
            maxResponseBytes: 64000,
            inputMicrosPerMillion: 1000000,
            outputMicrosPerMillion: 2000000,
          };
          let calls = 0;
          const transport = async (url, init) => {
            calls++;
            assert.equal(url, 'https://api.openai.com/v1/responses');
            assert.equal(init.redirect, 'error');
            const b = JSON.parse(init.body);
            assert.equal(b.model, config.model);
            assert.equal(b.store, false);
            assert.equal(b.stream, false);
            assert.equal(b.max_output_tokens, 100);
            assert.equal(b.text.format.strict, true);
            assert.equal(b.text.format.type, 'json_schema');
            assert.ok(!b.input.includes('mockProposal'));
            assert.ok(!('tools' in b));
            return new Response(
              JSON.stringify({
                id: 'resp_synthetic',
                status: 'completed',
                usage: { input_tokens: 20, output_tokens: 7 },
                output: [
                  {
                    type: 'message',
                    content: [
                      { type: 'output_text', text: JSON.stringify({ text: 'Good evening.' }) },
                    ],
                  },
                ],
              }),
            );
          };
          const p = new OpenAiNpcProvider(config, transport),
            request = {
              jobId: randomUUID(),
              purpose: 'speech',
              context: { contextHash: 'safe', claims: [], mockProposal: { code: 'acknowledged' } },
              signal: new AbortController().signal,
              maxCostMicros: 100000,
            };
          const result = await p.generate(request);
          assert.deepEqual(result.proposal, { text: 'Good evening.' });
          assert.equal(result.usage.costMicros, 34);
          assert.equal(calls, 1);
          await assert.rejects(() =>
            new OpenAiNpcProvider({ ...config, enabled: false }, transport).generate(request),
          );
          assert.equal(calls, 1);
          await assert.rejects(() => p.generate({ ...request, maxCostMicros: 1 }));
          assert.equal(calls, 1);
          assert.throws(() => new OpenAiNpcProvider({ ...config, model: '' }, transport));
          assert.throws(() =>
            readNpcAiConfiguration({
              NPC_AI_PROVIDER: 'openai-responses',
              NPC_AI_MODEL: 'explicit-test-model',
            }),
          );
          assert.equal(
            readNpcAiConfiguration({
              NPC_AI_PROVIDER: 'openai-responses',
              NPC_AI_MODEL: 'explicit-test-model',
              NPC_AI_INPUT_MICROS_PER_MILLION: '1000000',
              NPC_AI_OUTPUT_MICROS_PER_MILLION: '2000000',
            }).policy.externalApproved,
            false,
          );
        },
      );
      await t.test(
        'refusal/incomplete/invalid schema retain known expense; malformed usage remains uncertain',
        async () => {
          const config = {
            enabled: true,
            apiKey: 'synthetic',
            model: 'explicit',
            version: 'v1',
            maxInputBytes: 64000,
            maxOutputTokens: 100,
            maxResponseBytes: 64000,
            inputMicrosPerMillion: 1000000,
            outputMicrosPerMillion: 1000000,
          };
          const req = {
            jobId: randomUUID(),
            purpose: 'speech',
            context: { contextHash: 'safe' },
            signal: new AbortController().signal,
            maxCostMicros: 100000,
          };
          for (const [status, content, expected] of [
            ['completed', { type: 'refusal', refusal: 'No' }, 'PROVIDER_REFUSED'],
            ['incomplete', { type: 'output_text', text: '{}' }, 'PROVIDER_INCOMPLETE'],
            [
              'completed',
              { type: 'output_text', text: '{"secret":"no"}' },
              'PROVIDER_INVALID_RESULT',
            ],
          ]) {
            const p = new OpenAiNpcProvider(
              config,
              async () =>
                new Response(
                  JSON.stringify({
                    id: 'resp_test',
                    status,
                    usage: { input_tokens: 10, output_tokens: 5 },
                    output: [{ type: 'message', content: [content] }],
                  }),
                ),
            );
            const r = await p.generate(req);
            assert.equal(r.failureCode, expected);
            assert.equal(r.usage.costMicros, 15);
            assert.equal(r.proposal, null);
          }
          const bad = new OpenAiNpcProvider(
            config,
            async () =>
              new Response(JSON.stringify({ id: 'resp_test', status: 'completed', output: [] })),
          );
          await assert.rejects(
            () => bad.generate(req),
            (e) => e.uncertain === true,
          );
        },
      );
      await t.test(
        'Unicode and escaped history stays within complete-body cost allowance',
        async () => {
          const config = {
            enabled: true,
            apiKey: 'synthetic',
            model: 'explicit',
            version: 'v1',
            maxInputBytes: 64000,
            maxOutputTokens: 100,
            maxResponseBytes: 64000,
            inputMicrosPerMillion: 1000000,
            outputMicrosPerMillion: 2000000,
          };
          const upper = 12000;
          let calls = 0;
          const p = new OpenAiNpcProvider(config, async (_url, init) => {
            calls++;
            const bytes = Buffer.byteLength(init.body);
            assert.ok(bytes + 4096 + 200 <= upper);
            return new Response(
              JSON.stringify({
                id: 'resp_unicode',
                status: 'completed',
                usage: { input_tokens: 100, output_tokens: 10 },
                output: [
                  { type: 'message', content: [{ type: 'output_text', text: '{"text":"Да."}' }] },
                ],
              }),
            );
          });
          const context = { contextHash: 'safe', question: 'Почему?', claims: [] };
          const allowance = p.contextBudgetBytes(upper);
          assert.ok(allowance > 100);
          while (Buffer.byteLength(JSON.stringify(context)) + 32 < allowance)
            context.claims.push('Привет "мир" \\');
          const req = {
            jobId: randomUUID(),
            purpose: 'speech',
            context,
            signal: new AbortController().signal,
            maxCostMicros: upper,
          };
          assert.equal((await p.generate(req)).proposal.text, 'Да.');
          assert.equal(calls, 1);
          await assert.rejects(() =>
            p.generate({ ...req, context: { ...context, question: 'Я'.repeat(64000) } }),
          );
          assert.equal(calls, 1);
        },
      );
      await t.test(
        'plan actions and summary selection inherit server metadata, never model-supplied revisions',
        async () => {
          const config = {
            enabled: true,
            apiKey: 'synthetic',
            model: 'explicit',
            version: 'v1',
            maxInputBytes: 64000,
            maxOutputTokens: 100,
            maxResponseBytes: 64000,
            inputMicrosPerMillion: 1,
            outputMicrosPerMillion: 1,
          };
          let answer = {
            actions: [{ kind: 'give', targetId: 'player', itemId: 'token', target: null }],
          };
          const p = new OpenAiNpcProvider(
            config,
            async () =>
              new Response(
                JSON.stringify({
                  id: 'resp_plan',
                  status: 'completed',
                  usage: { input_tokens: 10, output_tokens: 10 },
                  output: [
                    {
                      type: 'message',
                      content: [{ type: 'output_text', text: JSON.stringify(answer) }],
                    },
                  ],
                }),
              ),
          );
          const base = {
            contextRevision: 5,
            mapRevision: 2,
            entityRevision: 3,
            brainGeneration: 4,
            deadlineTick: 30,
            actions: [{ kind: 'wait' }],
            targetRevisions: {},
          };
          const req = {
            jobId: randomUUID(),
            purpose: 'plan',
            context: {
              contextHash: 'safe',
              allowedActions: ['give', 'wait'],
              visibleEntities: [{ id: 'player', revision: 7 }],
              ownInventory: [{ id: 'token', revision: 8 }],
              mockProposal: base,
            },
            signal: new AbortController().signal,
            maxCostMicros: 100,
          };
          const r = await p.generate(req);
          assert.equal(r.proposal.contextRevision, 5);
          assert.deepEqual(r.proposal.targetRevisions, { player: 7, token: 8 });
          answer = {
            actions: [{ kind: 'give', targetId: 'unseen', itemId: 'token', target: null }],
          };
          assert.equal((await p.generate(req)).failureCode, 'PROVIDER_INVALID_ACTION');
          answer = {
            actions: [{ kind: 'wait', targetId: null, itemId: null, target: null }],
            beliefRevisions: [
              {
                beliefId: null,
                expectedRevision: 0,
                predicate: 'heard_noise',
                subjectId: null,
                targetId: null,
                evidenceIds: ['o1'],
                confidence: 'uncertain',
                status: 'active',
                reason: 'direct_evidence',
              },
            ],
          };
          const beliefResult = await p.generate({
            ...req,
            context: { ...req.context, knowledgeRevision: 9, observations: [{ id: 'o1' }] },
          });
          assert.equal(beliefResult.proposal.knowledgeRevision, 9);
          assert.equal(beliefResult.proposal.beliefRevisions[0].evidenceIds[0], 'o1');
          assert.equal((await p.generate(req)).failureCode, 'PROVIDER_INVALID_EVIDENCE');
          answer = {
            actions: [
              {
                kind: 'communicate',
                targetId: 'player',
                itemId: null,
                target: null,
                channel: 'whisper',
                observationIds: ['o1'],
              },
            ],
            beliefRevisions: [],
          };
          const communicateContext = {
            ...req.context,
            allowedActions: ['communicate'],
            observations: [{ id: 'o1' }],
          };
          const communication = await p.generate({ ...req, context: communicateContext });
          assert.deepEqual(communication.proposal.actions[0], {
            kind: 'communicate',
            targetId: 'player',
            channel: 'whisper',
            observationIds: ['o1'],
          });
          assert.equal(
            (await p.generate({ ...req, context: { ...communicateContext, observations: [] } }))
              .failureCode,
            'PROVIDER_INVALID_EVIDENCE',
          );
          const summary = {
            policyVersion: 1,
            modelVersion: 'grounded-summary-v1',
            coveredEventRange: { firstEventId: 'e1', lastEventId: 'e2' },
            revision: 2,
            knowledgeRevision: 9,
            inputFingerprint: 'trusted',
            observationIds: ['o1', 'o2'],
            claims: [
              { observationId: 'o1', kind: 'said' },
              { observationId: 'o2', kind: 'moved' },
            ],
          };
          answer = { observationIds: ['o1'] };
          const selected = await p.generate({
            ...req,
            purpose: 'summary',
            context: { contextHash: 'safe', mockProposal: summary },
          });
          assert.deepEqual(selected.proposal, { selectedObservationIds: ['o1'] });
          answer = { observationIds: ['fabricated'] };
          assert.equal(
            (
              await p.generate({
                ...req,
                purpose: 'summary',
                context: { contextHash: 'safe', mockProposal: summary },
              })
            ).failureCode,
            'PROVIDER_INVALID_EVIDENCE',
          );
        },
      );
      await t.test(
        'known OpenAI refusal expense settles without player charge or world result',
        async () => {
          const p = new OpenAiNpcProvider(
            {
              enabled: true,
              apiKey: 'synthetic',
              model: 'explicit',
              version: 'v1',
              maxInputBytes: 64000,
              maxOutputTokens: 100,
              maxResponseBytes: 64000,
              inputMicrosPerMillion: 1,
              outputMicrosPerMillion: 1,
            },
            async () =>
              new Response(
                JSON.stringify({
                  id: 'resp_refusal',
                  status: 'completed',
                  usage: { input_tokens: 10, output_tokens: 10 },
                  output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }],
                }),
              ),
          );
          const e = new NpcAiEngine(database, p, {
            externalApproved: true,
            creditPrice: 3,
            providerUpperMicros: 100,
            providerCapMicros: 1000,
          });
          const scope = {
              campaignId,
              npcId: 'keeper',
              origin: 'user',
              requesterUserId: owner.user.id,
              purpose: 'speech',
            },
            ctx = { contextHash: randomUUID(), claims: [] };
          const q = await e.quote(scope, ctx, owner.user.id),
            j = await e.queue({
              scope,
              context: ctx,
              operationId: randomUUID(),
              quoteId: q.id,
              consent: true,
            });
          const balance = (await e.wallet(owner.user.id)).balance;
          await e.run(j.id, async () => true);
          const row = (await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [j.id])).rows[0];
          assert.equal(row.status, 'stale');
          assert.equal(row.result_code, 'PROVIDER_REFUSED');
          assert.equal(row.provider_actual_micros, '1');
          assert.equal(row.provider_cost_evidence, 'configured_rates');
          assert.equal((await e.wallet(owner.user.id)).balance, balance);
          assert.equal((await e.wallet(owner.user.id)).reserved, 0);
        },
      );
      await t.test(
        'runtime request claim and job insertion are atomic; cancelled context never requeues',
        async () => {
          const ctx = context(),
            id = randomUUID();
          await db.query(
            'INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,requester_user_id,context) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [id, campaignId, 'keeper', 'plan', 'fixture:' + id, owner.user.id, ctx],
          );
          const e = new NpcAiEngine(database, new MockNpcProvider());
          const input = {
            scope: {
              campaignId,
              npcId: 'keeper',
              origin: 'user',
              requesterUserId: owner.user.id,
              purpose: 'plan',
            },
            operationId: id,
            runtimeRequestId: id,
            context: ctx,
          };
          const j = await e.queue(input);
          assert.deepEqual(await e.queue(input), j);
          const stored = (
            await db.query('SELECT status,job_id FROM game_npc_decision_requests WHERE id=$1', [id])
          ).rows[0];
          assert.equal(stored.status, 'scheduled');
          assert.equal(stored.job_id, j.id);
          assert.equal(
            (await e.replay(input.scope, id, undefined, false, '', undefined, id)).id,
            j.id,
          );
          await e.cancel(j.id);
          const revoked = randomUUID();
          await db.query(
            "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,requester_user_id,context,status) VALUES($1,$2,'keeper','plan',$3,$4,$5,'cancelled')",
            [revoked, campaignId, 'revoked:' + revoked, owner.user.id, ctx],
          );
          await assert.rejects(
            () => e.queue({ ...input, operationId: revoked, runtimeRequestId: revoked }),
            code('RUNTIME_REQUEST_STALE'),
          );
        },
      );
      await t.test(
        'player intent uses actual actor authority and sponsor payer without executing game action',
        async () => {
          const actor = (
            await db.query(
              'SELECT actor_id FROM game_members WHERE campaign_id=$1 AND user_id=$2',
              [campaignId, owner.user.id],
            )
          ).rows[0].actor_id;
          const e = new NpcAiEngine(database, provider, {
            creditPrice: 3,
            providerUpperMicros: 10,
            providerCapMicros: 1000,
          });
          const g = await e.grantSponsor(campaignId, owner.user.id, {
            ...grantInput(),
            purposes: ['intent'],
          });
          const scope = {
            campaignId,
            npcId: actor,
            origin: 'user',
            subjectKind: 'player',
            requesterUserId: owner.user.id,
            purpose: 'intent',
          };
          await assert.rejects(
            () =>
              e.queue({
                scope: { ...scope, npcId: 'keeper' },
                operationId: randomUUID(),
                sponsorId: g.id,
                context: context(),
              }),
            code('FORBIDDEN'),
          );
          const before = (
            await db.query('SELECT state FROM game_campaigns WHERE id=$1', [campaignId])
          ).rows[0].state;
          const job = await e.queue({
            scope,
            operationId: randomUUID(),
            sponsorId: g.id,
            context: {
              contextHash: randomUUID(),
              mockProposal: { kind: 'action', action: { kind: 'wait' } },
            },
          });
          assert.equal(job.subjectKind, 'player');
          await e.run(job.id, async () => true);
          await database.tx((c) => e.finalize(c, job.id, 'committed'));
          assert.deepEqual(
            (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [campaignId])).rows[0]
              .state,
            before,
          );
          await e.revokeSponsor(campaignId, owner.user.id, g.id);
        },
      );
      await t.test(
        'OpenAI intent schema returns supported action or bounded clarification, never autoexecutes',
        async () => {
          let answer = {
            kind: 'action',
            action: { kind: 'inspect', targetId: 'door', itemId: null, target: null },
            messageCode: null,
          };
          const config = {
            enabled: true,
            apiKey: 'synthetic',
            model: 'explicit',
            version: 'v1',
            maxInputBytes: 64000,
            maxOutputTokens: 100,
            maxResponseBytes: 64000,
            inputMicrosPerMillion: 1,
            outputMicrosPerMillion: 1,
          };
          const p = new OpenAiNpcProvider(
            config,
            async () =>
              new Response(
                JSON.stringify({
                  id: 'resp_intent',
                  status: 'completed',
                  usage: { input_tokens: 10, output_tokens: 10 },
                  output: [
                    {
                      type: 'message',
                      content: [{ type: 'output_text', text: JSON.stringify(answer) }],
                    },
                  ],
                }),
              ),
          );
          const request = {
            jobId: randomUUID(),
            purpose: 'intent',
            context: {
              contextHash: 'public',
              question: 'Осмотрю дверь',
              allowedActions: ['inspect', 'wait'],
              visibleEntities: [{ id: 'door' }],
              ownInventory: [],
            },
            signal: new AbortController().signal,
            maxCostMicros: 100,
          };
          assert.deepEqual((await p.generate(request)).proposal, {
            kind: 'action',
            action: { kind: 'inspect', targetId: 'door' },
          });
          answer = { kind: 'clarify', action: null, messageCode: 'AMBIGUOUS' };
          assert.deepEqual((await p.generate(request)).proposal, {
            kind: 'clarify',
            messageCode: 'AMBIGUOUS',
          });
          answer = {
            kind: 'action',
            action: { kind: 'inspect', targetId: 'secret', itemId: null, target: null },
            messageCode: null,
          };
          assert.equal((await p.generate(request)).failureCode, 'PROVIDER_INVALID_ACTION');
        },
      );
    } finally {
      await stopApi();
      await db.end();
      await database.onApplicationShutdown();
    }
  },
);
