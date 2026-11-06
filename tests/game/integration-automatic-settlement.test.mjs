/** Disposable PostgreSQL, real accounting, synthetic providers only. Never production history. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db } from './support-runtime.mjs';
import { requestEstimateOwnerProfile } from '../images/owner-config-fixture.mjs';
const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db.js');
const { activateReleaseDeployment } = require('../images/release-deployment-fixture.cjs');
const { readGenerationConfig } = require('../../apps/api/dist/generation/config.js');
const { GenerationAuthority } = require('../../apps/api/dist/generation/service.js');
const { ImageGenerationEngine } = require('../../apps/api/dist/image-generation/service.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const { createOwnerImageRuntime } = require('../../apps/api/dist/image-generation/config.js');
const sources = (process.env.AUTOMATIC_SETTLEMENT_SOURCES ?? 'image,count,npc,permit').split(',');
assert.ok(sources.length && sources.every((s) => ['image', 'count', 'npc', 'permit'].includes(s)));
const { canonical } = require('../../apps/api/dist/ai/context.js');
const database = new Db();
const profile = requestEstimateOwnerProfile();
profile.text.contextBudgetTokens = 64000;
profile.text.counting = {
  kind: 'owner_reviewed_fixed',
  microsPerRequest: 7,
  pricing: { ...profile.text.pricing },
};
const configured = readGenerationConfig({
  GENERATION_MODE: 'release',
  GENERATION_CONFIG_JSON: JSON.stringify({ ...profile, aggregateCapMicros: 10000000 }),
});
const authority = new GenerationAuthority(database, configured);
const runtime = createOwnerImageRuntime(configured, {
  resolveApiKey: () => assert.fail('No real credentials permitted'),
  fetchImpl: () => assert.fail('No network provider transport permitted'),
});
const png = await require('sharp')({
  create: { width: 1536, height: 1024, channels: 4, background: '#486078' },
})
  .png()
  .toBuffer();
async function actor() {
  const id = randomUUID(),
    adventureId = randomUUID();
  const handle = `auto_${id.replaceAll('-', '').slice(0, 16)}`;
  await db.query(
    "INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,'not-a-login-hash','Synthetic automatic settlement',$3)",
    [id, `${handle}@example.test`, handle],
  );
  await db.query(
    'INSERT INTO spark_wallets(owner_id,enabled,balance_subunits) VALUES($1,true,1000000)',
    [id],
  );
  await db.query(
    "INSERT INTO adventures(id,owner_id,slug,title,genre,data) VALUES($1,$2,$3,'Synthetic settlement','fantasy','{}')",
    [adventureId, id, handle],
  );
  return { id, adventureId };
}
function engine(provider) {
  const instance = new ImageGenerationEngine(
    database,
    new AssetReuseService(database),
    provider,
    runtime.policy,
    runtime.capabilities,
  );
  instance.setLiveAuthorizer((c, u, id, input) => authority.authorizeImage(c, u, id, input));
  instance.setReleaseResultAuthorizer((...args) => authority.authorizeReleaseResult(...args));
  return instance;
}
function input(who, marked) {
  return {
    adventureId: who.adventureId,
    prompt: 'Synthetic empty room',
    title: 'Synthetic settlement',
    kind: 'background',
    camera: 'top-down',
    tags: [],
    background: 'opaque',
    referenceRevisionIds: [],
    mode: 'external',
    declineReuse: true,
    ...(marked ? { automaticKnownCostPolicy: 'known-cost-v1' } : {}),
    rights: {
      basis: 'generated',
      licenseLabel: 'Synthetic fixture',
      attribution: '',
      allowAuthorReuse: false,
      attested: true,
    },
  };
}
async function finances(ownerId, holdId) {
  return {
    wallet: (await db.query('SELECT * FROM spark_wallets WHERE owner_id=$1', [ownerId])).rows[0],
    hold: (await db.query('SELECT * FROM spark_holds WHERE id=$1', [holdId])).rows[0],
    ledger: (
      await db.query('SELECT * FROM spark_ledger WHERE hold_id=$1 ORDER BY event_key', [holdId])
    ).rows,
  };
}
async function imageScenario(kind) {
  const who = await actor();
  const mixed = kind === 'mixed-rollback';
  if (mixed)
    await db.query(
      'INSERT INTO dream_wallets(owner_id,enabled,balance_subunits) VALUES($1,true,100)',
      [who.id],
    );
  const dreamFinances = async () => ({
    wallet: (await db.query('SELECT * FROM dream_wallets WHERE owner_id=$1', [who.id])).rows[0],
    holds: (await db.query('SELECT * FROM dream_holds WHERE owner_id=$1 ORDER BY id', [who.id]))
      .rows,
    ledger: (
      await db.query('SELECT * FROM dream_ledger WHERE owner_id=$1 ORDER BY event_key', [who.id])
    ).rows,
  });
  let calls = 0,
    release,
    signal;
  const started = new Promise((resolve) => {
    signal = resolve;
  });
  const deferred = new Promise((resolve) => {
    release = resolve;
  });
  const provider = {
    id: runtime.provider.id,
    async generate() {
      calls++;
      signal();
      return deferred;
    },
  };
  const images = engine(provider);
  const accepted = [
    'accepted',
    'generated-cancel',
    'admission-rejection',
    'mixed-rollback',
  ].includes(kind);
  // Stop at the generated boundary to exercise cancellation of a stored receipt.
  if (kind === 'generated-cancel' || mixed) images.admit = async () => {};
  const marked = kind !== 'historical';
  const q = await images.quote(who.id, input(who, marked));
  const body = {
    quoteId: q.quote.id,
    operationId: randomUUID(),
    consent: true,
    estimateRiskConsent: true,
  };
  if (marked) {
    assert.equal(q.quote.automaticKnownCostSettlement.version, 'known-cost-v1');
    // A newly marked quote cannot silently authorize an old client.
    await assert.rejects(images.enqueue(who.id, body), (e) =>
      /IMAGE_SETTLEMENT_POLICY/.test(e.getResponse?.().code),
    );
    assert.equal(
      (
        await db.query('SELECT count(*)::int n FROM image_generation_jobs WHERE quote_id=$1', [
          q.quote.id,
        ])
      ).rows[0].n,
      0,
    );
    body.automaticKnownCostPolicyHash = q.quote.automaticKnownCostSettlement.fingerprint;
  } else assert.equal(q.quote.automaticKnownCostSettlement, undefined);
  const job = await images.enqueue(who.id, body);
  const initial = (await db.query('SELECT * FROM image_generation_jobs WHERE id=$1', [job.id]))
    .rows[0];
  const native = (
    await db.query('SELECT * FROM image_generation_quotes WHERE id=$1', [initial.quote_id])
  ).rows[0];
  const sparkQuote = (
    await db.query('SELECT * FROM spark_quotes WHERE id=$1', [initial.spark_quote_id])
  ).rows[0];
  assert.equal(native.input.automaticKnownCostPolicy, marked ? 'known-cost-v1' : undefined);
  assert.equal(
    sparkQuote.price_snapshot.providerQuote.automaticKnownCostPolicyHash,
    body.automaticKnownCostPolicyHash,
  );
  const work = images.workOnce();
  await Promise.race([started, work.then(() => assert.fail('Synthetic dispatch did not start'))]);
  if (!['generated-cancel', 'admission-rejection', 'mixed-rollback'].includes(kind))
    await images.cancel(who.id, job.id);
  const actual = kind === 'overrun' ? Number(initial.upper_micros) + 1 : 100;
  const receipt = {
    bytes:
      kind === 'admission-rejection'
        ? await require('sharp')(png).resize(64, 64).png().toBuffer()
        : png,
    mime: 'image/png',
    requestId: `synthetic-${job.id}`,
    ...(kind === 'unknown' ? {} : { actualMicros: actual }),
    costVerifiedForSparks: kind !== 'unverified',
  };
  release(receipt);
  await work;
  if (mixed) {
    const held = await finances(who.id, initial.spark_quote_id);
    const dreamHeld = await dreamFinances();
    assert.equal(held.hold.status, 'held');
    assert.equal(dreamHeld.holds[0].reserved_subunits, '100');
    assert.equal(
      held.hold.sparks_reserved_subunits,
      String(BigInt(held.hold.reserved_subunits) - 100n),
    );
    const { DreamsAccounting } = require('../../apps/api/dist/generation/dreams-accounting.js');
    const original = DreamsAccounting.prototype.settle;
    let injected = 0;
    DreamsAccounting.prototype.settle = async function (
      c,
      actorId,
      holdId,
      settlement,
      reconciliation,
    ) {
      const result = await original.call(this, c, actorId, holdId, settlement, reconciliation);
      if (actorId === who.id && settlement.outcome === 'success') {
        injected++;
        assert.equal(
          (await c.query('SELECT captured_subunits FROM dream_holds WHERE id=$1', [holdId])).rows[0]
            .captured_subunits,
          '100',
        );
        assert.equal(
          (
            await c.query(
              "SELECT count(*)::int n FROM dream_ledger WHERE hold_id=$1 AND kind='capture'",
              [holdId],
            )
          ).rows[0].n,
          1,
        );
        // Fail after the nested wallet/ledger writes, before outer Sparks writes.
        throw new Error('SYNTHETIC_AFTER_DREAMS_SETTLEMENT');
      }
      return result;
    };
    try {
      await assert.rejects(images.cancel(who.id, job.id), /SYNTHETIC_AFTER_DREAMS_SETTLEMENT/);
    } finally {
      DreamsAccounting.prototype.settle = original;
    }
    assert.equal(injected, 1);
    assert.deepEqual(await finances(who.id, initial.spark_quote_id), held);
    assert.deepEqual(await dreamFinances(), dreamHeld);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM audit WHERE target_id=$1 AND action='image.known_result.settled'",
          [job.id],
        )
      ).rows[0].n,
      0,
    );
    const noDispatch = {
      id: runtime.provider.id,
      generate: () => assert.fail('Recovery must not regenerate'),
    };
    await engine(noDispatch).maintenance();
    const dreamSettled = await dreamFinances();
    assert.equal(dreamSettled.wallet.balance_subunits, '0');
    assert.equal(dreamSettled.wallet.held_subunits, '0');
    assert.equal(dreamSettled.holds[0].status, 'settled');
    assert.deepEqual(
      dreamSettled.ledger
        .filter((r) => ['capture', 'release'].includes(r.kind))
        .map((r) => [r.kind, r.amount_subunits]),
      [
        ['capture', '100'],
        ['release', '0'],
      ],
    );
    await Promise.all([engine(noDispatch).maintenance(), engine(noDispatch).maintenance()]);
    assert.deepEqual(await dreamFinances(), dreamSettled);
  }
  if (kind === 'generated-cancel') {
    assert.equal(
      (await db.query('SELECT status FROM image_generation_jobs WHERE id=$1', [job.id])).rows[0]
        .status,
      'generated',
    );
    assert.equal((await finances(who.id, initial.spark_quote_id)).hold.status, 'held');
    await images.cancel(who.id, job.id);
  }
  if (kind === 'admission-rejection')
    assert.equal(
      (await db.query('SELECT status FROM image_generation_jobs WHERE id=$1', [job.id])).rows[0]
        .status,
      'rejected',
    );
  assert.equal(calls, 1);
  const before = await finances(who.id, initial.spark_quote_id);
  const source = (await db.query('SELECT * FROM image_generation_jobs WHERE id=$1', [job.id]))
    .rows[0];
  const adventure = (await db.query('SELECT * FROM adventures WHERE id=$1', [who.adventureId]))
    .rows[0];
  const scope = (
    await db.query('SELECT * FROM generation_budget_scopes WHERE id=$1', [`release:${who.id}`])
  ).rows[0];
  if (accepted) {
    assert.equal(before.hold.status, 'settled');
    assert.equal(before.hold.captured_subunits, '200');
    assert.equal(before.wallet.balance_subunits, mixed ? '999900' : '999800');
    assert.equal(before.wallet.held_subunits, '0');
    assert.deepEqual(
      before.ledger
        .filter((r) => ['capture', 'release'].includes(r.kind))
        .map((r) => [r.kind, r.amount_subunits]),
      [
        ['capture', mixed ? '100' : '200'],
        ['release', String(BigInt(before.hold.reserved_subunits) - 200n)],
      ],
    );
  } else {
    assert.equal(before.hold.status, 'pending');
    assert.equal(before.hold.captured_subunits, null);
    assert.equal(before.wallet.balance_subunits, '1000000');
    assert.equal(before.wallet.held_subunits, before.hold.reserved_subunits);
    assert.equal(before.ledger.filter((r) => ['capture', 'release'].includes(r.kind)).length, 0);
  }
  // Independent reconstructed workers recover concurrently, never call a provider.
  const noDispatch = {
    id: runtime.provider.id,
    generate: () => assert.fail('Recovery must not regenerate'),
  };
  await Promise.all([engine(noDispatch).maintenance(), engine(noDispatch).maintenance()]);
  await images.recordResult(job.id, receipt);
  await engine(noDispatch).maintenance();
  assert.deepEqual(await finances(who.id, initial.spark_quote_id), before);
  assert.deepEqual(
    (await db.query('SELECT * FROM image_generation_quotes WHERE id=$1', [initial.quote_id]))
      .rows[0],
    native,
  );
  assert.deepEqual(
    (await db.query('SELECT * FROM spark_quotes WHERE id=$1', [initial.spark_quote_id])).rows[0],
    sparkQuote,
  );
  // Unknown receipt replay can refresh its timestamp, but cannot fabricate a cost or asset.
  const after = (await db.query('SELECT * FROM image_generation_jobs WHERE id=$1', [job.id]))
    .rows[0];
  for (const key of ['status', 'actual_micros', 'admitted_revision_id', 'spark_cost_verified'])
    assert.deepEqual(after[key], source[key]);
  assert.equal(after.admitted_revision_id, null);
  assert.deepEqual(
    (await db.query('SELECT * FROM adventures WHERE id=$1', [who.adventureId])).rows[0],
    adventure,
  );
  assert.deepEqual(
    (await db.query('SELECT * FROM generation_budget_scopes WHERE id=$1', [`release:${who.id}`]))
      .rows[0],
    scope,
  );
  assert.equal(
    (
      await db.query('SELECT count(*)::int n FROM image_generation_attempts WHERE job_id=$1', [
        job.id,
      ])
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM audit WHERE target_id=$1 AND action='image.known_result.settled'",
        [job.id],
      )
    ).rows[0].n,
    accepted ? 1 : 0,
  );
  assert.equal(calls, 1);
}
async function countScenario(accepted) {
  const who = await actor(),
    campaignId = randomUUID(),
    requestId = randomUUID();
  const fence = { roundId: 'synthetic-count-round', phaseEpoch: 1, rulesetVersion: 1 };
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
    history: [{ id: 'synthetic-history', text: 'A synthetic room.' }],
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
    "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,requester_user_id,context,status) VALUES($1,$2,'keeper','speech',$1::uuid::text,$3,$4,'queued')",
    [requestId, campaignId, who.id, JSON.stringify(context)],
  );
  const counts = new GenerationAuthority(database, configured);
  let release,
    signal,
    calls = 0;
  const started = new Promise((resolve) => {
    signal = resolve;
  });
  const delayed = new Promise((resolve) => {
    release = resolve;
  });
  counts.configureTextCountAdapter({
    version: 'synthetic-count-v1',
    countBody: (purpose, candidate) => JSON.stringify({ purpose, candidate }),
    async count() {
      calls++;
      signal();
      await delayed;
      return 100;
    },
  });
  const pending = (await counts.pending(who.id, campaignId)).requests.find(
    (r) => r.id === requestId,
  );
  const body = {
    operationId: randomUUID(),
    turnFence: fence,
    policyRevision: pending.policyRevision,
    policyHash: pending.policyHash,
    candidateFingerprint: pending.counting.candidateFingerprint,
    consent: true,
    ...(accepted ? { automaticKnownCostPolicy: 'known-cost-v1' } : {}),
  };
  const work = counts.preflightCount(who.id, campaignId, requestId, body);
  await Promise.race([started, work.then(() => assert.fail('Synthetic dispatch did not start'))]);
  // A real source fence changes while the synthetic counting response is in flight.
  state.turnController.phaseEpoch++;
  await db.query('UPDATE game_campaigns SET state=$2 WHERE id=$1', [
    campaignId,
    JSON.stringify(state),
  ]);
  const unchangedCampaign = (
    await db.query('SELECT * FROM game_campaigns WHERE id=$1', [campaignId])
  ).rows[0];
  const unchangedRequest = (
    await db.query('SELECT * FROM game_npc_decision_requests WHERE id=$1', [requestId])
  ).rows[0];
  release();
  const result = await work;
  assert.equal(result.status, 'stale');
  const row = (
    await db.query('SELECT * FROM generation_text_counts WHERE operation_id=$1', [body.operationId])
  ).rows[0];
  const quote = (await db.query('SELECT * FROM spark_quotes WHERE id=$1', [row.spark_quote_id]))
    .rows[0];
  assert.deepEqual(
    quote.price_snapshot.providerQuote.automaticKnownCostAcceptance,
    accepted ? { policy: 'known-cost-v1', requestHash: row.request_hash } : undefined,
  );
  const snapshot = await finances(who.id, row.spark_quote_id);
  assert.equal(snapshot.hold.status, accepted ? 'settled' : 'pending');
  assert.equal(snapshot.wallet.balance_subunits, accepted ? '999986' : '1000000');
  assert.equal(snapshot.wallet.held_subunits, accepted ? '0' : '14');
  assert.deepEqual(
    snapshot.ledger
      .filter((r) => ['capture', 'release'].includes(r.kind))
      .map((r) => [r.kind, r.amount_subunits]),
    accepted
      ? [
          ['capture', '14'],
          ['release', '0'],
        ]
      : [],
  );
  await Promise.all([
    new GenerationAuthority(database, configured).recoverKnownText(),
    new GenerationAuthority(database, configured).recoverKnownText(),
  ]);
  assert.deepEqual(await counts.preflightCount(who.id, campaignId, requestId, body), result);
  assert.deepEqual(await finances(who.id, row.spark_quote_id), snapshot);
  assert.deepEqual(
    (await db.query('SELECT * FROM generation_text_counts WHERE id=$1', [row.id])).rows[0],
    row,
  );
  assert.deepEqual(
    (await db.query('SELECT * FROM game_campaigns WHERE id=$1', [campaignId])).rows[0],
    unchangedCampaign,
  );
  assert.deepEqual(
    (await db.query('SELECT * FROM game_npc_decision_requests WHERE id=$1', [requestId])).rows[0],
    unchangedRequest,
  );
  assert.equal(calls, 1);
}
async function npcScenario(source, accepted) {
  const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
  const {
    ReleaseGenerationProvider,
  } = require('../../apps/api/dist/generation/release-provider.js');
  const { KnownNpcSettlement } = require('../../apps/api/dist/game/known-npc-settlement.js');
  const { Auth } = require('../../apps/api/dist/auth.js');
  const { estimateTextRequest } = require('../../apps/api/dist/generation/estimates.js');
  const who = await actor(),
    campaignId = randomUUID(),
    requestId = randomUUID();
  const fence = { roundId: 'synthetic-npc-round', phaseEpoch: 1, rulesetVersion: 1 };
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
    "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,requester_user_id,context,status) VALUES($1,$2,'keeper','plan',$1::uuid::text,$3,$4,'queued')",
    [requestId, campaignId, who.id, JSON.stringify(context)],
  );
  const grants = new GenerationAuthority(database, configured);
  let calls = 0;
  const inner = {
    id: `synthetic-${source}-${accepted}`,
    version: 'synthetic-settlement-v1',
    external: true,
    prepareTextRequest(purpose, candidate) {
      const body = JSON.stringify(canonical({ purpose, context: candidate }));
      return { body, snapshot: estimateTextRequest(body, configured.text, this.version) };
    },
    async generate() {
      calls++;
      return {
        requestId: `synthetic-${requestId}`,
        proposal: context.mockProposal,
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          costMicros: 120,
          costEvidence: 'configured_rates',
          costVerifiedForSparks: true,
        },
      };
    },
  };
  const ai = new NpcAiEngine(database, new ReleaseGenerationProvider(inner, grants), {
    externalApproved: true,
    creditPrice: 0,
    providerUpperMicros: configured.text.upperMicros,
    providerCapMicros: configured.aggregateCapMicros,
    version: 'synthetic-settlement-v1',
  });
  const scope = {
    campaignId,
    npcId: 'keeper',
    origin: source === 'permit' ? 'system' : 'user',
    requesterUserId: who.id,
    purpose: 'plan',
  };
  let quote, permit;
  if (source === 'permit') {
    const pending = (await grants.pending(who.id, campaignId)).requests.find(
      (r) => r.id === requestId,
    );
    permit = await grants.consent(who.id, campaignId, requestId, {
      operationId: randomUUID(),
      turnFence: fence,
      policyRevision: pending.policyRevision,
      policyHash: pending.policyHash,
      estimateFingerprint: pending.estimateSnapshot.fingerprint,
      consent: true,
      ...(accepted ? { automaticKnownCostPolicy: 'known-cost-v1' } : {}),
    });
  } else quote = await ai.quote(scope, context, who.id);
  const job = await ai.queue({
    scope,
    operationId: randomUUID(),
    context,
    runtimeRequestId: requestId,
    ...(source === 'npc'
      ? {
          quoteId: quote.id,
          consent: true,
          ...(accepted ? { automaticKnownCostPolicy: 'known-cost-v1' } : {}),
        }
      : {}),
  });
  await ai.run(job.id, async () => true);
  await database.tx((c) => ai.finalize(c, job.id, 'stale'));
  const savedJob = (await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [job.id])).rows[0];
  assert.equal(
    savedJob.status,
    'stale',
    `Unexpected synthetic job state: ${savedJob.error_code ?? savedJob.result_code ?? savedJob.status}`,
  );
  assert.equal(savedJob.provider_actual_micros, '120');
  assert.equal(calls, 1);
  const savedPermit =
    source === 'permit'
      ? (await db.query('SELECT * FROM live_test_text_permits WHERE id=$1', [permit.id])).rows[0]
      : null;
  const holdId = savedPermit?.spark_quote_id ?? savedJob.spark_hold_id;
  const savedQuote = (await db.query('SELECT * FROM spark_quotes WHERE id=$1', [holdId])).rows[0];
  if (source === 'npc')
    assert.equal(
      savedJob.request_meta.automaticKnownCostPolicy,
      accepted ? 'known-cost-v1' : undefined,
    );
  else
    assert.equal(
      savedQuote.price_snapshot.providerQuote.automaticKnownCostAcceptance?.policy,
      accepted ? 'known-cost-v1' : undefined,
    );
  const campaign = (await db.query('SELECT * FROM game_campaigns WHERE id=$1', [campaignId]))
    .rows[0];
  const request = (
    await db.query('SELECT * FROM game_npc_decision_requests WHERE id=$1', [requestId])
  ).rows[0];
  const recover = () =>
    source === 'npc'
      ? new KnownNpcSettlement(database, new Auth(database), grants).recoverPending()
      : new GenerationAuthority(database, configured).recoverKnownText();
  await Promise.all([recover(), recover()]);
  const settled = await finances(who.id, holdId);
  assert.equal(settled.hold.status, accepted ? 'settled' : 'pending');
  assert.equal(settled.wallet.balance_subunits, accepted ? '999760' : '1000000');
  assert.equal(settled.wallet.held_subunits, accepted ? '0' : settled.hold.reserved_subunits);
  if (source === 'npc') {
    const reader = new KnownNpcSettlement(
      database,
      { require: async () => ({ id: who.id }) },
      grants,
    );
    if (accepted) {
      const view = await reader.handle({}, campaignId, job.id);
      assert.equal(view.status, 'settled');
      assert.equal(view.settlementMode, 'automatic');
    } else {
      await assert.rejects(reader.handle({}, campaignId, job.id), /NPC_SETTLEMENT_UNAVAILABLE/);
    }
  }

  assert.deepEqual(
    settled.ledger
      .filter((r) => ['capture', 'release'].includes(r.kind))
      .map((r) => [r.kind, r.amount_subunits]),
    accepted
      ? [
          ['capture', '240'],
          ['release', String(BigInt(settled.hold.reserved_subunits) - 240n)],
        ]
      : [],
  );
  await recover();
  assert.deepEqual(await finances(who.id, holdId), settled);
  assert.deepEqual(
    (await db.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [job.id])).rows[0],
    savedJob,
  );
  assert.deepEqual(
    (await db.query('SELECT * FROM game_campaigns WHERE id=$1', [campaignId])).rows[0],
    campaign,
  );
  assert.deepEqual(
    (await db.query('SELECT * FROM game_npc_decision_requests WHERE id=$1', [requestId])).rows[0],
    request,
  );
  assert.deepEqual(
    (await db.query('SELECT * FROM spark_quotes WHERE id=$1', [holdId])).rows[0],
    savedQuote,
  );
  if (savedPermit)
    assert.deepEqual(
      (await db.query('SELECT * FROM live_test_text_permits WHERE id=$1', [permit.id])).rows[0],
      savedPermit,
    );
  assert.equal(calls, 1);
}
await test(
  'explicit automatic settlement retains conservative source authority in PostgreSQL',
  { timeout: 120000 },
  async (t) => {
    try {
      assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^game-test-/);
      await database.tx((c) => activateReleaseDeployment(c, configured));
      for (const kind of sources.includes('image')
        ? (
            process.env.AUTOMATIC_SETTLEMENT_IMAGE_CASES ??
            'accepted,historical,unverified,unknown,overrun,generated-cancel,admission-rejection,mixed-rollback'
          ).split(',')
        : []) {
        await t.test(
          `native image ${kind}: exact accounting, concurrent recovery and reconstructed worker replay`,
          () => imageScenario(kind),
        );
      }
      for (const accepted of sources.includes('count')
        ? process.env.AUTOMATIC_SETTLEMENT_COUNT_CASES === 'accepted'
          ? [true]
          : [true, false]
        : [])
        await t.test(
          `stale count ${accepted ? 'explicit acceptance' : 'old-client omission'} persists proof and never changes game state`,
          () => countScenario(accepted),
        );
      for (const source of ['npc', 'permit'].filter((s) => sources.includes(s)))
        for (const accepted of [true, false])
          await t.test(
            `${source} ${accepted ? 'accepted' : 'old-client'} failed bill: exact accounting without game effect`,
            () => npcScenario(source, accepted),
          );
    } finally {
      await database.pool.end();
      await db.end();
    }
  },
);
