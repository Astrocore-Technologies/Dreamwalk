/** Isolated PostgreSQL only: synthetic profiles, no app startup, credential read or provider dispatch. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { db } from './support-runtime.mjs';
import { ownerEnvironment, ownerProfile } from '../images/owner-config-fixture.mjs';
const require = createRequire(import.meta.url);
const {
  GenerationAuthority,
  GENERATION_SCOPE_ID: scopeId,
} = require('../../apps/api/dist/generation/service.js');
const { readOwnerGenerationConfig } = require('../../apps/api/dist/generation/config.js');
const { digest } = require('../../apps/api/dist/ai/context.js');
const {
  reserveGenerationSpend,
  settleGenerationSpend,
} = require('../../apps/api/dist/image-generation/budget.js');
const database = {
  query: async (sql, args = []) => (await db.query(sql, args)).rows,
  tx: async (work) => {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout='8s'");
      const result = await work(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  },
};
const errorCode = (e) => e?.getResponse?.()?.code ?? e?.code ?? e?.message;
const denied = (pattern) => (e) => {
  assert.match(String(errorCode(e)), pattern);
  return true;
};
function gate() {
  let release;
  const reached = new Promise((r) => (release = r));
  return { reached, release };
}
test(
  'reviewed revisions retain one ledger, immutable rates and durable reconciliation',
  { timeout: 45000 },
  async (t) => {
    assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^game-test-[a-f0-9-]{36}$/);
    assert.equal(
      (await db.query('SELECT id FROM generation_budget_scopes WHERE id=$1', [scopeId])).rowCount,
      0,
      'Dedicated cluster required; never clear another scope',
    );
    const owner = randomUUID(),
      other = randomUUID(),
      authorizationId = randomUUID();
    const handle = 'revision_' + owner.replaceAll('-', '').slice(0, 12);
    for (const [id, h] of [
      [owner, handle],
      [other, 'other_' + other.replaceAll('-', '').slice(0, 12)],
    ])
      await db.query(
        'INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,$3,$4,$5)',
        [id, id + '@example.test', 'synthetic-no-login', 'Revision fixture', h],
      );
    const raw = ownerProfile();
    const cfg = readOwnerGenerationConfig(ownerEnvironment(raw, handle));
    const old = new GenerationAuthority(database, cfg);
    await t.test(
      'initial owner claim cannot authorize an unseen candidate after restart',
      async () => {
        await assert.rejects(
          old.claim(owner, { consent: true, candidateFingerprint: 'f'.repeat(64) }),
          denied(/GENERATION_POLICY_STALE/),
        );
        assert.equal(
          (await db.query('SELECT id FROM live_test_sessions WHERE scope_id=$1', [scopeId]))
            .rowCount,
          0,
        );
        assert.equal(
          (await db.query('SELECT id FROM generation_budget_scopes WHERE id=$1', [scopeId]))
            .rowCount,
          0,
        );
      },
    );
    await db.query(
      'INSERT INTO generation_budget_scopes(id,approved,total_cap_micros,text_cap_micros,image_cap_micros,serialize_outstanding) VALUES($1,true,$2,$3,$4,true)',
      [scopeId, cfg.totalCapMicros, cfg.textCapMicros, cfg.imageCapMicros],
    );
    await db.query(
      "INSERT INTO live_test_sessions(id,owner_id,scope_id,cap_micros,state,mode,config_hash,owner_handle,text_cap_micros,image_cap_micros) VALUES($1,$2,$3,$4,'active','owner',$5,$6,$7,$8)",
      [
        authorizationId,
        owner,
        scopeId,
        cfg.totalCapMicros,
        'a'.repeat(64),
        handle,
        cfg.textCapMicros,
        cfg.imageCapMicros,
      ],
    );
    const body = (policy, config = cfg) => ({
      operationId: randomUUID(),
      expectedRevision: policy.active.revision,
      expectedHash: policy.active.hash,
      candidateFingerprint: config.configFingerprint,
      consent: true,
    });
    const policy = () => old.reviewPolicy(owner);
    let initialReceipt;
    await t.test('GET legacy mismatch is read-only and never fabricates old pricing', async () => {
      const before = (
        await db.query('SELECT * FROM live_test_sessions WHERE id=$1', [authorizationId])
      ).rows[0];
      const view = await policy();
      assert.equal(view.active.revision, 0);
      assert.equal(view.active.profile, null);
      assert.equal(view.legacyProfileStatus, 'unavailable');
      assert.equal(view.dispatchEnabled, false);
      assert.equal(view.proposed.canApply, true);
      assert.equal(view.history.length, 0);
      assert.deepEqual(
        (await db.query('SELECT * FROM live_test_sessions WHERE id=$1', [authorizationId])).rows[0],
        before,
      );
      await db.query('UPDATE live_test_sessions SET config_hash=$2 WHERE id=$1', [
        authorizationId,
        digest(cfg),
      ]);
      assert.equal((await policy()).legacyProfileStatus, 'available');
      assert.equal((await policy()).history.length, 0);
      await db.query('UPDATE live_test_sessions SET config_hash=$2 WHERE id=$1', [
        authorizationId,
        'a'.repeat(64),
      ]);
    });
    await t.test(
      'duplicate explicit review appends one acknowledged record and reconciles exactly',
      async () => {
        const input = body(await policy());
        const results = await Promise.all([
          old.amendPolicy(owner, input),
          old.amendPolicy(owner, input),
        ]);
        assert.deepEqual(results[0], results[1]);
        initialReceipt = results[0];
        assert.equal(initialReceipt.revision, 1);
        assert.deepEqual(await old.policyOperation(owner, input.operationId), initialReceipt);
        assert.equal((await old.policyOperation(owner, randomUUID())).status, 'not_found');
        await assert.rejects(
          old.amendPolicy(owner, { ...input, expectedRevision: 99 }),
          denied(/IDEMPOTENCY_CONFLICT/),
        );
        const view = await policy();
        assert.equal(view.history.length, 1);
        assert.equal(view.history[0].previousHash, 'a'.repeat(64));
        assert.equal(view.active.profile.image.model, raw.image.model);
        assert.equal(JSON.stringify(view.history).includes(handle), false);
        await assert.rejects(
          db.query('UPDATE generation_policy_revisions SET profile_hash=profile_hash'),
          /Immutable generation policy revision/,
        );
        await assert.rejects(
          db.query('DELETE FROM generation_policy_revisions'),
          /Immutable generation policy revision/,
        );
        await assert.rejects(old.reviewPolicy(other), denied(/FORBIDDEN|OWNER_IMMUTABLE/));
      },
    );
    const nextRaw = {
      ...raw,
      totalCapMicros: 1200000,
      textCapMicros: 400000,
      imageCapMicros: 800000,
      text: { ...raw.text, model: 'synthetic-revised-text', inputMicrosPerMillion: 1100000 },
      image: {
        ...raw.image,
        model: 'synthetic-revised-image',
        outputImageMicrosPerMillion: 4000000,
      },
    };
    const nextCfg = readOwnerGenerationConfig(ownerEnvironment(nextRaw, handle));
    const next = new GenerationAuthority(database, nextCfg);
    let oldReservation;
    await t.test(
      'restart exposes reviewed candidate and blocks dispatch until owner applies',
      async () => {
        const view = await next.reviewPolicy(owner);
        assert.equal(view.active.profile.text.model, cfg.text.model);
        assert.equal(view.proposed.profile.text.model, nextCfg.text.model);
        assert.equal(view.dispatchEnabled, false);
        const status = await next.status(owner);
        assert.equal(status.state, 'stopped');
        assert.equal(status.policyRevision, 1);
        await assert.rejects(
          database.tx((c) => next.authorizeImage(c, owner, authorizationId)),
          denied(/CONFIG_IMMUTABLE|POLICY_CHANGED/),
        );
        assert.equal(
          (await db.query('SELECT count(*) n FROM generation_policy_revisions')).rows[0].n,
          '1',
        );
      },
    );
    await t.test(
      'reservation wins concurrent amendment; held funds and queued work cannot be bypassed',
      async () => {
        const c = await db.connect();
        await c.query('BEGIN');
        let amendment,
          finished = false;
        try {
          const rights = await old.authorizeImage(c, owner, authorizationId);
          oldReservation = await reserveGenerationSpend(
            c,
            { ...rights, verifiedUpperMicros: 200000 },
            owner,
            'image',
            'revision-held:' + randomUUID(),
            200000,
          );
          const input = body(await next.reviewPolicy(owner), nextCfg);
          amendment = next.amendPolicy(owner, input).then(
            (v) => {
              finished = true;
              return { v };
            },
            (e) => {
              finished = true;
              return { e };
            },
          );
          await delay(80);
          assert.equal(finished, false, 'Amendment must wait for locked financial identity');
          await c.query('COMMIT');
          const result = await amendment;
          assert.match(String(errorCode(result.e)), /GENERATION_POLICY_BUSY/);
          const view = await next.reviewPolicy(owner);
          assert.equal(view.proposed.canApply, false);
          assert.equal(view.liabilities.heldMicros, 200000);
          assert.equal(
            (await db.query('SELECT count(*) n FROM generation_policy_revisions')).rows[0].n,
            '1',
          );
        } finally {
          await c.query('ROLLBACK');
          c.release();
          if (amendment) await amendment;
        }
      },
    );
    await t.test(
      'old settlement remains exact and cap reductions below liability are refused',
      async () => {
        await database.tx((c) => settleGenerationSpend(c, oldReservation, 180000));
        const lowerCfg = readOwnerGenerationConfig(
          ownerEnvironment({ ...raw, imageCapMicros: 150000 }, handle),
        );
        const lower = new GenerationAuthority(database, lowerCfg);
        const view = await lower.reviewPolicy(owner);
        assert.ok(view.proposed.blockers.includes('GENERATION_CAP_BELOW_HISTORICAL_SPEND'));
        await assert.rejects(
          lower.amendPolicy(owner, body(view, lowerCfg)),
          denied(/CAP_BELOW_HISTORICAL_SPEND/),
        );
        assert.equal(view.liabilities.image.spentMicros, 180000);
      },
    );
    await t.test(
      'amendment wins concurrent old process dispatch and preserves prices/owner/scope',
      async () => {
        const ready = gate(),
          release = gate();
        const holdingDb = {
          ...database,
          tx: (work) =>
            database.tx(async (c) => {
              const result = await work(c);
              ready.release();
              await release.reached;
              return result;
            }),
        };
        const applying = new GenerationAuthority(holdingDb, nextCfg);
        const input = body(await next.reviewPolicy(owner), nextCfg);
        const changing = applying.amendPolicy(owner, input);
        await ready.reached;
        let finished = false;
        const stale = database
          .tx((c) => old.authorizeImage(c, owner, authorizationId))
          .then(
            (v) => {
              finished = true;
              return { v };
            },
            (e) => {
              finished = true;
              return { e };
            },
          );
        await delay(80);
        assert.equal(finished, false);
        release.release();
        const receipt = await changing,
          result = await stale;
        assert.equal(receipt.revision, 2);
        assert.match(String(errorCode(result.e)), /CONFIG_IMMUTABLE|POLICY_CHANGED/);
        const view = await next.reviewPolicy(owner);
        assert.equal(view.dispatchEnabled, true);
        assert.equal(view.liabilities.spentMicros, 180000);
        assert.equal(
          view.history[0].profile.image.outputImageMicrosPerMillion,
          raw.image.outputImageMicrosPerMillion,
        );
        assert.equal(
          view.history[1].profile.image.outputImageMicrosPerMillion,
          nextRaw.image.outputImageMicrosPerMillion,
        );
        assert.equal(
          (
            await db.query('SELECT owner_id,scope_id FROM live_test_sessions WHERE id=$1', [
              authorizationId,
            ])
          ).rows[0].owner_id,
          owner,
        );
        assert.equal(
          (await db.query('SELECT count(*) n FROM generation_budget_scopes')).rows[0].n,
          '1',
        );
        await assert.rejects(
          next.amendPolicy(owner, { ...input, operationId: randomUUID() }),
          denied(/POLICY_STALE/),
        );
        assert.deepEqual(await next.policyOperation(owner, input.operationId), receipt);
      },
    );
    await t.test(
      'old process cannot reclaim prior config; no identical-profile epoch bypass',
      async () => {
        await assert.rejects(
          old.claim(owner, { consent: true, candidateFingerprint: cfg.configFingerprint }),
          denied(/CONFIG_IMMUTABLE/),
        );
        const current = await next.reviewPolicy(owner);
        const explicit = await next.amendPolicy(owner, body(current, nextCfg));
        assert.equal(explicit.revision, 3);
        assert.equal(explicit.hash, current.active.hash);
        await database.tx(async (c) => {
          await next.lockAuthorization(c, authorizationId);
          assert.equal(
            (await next.assertActivePolicy(c, authorizationId, nextCfg.configFingerprint)).revision,
            3,
          );
        });
        assert.equal((await next.reviewPolicy(owner)).history.length, 3);
      },
    );
    await t.test('fixed-price owner consent fences the displayed policy epoch too', async () => {
      const campaignId = randomUUID(),
        requestId = randomUUID();
      const turnFence = { roundId: 'synthetic-revision-world', phaseEpoch: 1, rulesetVersion: 1 };
      await db.query(
        "INSERT INTO game_campaigns(id,owner_id,playable_version,state) VALUES($1,$2,'synthetic',$3)",
        [
          campaignId,
          owner,
          JSON.stringify({
            turnController: {
              phase: 'world',
              roundId: turnFence.roundId,
              phaseEpoch: 1,
              ruleset: { version: 1 },
            },
          }),
        ],
      );
      await db.query(
        "INSERT INTO game_members(campaign_id,user_id,actor_id,status) VALUES($1,$2,'player','accepted')",
        [campaignId, owner],
      );
      await db.query(
        "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,requester_user_id,context,status) VALUES($1,$2,'synthetic-npc','plan',$5,$3,$4,'queued')",
        [
          requestId,
          campaignId,
          owner,
          JSON.stringify({
            contextHash: requestId,
            turnFence,
            mockProposal: { actions: [{ kind: 'wait' }] },
          }),
          requestId,
        ],
      );
      const pending = await next.pending(owner, campaignId);
      assert.equal(pending.requests[0].policyRevision, 3);
      assert.equal(pending.requests[0].reserveMicros, nextCfg.text.upperMicros);
      assert.equal(pending.requests[0].estimateSnapshot, null);
      const consent = {
        authorizationId,
        operationId: randomUUID(),
        turnFence,
        consent: true,
        policyRevision: 2,
        policyHash: digest(nextCfg),
      };
      await assert.rejects(
        next.consent(owner, campaignId, requestId, consent),
        denied(/GENERATION_POLICY_STALE/),
      );
      assert.equal(
        (await db.query('SELECT id FROM live_test_text_permits WHERE request_id=$1', [requestId]))
          .rowCount,
        0,
      );
      const permit = await next.consent(owner, campaignId, requestId, {
        ...consent,
        policyRevision: 3,
      });
      assert.equal(permit.state, 'authorized');
      assert.equal(
        await database.tx((c) => next.rejectUndispatchedRequest(c, requestId, 'SYNTHETIC_CANCEL')),
        true,
      );
    });
    await t.test(
      'owner-handle identity is not silently migrated by a profile amendment',
      async () => {
        const changedHandle = 'moved_' + owner.replaceAll('-', '').slice(0, 12);
        const changedCfg = readOwnerGenerationConfig(ownerEnvironment(nextRaw, changedHandle));
        const changed = new GenerationAuthority(database, changedCfg);
        await db.query('UPDATE users SET handle=$2 WHERE id=$1', [owner, changedHandle]);
        try {
          const view = await changed.reviewPolicy(owner);
          assert.equal(view.proposed.canApply, false);
          assert.ok(view.proposed.blockers.includes('GENERATION_OWNER_IMMUTABLE'));
          await assert.rejects(
            changed.amendPolicy(owner, body(view, changedCfg)),
            denied(/GENERATION_OWNER_IMMUTABLE/),
          );
          assert.equal(view.history.length, 3);
        } finally {
          await db.query('UPDATE users SET handle=$2 WHERE id=$1', [owner, handle]);
        }
      },
    );
    let finalAuthority = next,
      finalRaw = nextRaw,
      settledOperatorJobId;
    await t.test(
      'operator text survives JSONB order with exact consent, body snapshot and original prices',
      async () => {
        const operatorRaw = {
          ...nextRaw,
          text: {
            ...nextRaw.text,
            estimation: {
              kind: 'operator_heuristic',
              textTokensPerKiBUtf8: 1024,
              textProtocolTokens: 4096,
              marginBps: 2500,
              fixedMarginMicros: 17,
            },
          },
        };
        const operatorCfg = readOwnerGenerationConfig(ownerEnvironment(operatorRaw, handle));
        const operator = new GenerationAuthority(database, operatorCfg);
        const view = await operator.reviewPolicy(owner);
        const applied = await operator.amendPolicy(owner, body(view, operatorCfg));
        assert.equal(applied.revision, 4);
        const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider.js');
        const { GenerationProvider } = require('../../apps/api/dist/generation/provider.js');
        const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
        let calls = 0,
          dispatchedBody;
        const inner = new OpenAiNpcProvider(
          {
            enabled: true,
            apiKey: 'synthetic-only-never-a-real-key',
            model: operatorCfg.text.model,
            version: 'synthetic-jsonb-v1',
            maxInputBytes: operatorCfg.text.maxInputBytes,
            maxModelInputTokens: operatorCfg.text.contextTokens,
            maxOutputTokens: operatorCfg.text.maxOutputTokens,
            maxResponseBytes: 128000,
            inputMicrosPerMillion: operatorCfg.text.inputMicrosPerMillion,
            outputMicrosPerMillion: operatorCfg.text.outputMicrosPerMillion,
            pricing: operatorCfg.text.pricing,
            estimation: operatorCfg.text.estimation,
          },
          async (_url, options) => {
            calls++;
            dispatchedBody = options.body;
            return new Response(
              JSON.stringify({
                id: 'synthetic-jsonb-response',
                status: 'completed',
                service_tier: 'default',
                usage: { input_tokens: 50, output_tokens: 10 },
                output: [
                  {
                    type: 'message',
                    content: [
                      {
                        type: 'output_text',
                        text: JSON.stringify({ text: 'Synthetic JSONB response' }),
                      },
                    ],
                  },
                ],
              }),
            );
          },
        );
        const provider = new GenerationProvider(inner, operator);
        const engineErrors = [];
        const engineDatabase = {
          ...database,
          tx: (work) =>
            database.tx(async (c) => {
              try {
                return await work(c);
              } catch (error) {
                engineErrors.push({
                  name: error.name,
                  code: error.code ?? null,
                  constraint: error.constraint ?? null,
                  message: String(error.message).slice(0, 120),
                });
                throw error;
              }
            }),
        };
        const ai = new NpcAiEngine(engineDatabase, provider, {
          externalApproved: true,
          providerUpperMicros: operatorCfg.text.upperMicros,
          providerCapMicros: operatorCfg.totalCapMicros,
          timeoutMs: 1000,
        });
        const campaignId = randomUUID(),
          requestId = randomUUID(),
          npcId = 'jsonb-' + randomUUID();
        const turnFence = { roundId: 'jsonb-round', phaseEpoch: 7, rulesetVersion: 1 };
        const context = {
          zeta: 'last field',
          replyLocale: 'uk',
          contextHash: requestId,
          turnFence,
          alpha: { z: 'last nested', a: 'first nested' },
          mockProposal: { text: 'fixture-hidden' },
        };
        await db.query(
          "INSERT INTO game_campaigns(id,owner_id,playable_version,state) VALUES($1,$2,'synthetic',$3)",
          [
            campaignId,
            owner,
            JSON.stringify({
              turnController: {
                phase: 'world',
                roundId: turnFence.roundId,
                phaseEpoch: 7,
                ruleset: { version: 1 },
              },
            }),
          ],
        );
        await db.query(
          "INSERT INTO game_members(campaign_id,user_id,actor_id,status) VALUES($1,$2,'player','accepted')",
          [campaignId, owner],
        );
        await db.query(
          "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,requester_user_id,context,status) VALUES($1,$2,$3,'speech',$6,$4,$5,'queued')",
          [requestId, campaignId, npcId, owner, JSON.stringify(context), requestId],
        );
        const stored = (
          await db.query('SELECT context FROM game_npc_decision_requests WHERE id=$1', [requestId])
        ).rows[0].context;
        assert.notEqual(
          JSON.stringify(context),
          JSON.stringify(stored),
          'Fixture must exercise JSONB key reordering',
        );
        const prepared = inner.prepareTextRequest('speech', context);
        assert.deepEqual(inner.prepareTextRequest('speech', stored).snapshot, prepared.snapshot);
        const job = await ai.queue({
          scope: { campaignId, npcId, origin: 'system', purpose: 'speech' },
          operationId: requestId,
          context,
          runtimeRequestId: requestId,
        });
        const pending = (await operator.pending(owner, campaignId)).requests[0];
        assert.equal(pending.policyRevision, 4);
        assert.equal(pending.upperMicros, null);
        assert.equal(pending.reserveMicros, prepared.snapshot.reserveMicros);
        assert.ok(
          pending.reserveMicros < operatorCfg.text.upperMicros,
          'Request reserve should not reserve entire input capability',
        );
        const consent = {
          authorizationId,
          operationId: randomUUID(),
          turnFence,
          consent: true,
          policyRevision: 4,
          policyHash: applied.hash,
          estimateFingerprint: prepared.snapshot.fingerprint,
        };
        await assert.rejects(
          operator.consent(owner, campaignId, requestId, {
            ...consent,
            estimateFingerprint: '0'.repeat(64),
          }),
          denied(/TEXT_RESERVE_STALE/),
        );
        await operator.consent(owner, campaignId, requestId, consent);
        const permit = (
          await db.query('SELECT * FROM live_test_text_permits WHERE request_id=$1', [requestId])
        ).rows[0];
        const held = (
          await db.query('SELECT * FROM generation_budget_reservations WHERE id=$1', [
            permit.reservation_id,
          ])
        ).rows[0];
        assert.deepEqual(permit.request_snapshot, prepared.snapshot);
        assert.equal(Number(held.upper_micros), prepared.snapshot.reserveMicros);
        assert.equal(
          Number(
            (await db.query('SELECT provider_upper_micros FROM npc_ai_jobs WHERE id=$1', [job.id]))
              .rows[0].provider_upper_micros,
          ),
          prepared.snapshot.reserveMicros,
        );
        await ai.run(job.id, async () => true);
        assert.equal(calls, 1, 'Only the injected transport may execute');
        assert.equal(dispatchedBody, prepared.body);
        const settled = (
          await db.query('SELECT * FROM live_test_text_permits WHERE id=$1', [permit.id])
        ).rows[0];
        assert.equal(settled.state, 'settled');
        assert.deepEqual(settled.request_snapshot, prepared.snapshot);
        const afterOperator = await operator.reviewPolicy(owner);
        const accounting = (
          await db.query(
            'SELECT status,result_code,provider_budget_status,provider_upper_micros,provider_actual_micros FROM npc_ai_jobs WHERE id=$1',
            [job.id],
          )
        ).rows[0];
        assert.equal(
          afterOperator.dispatchEnabled,
          true,
          JSON.stringify({ blockers: afterOperator.blockers, accounting, engineErrors }),
        );
        await database.tx((c) => ai.finalize(c, job.id, 'committed'));
        settledOperatorJobId = job.id;
        finalAuthority = operator;
        finalRaw = operatorRaw;
      },
    );

    await t.test(
      'accepted text-cap increase renews the secondary cap and serializes a real job FK insert',
      async () => {
        const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
        const { GenerationProvider } = require('../../apps/api/dist/generation/provider.js');
        const { estimation: _ignored, ...fixedText } = finalRaw.text;
        const fixedRaw = {
          ...finalRaw,
          totalCapMicros: 2000000,
          textCapMicros: 1000000,
          text: {
            ...fixedText,
            model: 'synthetic-cap-text',
            contextTokens: 100000,
            maxOutputTokens: 64,
            inputMicrosPerMillion: 2000000,
            outputMicrosPerMillion: 2000000,
          },
        };
        const fixedCfg = readOwnerGenerationConfig(ownerEnvironment(fixedRaw, handle));
        const fixed = new GenerationAuthority(database, fixedCfg);
        assert.equal(
          (await fixed.amendPolicy(owner, body(await fixed.reviewPolicy(owner), fixedCfg)))
            .revision,
          5,
        );
        const campaignId = randomUUID(),
          seedRequest = randomUUID(),
          seedJob = randomUUID(),
          seedPermit = randomUUID(),
          seedReservation = randomUUID();
        const fence = { roundId: 'cap-renewal-round', phaseEpoch: 2, rulesetVersion: 1 };
        const seedContext = {
          contextHash: seedRequest,
          turnFence: fence,
          mockProposal: { actions: [{ kind: 'wait' }] },
        };
        await db.query(
          "INSERT INTO game_campaigns(id,owner_id,playable_version,state) VALUES($1,$2,'synthetic',$3)",
          [
            campaignId,
            owner,
            JSON.stringify({
              turnController: {
                phase: 'world',
                roundId: fence.roundId,
                phaseEpoch: 2,
                ruleset: { version: 1 },
              },
            }),
          ],
        );
        await db.query(
          "INSERT INTO game_members(campaign_id,user_id,actor_id,status) VALUES($1,$2,'player','accepted')",
          [campaignId, owner],
        );
        await db.query(
          "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,requester_user_id,context,status) VALUES($1,$2,'historical-cap-npc','plan',$5,$3,$4,'queued')",
          [seedRequest, campaignId, owner, JSON.stringify(seedContext), seedRequest],
        );
        // Synthetic known historic usage, linked in BOTH ledgers. No real provider is dispatched.
        await db.query(
          "INSERT INTO generation_budget_reservations(id,scope_id,actor_id,kind,operation_key,upper_micros,actual_micros,status) VALUES($1,$2,$3,'text',$4,900000,900000,'settled')",
          [seedReservation, scopeId, owner, 'synthetic-known-cap:' + seedReservation],
        );
        await db.query(
          `INSERT INTO npc_ai_jobs(id,campaign_id,npc_id,operation_id,request_hash,origin,purpose,context_hash,context,
        provider_id,provider_version,policy_version,status,credits,reservation_status,reservation_expires_at,
        provider_upper_micros,provider_budget_status,provider_actual_micros,provider_external,generation_authorization_id,request_meta)
        SELECT $1,$2,'historical-cap-npc',$3,$4,'system','plan',$4,$5,provider_id,provider_version,policy_version,
        'committed',0,'released',reservation_expires_at,900000,'spent',900000,true,$6,jsonb_build_object('runtimeRequestId',$8::text)
        FROM npc_ai_jobs WHERE id=$7`,
          [
            seedJob,
            campaignId,
            seedRequest,
            digest(seedContext),
            JSON.stringify(seedContext),
            authorizationId,
            settledOperatorJobId,
            seedRequest,
          ],
        );
        await db.query(
          "INSERT INTO live_test_text_permits(id,session_id,campaign_id,request_id,operation_id,context_hash,round_id,phase_epoch,reservation_id,state,job_id,generation_policy_revision,generation_policy_hash) VALUES($1,$2,$3,$4,$5,$6,$7,2,$8,'settled',$9,0,NULL)",
          [
            seedPermit,
            authorizationId,
            campaignId,
            seedRequest,
            randomUUID(),
            digest(seedContext),
            fence.roundId,
            seedReservation,
            seedJob,
          ],
        );
        await db.query(
          "UPDATE npc_ai_provider_budgets SET cap_micros=1000000,spent_micros=spent_micros+900000 WHERE provider_id='openai-responses'",
        );
        const before = (
          await db.query(
            "SELECT * FROM npc_ai_provider_budgets WHERE provider_id='openai-responses'",
          )
        ).rows[0];
        assert.ok(Number(before.spent_micros) >= 900000);
        assert.equal((await fixed.reviewPolicy(owner)).dispatchEnabled, true);
        const raisedRaw = { ...fixedRaw, totalCapMicros: 3000000, textCapMicros: 2000000 };
        const raisedCfg = readOwnerGenerationConfig(ownerEnvironment(raisedRaw, handle));
        const raised = new GenerationAuthority(database, raisedCfg);
        let calls = 0;
        const inner = {
          id: 'openai-responses',
          version: 'synthetic-cap-v1',
          external: true,
          generate: async () => {
            calls++;
            throw Error('No dispatch is authorized in queue regression');
          },
        };
        const context = {
          contextHash: randomUUID(),
          turnFence: fence,
          mockProposal: { actions: [{ kind: 'wait' }] },
        };
        const operationId = randomUUID();
        const queueInput = {
          scope: { campaignId, npcId: 'cap-queue-npc', origin: 'system', purpose: 'plan' },
          operationId,
          context,
        };
        const queueReady = gate(),
          releaseInsert = gate();
        const queueDatabase = {
          ...database,
          tx: (work) =>
            database.tx(async (c) => {
              await c.query("SET LOCAL lock_timeout='3s'");
              return work({
                query: async (sql, args) => {
                  if (sql.includes('INSERT INTO npc_ai_jobs(')) {
                    queueReady.release();
                    await releaseInsert.reached;
                  }
                  return c.query(sql, args);
                },
              });
            }),
        };
        const engine = new NpcAiEngine(queueDatabase, new GenerationProvider(inner, raised), {
          externalApproved: true,
          providerUpperMicros: raisedCfg.text.upperMicros,
          providerCapMicros: raisedCfg.totalCapMicros,
        });
        await assert.rejects(engine.queue(queueInput), denied(/CONSENT_REQUIRED|POLICY_CHANGED/));
        assert.equal(
          (
            await db.query(
              "SELECT cap_micros FROM npc_ai_provider_budgets WHERE provider_id='openai-responses'",
            )
          ).rows[0].cap_micros,
          before.cap_micros,
        );
        assert.equal(
          (await db.query('SELECT id FROM npc_ai_jobs WHERE operation_id=$1', [operationId]))
            .rowCount,
          0,
        );
        const accepted = await raised.amendPolicy(
          owner,
          body(await raised.reviewPolicy(owner), raisedCfg),
        );
        assert.equal(accepted.revision, 6);
        const oldEngine = new NpcAiEngine(database, new GenerationProvider(inner, fixed), {
          externalApproved: true,
          providerUpperMicros: fixedCfg.text.upperMicros,
          providerCapMicros: fixedCfg.totalCapMicros,
        });
        const staleOperation = randomUUID();
        await assert.rejects(
          oldEngine.queue({ ...queueInput, operationId: staleOperation }),
          denied(/CONSENT_REQUIRED|POLICY_CHANGED/),
        );
        assert.equal(
          (await db.query('SELECT id FROM npc_ai_jobs WHERE operation_id=$1', [staleOperation]))
            .rowCount,
          0,
        );
        assert.ok(
          Number(before.spent_micros) + raisedCfg.text.upperMicros > Number(before.cap_micros),
        );
        assert.ok(
          Number(before.spent_micros) + raisedCfg.text.upperMicros < raisedCfg.textCapMicros,
        );
        const queued = engine.queue(queueInput).then(
          (job) => ({ job }),
          (error) => ({ error }),
        );
        let amendment;
        try {
          await Promise.race([
            queueReady.reached,
            queued.then((result) =>
              assert.fail('Queue finished before real INSERT: ' + String(errorCode(result.error))),
            ),
          ]);
          const amendmentAttempted = gate();
          const candidateCfg = readOwnerGenerationConfig(
            ownerEnvironment(
              { ...raisedRaw, totalCapMicros: 3200000, textCapMicros: 2200000 },
              handle,
            ),
          );
          const amendmentDatabase = {
            ...database,
            tx: (work) =>
              database.tx(async (c) => {
                await c.query("SET LOCAL lock_timeout='3s'");
                return work({
                  query: async (sql, args) => {
                    if (
                      sql.includes('pg_advisory_xact_lock') &&
                      args?.[0] === 'generation-scope-admission'
                    )
                      amendmentAttempted.release();
                    return c.query(sql, args);
                  },
                });
              }),
          };
          const candidate = new GenerationAuthority(amendmentDatabase, candidateCfg);
          amendment = candidate
            .amendPolicy(owner, body(await candidate.reviewPolicy(owner), candidateCfg))
            .then(
              (value) => ({ value }),
              (error) => ({ error }),
            );
          await Promise.race([
            amendmentAttempted.reached,
            amendment.then((result) =>
              assert.fail(
                'Amendment finished before admission: ' + String(errorCode(result.error)),
              ),
            ),
          ]);
          // The amendment owns its authorization lock and waits on the queue's common fence.
          // The real INSERT below must obtain the FK KEY SHARE without a lock cycle.
        } finally {
          releaseInsert.release();
        }
        const queueResult = await queued;
        const result = await amendment;
        assert.equal(queueResult.error, undefined, String(errorCode(queueResult.error)));
        const job = queueResult.job;
        assert.match(String(errorCode(result.error)), /GENERATION_POLICY_BUSY/);
        const after = (
          await db.query(
            "SELECT * FROM npc_ai_provider_budgets WHERE provider_id='openai-responses'",
          )
        ).rows[0];
        assert.equal(Number(after.cap_micros), 2000000);
        assert.equal(after.spent_micros, before.spent_micros);
        assert.equal(after.unknown_micros, before.unknown_micros);
        assert.equal(after.blocked, before.blocked);
        assert.equal(
          Number(after.reserved_micros),
          Number(before.reserved_micros) + raisedCfg.text.upperMicros,
        );
        assert.equal(calls, 0);
        await database.tx((c) => engine.finalize(c, job.id, 'cancelled'));
        finalAuthority = raised;
        finalRaw = raisedRaw;
        assert.equal((await raised.reviewPolicy(owner)).active.revision, 6);
      },
    );
    await t.test('unknown/403 and late known usage never unlock higher limits', async () => {
      const id = await database.tx(async (c) => {
        const rights = await finalAuthority.authorizeImage(c, owner, authorizationId);
        return reserveGenerationSpend(
          c,
          { ...rights, verifiedUpperMicros: 10000 },
          owner,
          'image',
          'revision-unknown:' + randomUUID(),
          10000,
        );
      });
      await database.tx((c) =>
        finalAuthority.settleLiveSpend(c, authorizationId, id, null, 'PROVIDER_HTTP_403'),
      );
      const higherCfg = readOwnerGenerationConfig(
        ownerEnvironment(
          { ...finalRaw, totalCapMicros: 4000000, textCapMicros: 3000000, imageCapMicros: 1000000 },
          handle,
        ),
      );
      const higher = new GenerationAuthority(database, higherCfg);
      const view = await higher.reviewPolicy(owner);
      assert.equal(view.proposed.canApply, false);
      assert.ok(view.proposed.blockers.includes('LIVE_SESSION_STOPPED'));
      await assert.rejects(
        higher.amendPolicy(owner, body(view, higherCfg)),
        denied(/LIVE_SESSION_STOPPED/),
      );
      await database.tx((c) =>
        finalAuthority.settleLiveSpend(c, authorizationId, id, 5000, 'LATE_KNOWN_USAGE'),
      );
      const after = await higher.reviewPolicy(owner);
      assert.ok(after.liabilities.spentMicros >= 185000);
      assert.equal(after.liabilities.heldMicros, 0);
      assert.equal(after.dispatchEnabled, false);
      assert.equal(after.proposed.canApply, false);
      const row = (
        await db.query('SELECT state,stop_code FROM live_test_sessions WHERE id=$1', [
          authorizationId,
        ])
      ).rows[0];
      assert.equal(row.state, 'stopped');
      assert.equal(row.stop_code, 'PROVIDER_HTTP_403');
      assert.equal(after.history.length, 6);
    });
    await db.end();
  },
);
