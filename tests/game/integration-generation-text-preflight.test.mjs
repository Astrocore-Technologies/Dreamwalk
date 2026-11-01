/** Real disposable PostgreSQL, actual authority/provider pipeline, injected HTTP only. No credentials or real requests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db } from './support-runtime.mjs';
import { requestEstimateOwnerProfile, ownerEnvironment } from '../images/owner-config-fixture.mjs';
const require = createRequire(import.meta.url);
const { GenerationAuthority } = require('../../apps/api/dist/generation/service.js');
const { readOwnerGenerationConfig } = require('../../apps/api/dist/generation/config.js');
const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider.js');
const { GenerationProvider } = require('../../apps/api/dist/generation/provider.js');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
const database = {
  query: async (s, a = []) => (await db.query(s, a)).rows,
  tx: async (f) => {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const r = await f(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  },
};
const denied = (pattern) => (e) => {
  assert.match(String(e?.getResponse?.()?.code ?? e.message), pattern);
  return true;
};
const gate = () => {
  let release;
  const wait = new Promise((r) => (release = r));
  return { wait, release };
};
test(
  'explicit count preflight preserves full context, financial scope and immutable dispatch evidence',
  { timeout: 90000 },
  async (t) => {
    assert.match(process.env.LOCAL_POSTGRES_CLUSTER, /^game-test-/);
    const owner = randomUUID(),
      other = randomUUID(),
      handle = 'count_' + owner.slice(0, 8),
      campaign = randomUUID();
    for (const [id, h] of [
      [owner, handle],
      [other, 'other_' + other.slice(0, 8)],
    ])
      await db.query(
        "INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,'synthetic','Fixture',$3)",
        [id, id + '@example.test', h],
      );
    const raw = requestEstimateOwnerProfile();
    Object.assign(raw.text, {
      contextBudgetTokens: 256000,
      contextTokens: 1050000,
      maxOutputTokens: 2048,
    });
    const cfg = readOwnerGenerationConfig(ownerEnvironment(raw, handle));
    let authority = new GenerationAuthority(database, cfg),
      countCalls = 0,
      generationCalls = 0,
      countTokens = 130000,
      httpStatus = 200,
      hold = null,
      started = null;
    const makeProvider = (a, config) =>
      new GenerationProvider(
        new OpenAiNpcProvider(
          {
            enabled: true,
            apiKey: 'synthetic-not-a-key',
            model: config.text.model,
            version: config.configFingerprint,
            maxInputBytes: config.text.maxInputBytes,
            maxModelInputTokens: config.text.contextTokens,
            contextBudgetTokens: 256000,
            maxOutputTokens: config.text.maxOutputTokens,
            maxResponseBytes: 128000,
            inputMicrosPerMillion: config.text.inputMicrosPerMillion,
            outputMicrosPerMillion: config.text.outputMicrosPerMillion,
            estimation: config.text.estimation,
            pricing: config.text.pricing,
          },
          async (url, options) => {
            const body = JSON.parse(options.body);
            assert.equal(body.model, config.text.model);
            if (url.endsWith('/input_tokens')) {
              countCalls++;
              assert.equal('max_output_tokens' in body, false);
              assert.ok(body.instructions);
              assert.ok(body.text.format.schema);
              if (started) started.release();
              if (hold) await hold.wait;
              return new Response(
                JSON.stringify({ object: 'response.input_tokens', input_tokens: countTokens }),
                { status: httpStatus },
              );
            }
            assert.equal(url, 'https://api.openai.com/v1/responses');
            generationCalls++;
            assert.ok(Buffer.byteLength(options.body) > 600000);
            return new Response(
              JSON.stringify({
                id: 'synthetic-generation',
                status: 'completed',
                service_tier: 'default',
                usage: { input_tokens: 130000, output_tokens: 10 },
                output: [
                  {
                    type: 'message',
                    content: [
                      {
                        type: 'output_text',
                        text: JSON.stringify({ text: 'Synthetic counted response' }),
                      },
                    ],
                  },
                ],
              }),
            );
          },
        ),
        a,
      );
    let provider = makeProvider(authority, cfg);
    await authority.claim(owner, { consent: true, candidateFingerprint: cfg.configFingerprint });
    const fence = { roundId: 'count-round', phaseEpoch: 7, rulesetVersion: 1 };
    const state = {
      turnController: {
        phase: 'world',
        roundId: fence.roundId,
        phaseEpoch: fence.phaseEpoch,
        ruleset: { version: 1 },
      },
    };
    await db.query(
      "INSERT INTO game_campaigns(id,owner_id,playable_version,state) VALUES($1,$2,'synthetic',$3)",
      [campaign, owner, JSON.stringify(state)],
    );
    await db.query(
      "INSERT INTO game_members(campaign_id,user_id,actor_id,status) VALUES($1,$2,'player','accepted')",
      [campaign, owner],
    );
    const addRequest = async () => {
      const id = randomUUID();
      const full = {
        contextHash: id,
        turnFence: fence,
        replyLocale: 'ru',
        historyPolicy: 'permitted-only',
        history: Array.from({ length: 150 }, (_, i) => ({
          id: 'h' + i,
          text: '\u042f'.repeat(2000),
        })),
      };
      const approximate = { ...full, history: full.history.slice(-1), textContextCandidate: full };
      await db.query(
        "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,requester_user_id,context,status) VALUES($1::uuid,$2,'keeper','speech',$1::uuid::text,$3,$4,'queued')",
        [id, campaign, owner, JSON.stringify(approximate)],
      );
      return id;
    };
    const pending = async (id) =>
      (await authority.pending(owner, campaign)).requests.find((r) => r.id === id);
    const body = async (id, change = {}) => {
      const r = await pending(id);
      return {
        operationId: randomUUID(),
        turnFence: fence,
        policyRevision: r.policyRevision,
        policyHash: r.policyHash,
        candidateFingerprint: r.counting.candidateFingerprint,
        consent: true,
        ...change,
      };
    };
    const first = await addRequest();
    await t.test('read-only pending and unknown count pricing never call transport', async () => {
      const r = await pending(first);
      assert.equal(r.counting.blockCode, 'TEXT_COUNT_COST_REVIEW_REQUIRED');
      assert.equal(countCalls, 0);
      await assert.rejects(
        authority.preflightCount(owner, campaign, first, await body(first)),
        denied(/TEXT_COUNT_COST_REVIEW_REQUIRED/),
      );
      assert.equal(countCalls, 0);
    });
    const pricedRaw = structuredClone(raw);
    pricedRaw.text.counting = {
      kind: 'owner_reviewed_fixed',
      microsPerRequest: 7,
      pricing: { ...raw.text.pricing },
    };
    const pricedCfg = readOwnerGenerationConfig(ownerEnvironment(pricedRaw, handle));
    authority = new GenerationAuthority(database, pricedCfg);
    provider = makeProvider(authority, pricedCfg);
    const review = await authority.reviewPolicy(owner);
    await authority.amendPolicy(owner, {
      operationId: randomUUID(),
      expectedRevision: review.active.revision,
      expectedHash: review.active.hash,
      candidateFingerprint: pricedCfg.configFingerprint,
      consent: true,
    });
    let countedBody, firstOperation;
    await t.test(
      'an explicit reviewed POST counts full Russian input before approximate packing',
      async () => {
        const input = await body(first);
        firstOperation = input;
        const result = await authority.preflightCount(owner, campaign, first, input);
        assert.equal(result.status, 'succeeded');
        assert.equal(result.invoiceExact, false);
        assert.equal(result.actualMicros, 7);
        assert.equal(countCalls, 1);
        countedBody = (
          await db.query('SELECT context FROM game_npc_decision_requests WHERE id=$1', [first])
        ).rows[0].context;
        assert.equal(countedBody.history.length, 150);
        const estimate = provider.prepareTextRequest('speech', countedBody).snapshot;
        assert.equal(estimate.contextWindow.precision, 'exact');
        assert.equal(estimate.contextWindow.inputTokens, 130000);
        assert.ok(estimate.serializedBytes > 600000);
        assert.equal(estimate.contextWindow.totalTokens, 132048);
      },
    );
    await t.test(
      'restart and duplicate POST/GET reuse persisted evidence and do not recount',
      async () => {
        authority = new GenerationAuthority(database, pricedCfg);
        provider = makeProvider(authority, pricedCfg);
        assert.equal(
          (await authority.preflightCount(owner, campaign, first, firstOperation)).status,
          'succeeded',
        );
        assert.equal(
          (await authority.countOperation(owner, firstOperation.operationId)).status,
          'succeeded',
        );
        assert.equal(countCalls, 1);
        assert.equal((await pending(first)).estimateSnapshot.contextWindow.precision, 'exact');
      },
    );
    await t.test(
      'foreign owner and altered body/evidence cannot authorize a count or generation',
      async () => {
        await assert.rejects(authority.preflightCount(other, campaign, first, firstOperation));
        assert.throws(
          () => provider.prepareTextRequest('speech', { ...countedBody, replyLocale: 'uk' }),
          /TEXT_COUNT_EVIDENCE_STALE/,
        );
        await assert.rejects(
          authority.assertCountEvidence({
            ...countedBody,
            textCountEvidence: { ...countedBody.textCountEvidence, inputTokens: 1 },
          }),
          denied(/TEXT_COUNT_EVIDENCE_STALE/),
        );
        assert.equal(countCalls, 1);
      },
    );
    await t.test(
      'quote, consent and actual generation use the same counted body and charge count plus text once',
      async () => {
        const ai = new NpcAiEngine(database, provider, {
          externalApproved: true,
          providerUpperMicros: pricedCfg.text.upperMicros,
          providerCapMicros: pricedCfg.textCapMicros,
          timeoutMs: 2000,
        });
        // Synthetic campaign has no published source. Authority membership/owner checks remain real.
        ai.authorize = async () => {};
        const r = await pending(first);
        await authority.consent(owner, campaign, first, {
          authorizationId: (await authority.status(owner)).authorizationId,
          operationId: randomUUID(),
          turnFence: fence,
          policyRevision: r.policyRevision,
          policyHash: r.policyHash,
          estimateFingerprint: r.estimateSnapshot.fingerprint,
          consent: true,
        });
        const scope = {
          campaignId: campaign,
          npcId: 'keeper',
          origin: 'user',
          purpose: 'speech',
          requesterUserId: owner,
        };
        const q = await ai.quote(scope, countedBody, owner);
        const job = await ai.queue({
          scope,
          context: countedBody,
          requesterUserId: owner,
          operationId: randomUUID(),
          quoteId: q.id,
          consent: true,
          runtimeRequestId: first,
        });
        await ai.run(job.id, async () => true);
        await ai.run(job.id, async () => true);
        assert.equal(generationCalls, 1);
        assert.equal(countCalls, 1);
        const usage = await authority.status(owner);
        assert.equal(usage.usedMicros, 130027);
        await database.tx((c) => ai.finalize(c, job.id, 'committed'));
      },
    );
    await t.test(
      'simultaneous identical count requests dispatch once; amendment waits for the held count',
      async () => {
        const id = await addRequest(),
          input = await body(id);
        hold = gate();
        started = gate();
        const running = authority.preflightCount(owner, campaign, id, input);
        await started.wait;
        assert.equal(
          (await authority.preflightCount(owner, campaign, id, input)).status,
          'dispatched',
        );
        try {
          const changedRaw = structuredClone(pricedRaw);
          changedRaw.text.maxOutputTokens += 512;
          const changed = new GenerationAuthority(
            database,
            readOwnerGenerationConfig(ownerEnvironment(changedRaw, handle)),
          );
          const r = await changed.reviewPolicy(owner);
          assert.ok((r.proposed?.blockers ?? []).includes('GENERATION_POLICY_BUSY'));
        } finally {
          hold.release();
          await running;
          hold = null;
          started = null;
        }
        assert.equal(countCalls, 2);
      },
    );
    await t.test(
      'overflow never silently generates; retries require explicit smaller history and are bounded',
      async () => {
        const id = await addRequest();
        countTokens = 300000;
        for (let i = 0; i < 3; i++)
          assert.equal(
            (
              await authority.preflightCount(
                owner,
                campaign,
                id,
                await body(id, { keepRecentHistory: 2 }),
              )
            ).status,
            'over_context',
          );
        await assert.rejects(
          authority.preflightCount(owner, campaign, id, await body(id)),
          denied(/TEXT_COUNT_ATTEMPT_LIMIT/),
        );
        assert.equal(generationCalls, 1);
        countTokens = 130000;
      },
    );
    await t.test(
      'late count settles its reviewed fee but cannot adopt in a different phase',
      async () => {
        const id = await addRequest(),
          input = await body(id);
        hold = gate();
        started = gate();
        const running = authority.preflightCount(owner, campaign, id, input);
        await started.wait;
        await db.query(
          "UPDATE game_campaigns SET state=jsonb_set(state,'{turnController,phaseEpoch}','8') WHERE id=$1",
          [campaign],
        );
        hold.release();
        assert.equal((await running).status, 'stale');
        hold = null;
        started = null;
        const c = (
          await db.query('SELECT context FROM game_npc_decision_requests WHERE id=$1', [id])
        ).rows[0].context;
        assert.equal(c.textCountEvidence, undefined);
        await db.query('UPDATE game_campaigns SET state=$2 WHERE id=$1', [
          campaign,
          JSON.stringify(state),
        ]);
      },
    );
    await t.test(
      '403 and unknown expenditure stop the shared scope; GET reconciliation never retries',
      async () => {
        const id = await addRequest(),
          input = await body(id);
        httpStatus = 403;
        const result = await authority.preflightCount(owner, campaign, id, input);
        assert.equal(result.status, 'unknown');
        const calls = countCalls;
        assert.equal((await authority.status(owner)).state, 'stopped');
        assert.equal((await authority.countOperation(owner, input.operationId)).status, 'unknown');
        await assert.rejects(authority.preflightCount(owner, campaign, id, input));
        assert.equal(countCalls, calls);
        const reserve = (
          await db.query(
            'SELECT r.* FROM generation_budget_reservations r JOIN generation_text_counts t ON t.reservation_id=r.id WHERE t.id=$1',
            [result.id],
          )
        ).rows[0];
        assert.equal(reserve.status, 'held');
        assert.equal(Number(reserve.upper_micros), 7);
      },
    );
    await t.test(
      'export includes count financial history; erasure removes hashes and preserves unknown liability',
      async () => {
        const { exportManualLiveData, purgeManualLiveData } =
          await import('../../scripts/manual-live-data-requests.mjs');
        const exported = await database.tx((c) => exportManualLiveData(c, owner));
        assert.ok(exported.textCounts.length >= 7);
        await database.tx((c) => purgeManualLiveData(c, owner, [{ id: campaign }]));
        const rows = (
          await db.query('SELECT * FROM generation_text_counts WHERE actor_id=$1', [owner])
        ).rows;
        assert.ok(
          rows.every(
            (r) => r.body_sha256 === null && r.source_hash === null && r.request_hash === null,
          ),
        );
        assert.ok(
          (
            await db.query(
              "SELECT 1 FROM generation_budget_reservations WHERE status='held' AND upper_micros=7",
            )
          ).rowCount > 0,
        );
      },
    );
  },
);
