/** Disposable PostgreSQL fixtures using real admission/accounting and synthetic
 * providers. Never rewrites receipts, provider usage, policy or historical consent. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { GenerationAuthority } = require('../../apps/api/dist/generation/service.js');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
const { ReleaseGenerationProvider } = require('../../apps/api/dist/generation/release-provider.js');
const { AuthoringTextEngine } = require('../../apps/api/dist/live-test/authoring-text.js');
const { estimateTextRequest } = require('../../apps/api/dist/generation/estimates.js');
const { textUsageCostMicros } = require('../../apps/api/dist/generation/text-pricing.js');
const { canonical, digest } = require('../../apps/api/dist/ai/context.js');
const { KnownNpcSettlement } = require('../../apps/api/dist/game/known-npc-settlement.js');
const {
  KnownAuthoringSettlement,
} = require('../../apps/api/dist/live-test/known-authoring-settlement.js');
const { Auth } = require('../../apps/api/dist/auth.js');

/** Caller supplies its existing funded actor and active reviewed release deployment.
 * Returns four source identities and a repeatable financial/source snapshot reader.
 * Call before creating the separate image uncertainty epoch to be recovered. */
export async function prepareMixedTerminalLiabilities({ db, database, who, configured }) {
  assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^game-test-/);
  assert.equal(configured.mode, 'release');
  assert.ok(configured.text.counting, 'Mixed fixture needs the reviewed fixed-count profile');
  const scopeId = `release:${who.id}`;
  const authority = new GenerationAuthority(database, configured);
  const calls = { count: 0, permit: 0, npc: 0, authoring: 0 };
  const campaigns = [];
  const requests = [];
  const sourceIds = {};
  const holdIds = [];
  async function campaign(purpose) {
    const campaignId = randomUUID(),
      requestId = randomUUID();
    const fence = { roundId: `mixed-${requestId}`, phaseEpoch: 1, rulesetVersion: 1 };
    const state = {
      turnController: {
        phase: 'world',
        roundId: fence.roundId,
        phaseEpoch: 1,
        ruleset: { version: 1 },
      },
    };
    const context = {
      contextHash: requestId,
      turnFence: fence,
      replyLocale: 'en',
      history: [{ id: 'synthetic-history', text: 'An empty synthetic room.' }],
      mockProposal: { actions: [{ kind: 'wait' }] },
    };
    await db.query(
      "INSERT INTO game_campaigns(id,owner_id,playable_version,state) VALUES($1,$2,'synthetic',$3)",
      [campaignId, who.id, JSON.stringify(state)],
    );
    await db.query(
      "INSERT INTO game_members(campaign_id,user_id,actor_id,status) VALUES($1,$2,'player','accepted')",
      [campaignId, who.id],
    );
    await db.query(
      "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,requester_user_id,context,status) VALUES($1,$2,'keeper',$3,$1::uuid::text,$4,$5,'queued')",
      [requestId, campaignId, purpose, who.id, JSON.stringify(context)],
    );
    campaigns.push(campaignId);
    requests.push(requestId);
    return { campaignId, requestId, fence, state, context };
  }
  // Exact late count closes its admitted bill but never adopts stale tokens.
  const counted = await campaign('speech');
  let started, finish;
  const dispatched = new Promise((resolve) => {
    started = resolve;
  });
  const response = new Promise((resolve) => {
    finish = resolve;
  });
  authority.configureTextCountAdapter({
    version: 'synthetic-mixed-count-v1',
    countBody: (purpose, context) => JSON.stringify({ purpose, candidate: context }),
    async count() {
      calls.count++;
      started();
      await response;
      return 100;
    },
  });
  const pendingCount = (await authority.pending(who.id, counted.campaignId)).requests.find(
    (r) => r.id === counted.requestId,
  );
  assert.ok(pendingCount?.counting);
  const countOperation = randomUUID();
  const countWork = authority.preflightCount(who.id, counted.campaignId, counted.requestId, {
    operationId: countOperation,
    turnFence: counted.fence,
    policyRevision: pendingCount.policyRevision,
    policyHash: pendingCount.policyHash,
    candidateFingerprint: pendingCount.counting.candidateFingerprint,
    consent: true,
    automaticKnownCostPolicy: 'known-cost-v1',
  });
  await Promise.race([
    dispatched,
    countWork.then(() => assert.fail('Synthetic count did not dispatch')),
  ]);
  counted.state.turnController.phaseEpoch++;
  await db.query('UPDATE game_campaigns SET state=$2 WHERE id=$1', [
    counted.campaignId,
    JSON.stringify(counted.state),
  ]);
  finish();
  assert.equal((await countWork).status, 'stale');
  const count = (
    await db.query('SELECT * FROM generation_text_counts WHERE operation_id=$1', [countOperation])
  ).rows[0];
  sourceIds.count = count.id;
  holdIds.push(count.spark_quote_id);

  for (const source of ['permit', 'npc']) {
    const prepared = await campaign('plan');
    const inner = {
      id: `synthetic-mixed-${source}`,
      version: 'synthetic-mixed-v1',
      external: true,
      prepareTextRequest(purpose, context) {
        const body = JSON.stringify(canonical({ purpose, context }));
        return { body, snapshot: estimateTextRequest(body, configured.text, this.version) };
      },
      async generate() {
        calls[source]++;
        const usage = { inputTokens: 100, outputTokens: 10 };
        return {
          requestId: `synthetic-${prepared.requestId}`,
          proposal: prepared.context.mockProposal,
          usage: {
            ...usage,
            ...textUsageCostMicros(configured.text, usage),
            costEvidence: 'configured_rates',
          },
        };
      },
    };
    const grants = new GenerationAuthority(database, configured);
    const ai = new NpcAiEngine(database, new ReleaseGenerationProvider(inner, grants), {
      externalApproved: true,
      creditPrice: 0,
      providerUpperMicros: configured.text.upperMicros,
      providerCapMicros: configured.aggregateCapMicros,
      version: 'synthetic-mixed-v1',
    });
    const scope = {
      campaignId: prepared.campaignId,
      npcId: 'keeper',
      origin: source === 'permit' ? 'system' : 'user',
      requesterUserId: who.id,
      purpose: 'plan',
    };
    let quote, permit;
    if (source === 'permit') {
      const pending = (await grants.pending(who.id, prepared.campaignId)).requests.find(
        (r) => r.id === prepared.requestId,
      );
      permit = await grants.consent(who.id, prepared.campaignId, prepared.requestId, {
        operationId: randomUUID(),
        turnFence: prepared.fence,
        policyRevision: pending.policyRevision,
        policyHash: pending.policyHash,
        estimateFingerprint: pending.estimateSnapshot.fingerprint,
        consent: true,
        automaticKnownCostPolicy: 'known-cost-v1',
      });
    } else quote = await ai.quote(scope, prepared.context, who.id);
    const job = await ai.queue({
      scope,
      operationId: randomUUID(),
      context: prepared.context,
      runtimeRequestId: prepared.requestId,
      ...(source === 'npc'
        ? { quoteId: quote.id, consent: true, automaticKnownCostPolicy: 'known-cost-v1' }
        : {}),
    });
    await ai.run(job.id, async () => true);
    await database.tx((c) => ai.finalize(c, job.id, 'stale'));
    const saved = (await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [job.id])).rows[0];
    assert.equal(
      saved.status,
      'stale',
      JSON.stringify({ source, status: saved.status, code: saved.result_code }),
    );
    assert.equal(saved.provider_budget_status, 'spent');
    if (permit) {
      const row = (await db.query('SELECT * FROM live_test_text_permits WHERE id=$1', [permit.id]))
        .rows[0];
      sourceIds.permit = row.id;
      holdIds.push(row.spark_quote_id);
    } else {
      sourceIds.npc = saved.id;
      holdIds.push(saved.spark_hold_id);
    }
  }

  const projectId = randomUUID(),
    sourceHash = digest('synthetic mixed source'),
    readsetHash = digest('synthetic mixed readset');
  await db.query(
    "INSERT INTO visual_authoring_projects(id,owner_id,kind,brief,source_hash,status) VALUES($1,$2,'location',$3,$4,'concept')",
    [projectId, who.id, JSON.stringify({ name: 'Synthetic mixed authoring' }), sourceHash],
  );
  const provider = {
    version: 'synthetic-mixed-authoring-v1',
    profile: configured.text,
    prepareTextRequest(context) {
      const body = JSON.stringify(context);
      return { body, snapshot: estimateTextRequest(body, configured.text, this.version) };
    },
    async generate() {
      calls.authoring++;
      const usage = { inputTokens: 100, outputTokens: 10 };
      return {
        proposal: { title: 'Unapplied synthetic plan' },
        requestId: `synthetic-${randomUUID()}`,
        usage: {
          ...usage,
          ...textUsageCostMicros(configured.text, usage),
          costEvidence: 'configured_rates',
        },
      };
    },
  };
  const authoring = new AuthoringTextEngine(database, authority, provider, {
    version: 'synthetic-mixed-v1',
    purpose: 'story_plan',
    schema: {},
    instructions: 'Synthetic only',
    validateProposal: (p) => p,
  });
  const guard = async (c, b) => {
    assert.equal(b.projectId, projectId);
    const row = (
      await c.query('SELECT owner_id,source_hash FROM visual_authoring_projects WHERE id=$1', [
        b.projectId,
      ])
    ).rows[0];
    assert.equal(row.owner_id, who.id);
    assert.equal(row.source_hash, sourceHash);
  };
  const quote = await authoring.quote(
    who.id,
    {
      operationId: randomUUID(),
      projectId,
      projectRevision: 1,
      sourceHash,
      readsetHash,
      context: { synthetic: true },
    },
    guard,
  );
  const queued = await authoring.enqueue(
    who.id,
    {
      operationId: randomUUID(),
      quoteId: quote.id,
      consent: true,
      automaticKnownCostPolicy: quote.automaticKnownCostPolicy,
    },
    guard,
  );
  await authoring.run(who.id, queued.id, guard, async () => {
    throw new Error('MAP_IMAGE_UNCERTAIN');
  });
  const authored = (
    await db.query('SELECT * FROM live_authoring_text_jobs WHERE id=$1', [queued.id])
  ).rows[0];
  assert.equal(authored.status, 'stale');
  sourceIds.authoring = authored.id;
  holdIds.push(authored.spark_quote_id);
  assert.deepEqual(calls, { count: 1, permit: 1, npc: 1, authoring: 1 });
  assert.equal(new Set(holdIds).size, 4);
  // Reconstruct the normal recovery workers, rather than manufacture terminal holds.
  await new KnownNpcSettlement(database, new Auth(database), authority).recoverPending();
  await authority.recoverKnownText();
  await new KnownAuthoringSettlement(database, authority).recoverPending();
  const holds = (
    await db.query('SELECT * FROM spark_holds WHERE id=ANY($1::uuid[]) ORDER BY id', [holdIds])
  ).rows;
  assert.equal(holds.length, 4);
  assert.ok(
    holds.every((h) => h.status === 'settled'),
    JSON.stringify(holds.map((h) => ({ kind: h.source_kind, status: h.status, reason: h.reason }))),
  );
  const reservations = (
    await db.query(
      'SELECT * FROM generation_budget_reservations WHERE spark_quote_id=ANY($1::uuid[]) ORDER BY id',
      [holdIds],
    )
  ).rows;
  assert.equal(reservations.length, 4);
  assert.ok(reservations.every((r) => r.scope_id === scopeId && r.status === 'settled'));
  const snapshot = async () => ({
    counts: (await db.query('SELECT * FROM generation_text_counts WHERE id=$1', [sourceIds.count]))
      .rows,
    permits: (
      await db.query('SELECT * FROM live_test_text_permits WHERE id=$1', [sourceIds.permit])
    ).rows,
    npcJobs: (
      await db.query(
        'SELECT * FROM npc_ai_jobs WHERE generation_authorization_id IN (SELECT id FROM live_test_sessions WHERE scope_id=$1) ORDER BY id',
        [scopeId],
      )
    ).rows,
    authoring: (
      await db.query('SELECT * FROM live_authoring_text_jobs WHERE id=$1', [sourceIds.authoring])
    ).rows,
    campaigns: (
      await db.query('SELECT * FROM game_campaigns WHERE id=ANY($1::uuid[]) ORDER BY id', [
        campaigns,
      ])
    ).rows,
    requests: (
      await db.query(
        'SELECT * FROM game_npc_decision_requests WHERE id=ANY($1::uuid[]) ORDER BY id',
        [requests],
      )
    ).rows,
    project: (await db.query('SELECT * FROM visual_authoring_projects WHERE id=$1', [projectId]))
      .rows,
    holds: (
      await db.query('SELECT * FROM spark_holds WHERE id=ANY($1::uuid[]) ORDER BY id', [holdIds])
    ).rows,
    quotes: (
      await db.query('SELECT * FROM spark_quotes WHERE id=ANY($1::uuid[]) ORDER BY id', [holdIds])
    ).rows,
    ledger: (
      await db.query('SELECT * FROM spark_ledger WHERE hold_id=ANY($1::uuid[]) ORDER BY id', [
        holdIds,
      ])
    ).rows,
    reservations: (
      await db.query(
        'SELECT * FROM generation_budget_reservations WHERE spark_quote_id=ANY($1::uuid[]) ORDER BY id',
        [holdIds],
      )
    ).rows,
  });
  return { sourceIds, holdIds, scopeId, calls, snapshot, readSnapshot: snapshot };
}
