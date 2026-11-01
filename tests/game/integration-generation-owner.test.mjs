/** Disposable PostgreSQL; only synthetic profiles/providers. Never loads a credential or live transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { db } from './support-runtime.mjs';
const require = createRequire(import.meta.url);
const { GenerationAuthority } = require('../../apps/api/dist/generation/service.js');
const { readOwnerGenerationConfig } = require('../../apps/api/dist/generation/config.js');
const { LiveTestService } = require('../../apps/api/dist/live-test/service.js');
const { LIVE_TEXT } = require('../../apps/api/dist/live-test/config.js');
const { ManualLiveProvider } = require('../../apps/api/dist/live-test/provider.js');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
const { ProviderFailure } = require('../../apps/api/dist/ai/types.js');
const { digest } = require('../../apps/api/dist/ai/context.js');
const {
  reserveGenerationSpend,
  settleGenerationSpend,
} = require('../../apps/api/dist/image-generation/budget.js');
const { defaultImagePolicy } = require('../../apps/api/dist/image-generation/contracts.js');
const scopeId = LIVE_TEXT.scopeId;
const database = {
  query: async (sql, values = []) => (await db.query(sql, values)).rows,
  tx: async (work) => {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const value = await work(c);
      await c.query('COMMIT');
      return value;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  },
};
function profile(ownerHandle, changes = {}) {
  const pricing = {
    source: 'https://developers.openai.com/test-only-owner-fixture',
    reviewedAt: '2026-01-01T00:00:00.000Z',
    validUntil: '2099-01-01T00:00:00.000Z',
  };
  const raw = {
    totalCapMicros: 600000,
    textCapMicros: 400000,
    imageCapMicros: 400000,
    text: {
      model: 'synthetic-text-fixture',
      contextTokens: 100000,
      maxOutputTokens: 64,
      maxInputBytes: 64000,
      inputMicrosPerMillion: 1000000,
      outputMicrosPerMillion: 1000000,
      pricing,
    },
    image: {
      model: 'synthetic-image-fixture',
      size: '1024x1024',
      quality: 'low',
      outputs: 1,
      format: 'png',
      maxPromptUtf8Bytes: 8000,
      maxReferenceImages: 0,
      inputTextMicrosPerMillion: 1000000,
      inputImageMicrosPerMillion: 1000000,
      outputImageMicrosPerMillion: 1000000,
      estimatedTotalMicros: 50000,
      reserveMicros: 100000,
      estimateRiskAccepted: true,
      pricing,
    },
  };
  const configured = {
    ...raw,
    ...changes,
    text: { ...raw.text, ...changes.text },
    image: { ...raw.image, ...changes.image },
  };
  // Explicit synthetic object, never process.env or a credential source.
  return readOwnerGenerationConfig({
    GENERATION_MODE: 'owner',
    GENERATION_OWNER_HANDLE: ownerHandle,
    GENERATION_OWNER_CONFIG_JSON: JSON.stringify(configured),
  });
}
const codeOf = (error) => error?.getResponse?.()?.code ?? error?.code ?? error?.message;
const denied = (pattern) => (error) => {
  assert.match(String(codeOf(error)), pattern);
  return true;
};
function gate() {
  let release;
  const reached = new Promise((resolve) => {
    release = resolve;
  });
  return { reached, release };
}
/** Real transactions; the only synthetic hook pauses immediately before COMMIT. */
function admissionBarrier(holdCommit, target = 'scope') {
  const ready = gate(),
    attempted = gate(),
    release = gate();
  return {
    ready: ready.reached,
    attempted: attempted.reached,
    release: release.release,
    database: {
      query: database.query,
      tx: (work) =>
        database.tx(async (c) => {
          // SQL lock failures are test failures, never an accepted race outcome.
          await c.query("SET LOCAL lock_timeout='8s'");
          const pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          let scopeLocked = false,
            admissionLocked = false;
          const observed = {
            query: async (sql, values) => {
              const admission =
                sql.includes('pg_advisory_xact_lock') &&
                values?.[0] === 'generation-scope-admission';
              if (admission) {
                assert.equal(
                  scopeLocked,
                  true,
                  'target financial row must be locked before shared admission',
                );
                attempted.release(pid);
              }
              const result = await c.query(sql, values);
              const targetQuery =
                target === 'scope'
                  ? /FROM generation_budget_scopes WHERE id=\$1 FOR UPDATE/
                  : /FROM npc_ai_provider_budgets WHERE provider_id=\$1 FOR UPDATE/;
              if (targetQuery.test(sql)) {
                assert.equal(result.rowCount, 1, 'financial row must exist and actually be locked');
                scopeLocked = true;
              }
              if (admission) admissionLocked = true;
              return result;
            },
          };
          const value = await work(observed);
          assert.equal(admissionLocked, true, 'both admission paths must acquire the shared fence');
          ready.release(pid);
          if (holdCommit) await release.reached;
          return value;
        }),
    },
  };
}
function outcome(promise) {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );
}
async function beforeFinished(event, finished, label) {
  return Promise.race([
    event,
    finished.then((result) => {
      assert.fail(
        `${label} finished before its barrier (${result.status}: ${codeOf(result.reason)})`,
      );
    }),
  ]);
}
async function assertAdvisoryBlocked(waiter, blocker) {
  const deadline = Date.now() + 5000;
  do {
    const row = (
      await db.query(
        'SELECT wait_event_type,wait_event,$2::int=ANY(pg_blocking_pids(pid)) AS blocked_by_winner FROM pg_stat_activity WHERE pid=$1',
        [waiter, blocker],
      )
    ).rows[0];
    if (row?.wait_event_type === 'Lock' && row.wait_event === 'advisory' && row.blocked_by_winner)
      return;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail('loser never reached the PostgreSQL advisory wait on the uncommitted winner');
}
async function fixture(run) {
  assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^game-test-/);
  assert.equal(
    (await db.query('SELECT id FROM generation_budget_scopes WHERE id=$1', [scopeId])).rowCount,
    0,
    'Do not erase or reuse another grant at the trusted financial scope',
  );
  const owner = randomUUID(),
    other = randomUUID(),
    campaignId = randomUUID();
  const handle = `owner_${owner.replaceAll('-', '').slice(0, 12)}`;
  const otherHandle = `other_${other.replaceAll('-', '').slice(0, 12)}`;
  for (const [id, userHandle] of [
    [owner, handle],
    [other, otherHandle],
  ])
    await db.query('INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,$3,$4,$5)', [
      id,
      `${id}@example.test`,
      'synthetic-no-login',
      'Owner generation fixture',
      userHandle,
    ]);
  const config = profile(handle),
    authority = new GenerationAuthority(database, config);
  const fence = { roundId: `owner-round-${randomUUID()}`, phaseEpoch: 2, rulesetVersion: 1 };
  const state = {
    turnController: {
      phase: 'world',
      roundId: fence.roundId,
      phaseEpoch: 2,
      ruleset: { version: 1 },
    },
  };
  await db.query(
    "INSERT INTO game_campaigns(id,owner_id,playable_version,state) VALUES($1,$2,'synthetic',$3)",
    [campaignId, owner, JSON.stringify(state)],
  );
  await db.query(
    "INSERT INTO game_members(campaign_id,user_id,actor_id,status) VALUES($1,$2,'player','accepted')",
    [campaignId, owner],
  );
  const requests = new Set(),
    operations = new Set(),
    ownedScopes = new Set([scopeId]),
    explicitReservations = new Set(),
    ownedProviders = new Set();
  let authorizationId;
  async function request() {
    const id = randomUUID(),
      npcId = `npc-${id}`;
    const context = {
      contextHash: id,
      turnFence: fence,
      mockProposal: { actions: [{ kind: 'wait' }] },
    };
    await db.query(
      "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,requester_user_id,context,status) VALUES($1,$2,$3,'plan',$6,$4,$5,'queued')",
      [id, campaignId, npcId, owner, JSON.stringify(context), id],
    );
    requests.add(id);
    operations.add(`manual-text:${id}`);
    operations.add(`generation-text:${id}`);
    return { id, context, npcId };
  }
  async function claim(service = authority) {
    const status = await service.claim(owner, { consent: true });
    authorizationId = status.authorizationId;
    assert.match(authorizationId, /^[0-9a-f-]{36}$/);
    assert.equal(
      status.sessionId,
      authorizationId,
      'legacy response alias does not mint another grant',
    );
    return status;
  }
  function consentInput(extra = {}) {
    return {
      authorizationId,
      operationId: randomUUID(),
      turnFence: fence,
      consent: true,
      ...extra,
    };
  }
  async function imageReserve(service = authority, amount = config.image.reserveMicros) {
    const operation = `owner-image-fixture:${randomUUID()}`;
    operations.add(operation);
    const id = await database.tx(async (c) => {
      const policy = await service.authorizeImage(c, owner, authorizationId);
      return reserveGenerationSpend(
        c,
        {
          ...policy,
          costBasis: 'approved_estimate',
          operationalReserveMicros: amount,
          verifiedUpperMicros: null,
        },
        owner,
        'image',
        operation,
        amount,
      );
    });
    explicitReservations.add(id);
    return id;
  }
  async function legacyReservation({
    scope = scopeId,
    actor = owner,
    status = 'settled',
    upper = 100000,
    actual = 50000,
    blocked = false,
    approved = true,
    totalCap = 1000000,
    textCap = 1000000,
    imageCap = 1000000,
  } = {}) {
    ownedScopes.add(scope);
    await db.query(
      'INSERT INTO generation_budget_scopes(id,approved,total_cap_micros,image_cap_micros,text_cap_micros,blocked) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
      [scope, approved, totalCap, imageCap, textCap, blocked],
    );
    const id = randomUUID(),
      operation = `owner-legacy-fixture:${id}`;
    operations.add(operation);
    explicitReservations.add(id);
    await db.query(
      "INSERT INTO generation_budget_reservations(id,scope_id,actor_id,kind,operation_key,upper_micros,actual_micros,status) VALUES($1,$2,$3,'text',$4,$5,$6,$7)",
      [id, scope, actor, operation, upper, status === 'settled' ? actual : null, status],
    );
    return id;
  }
  async function externalReservation({
    scope = scopeId,
    actor = owner,
    policy = {
      ...defaultImagePolicy,
      scopeId: scope,
      externalEnabled: true,
      approved: true,
      verifiedUpperMicros: 1000,
      totalCapMicros: config.totalCapMicros,
      textCapMicros: config.textCapMicros,
      imageCapMicros: config.imageCapMicros,
    },
    transaction = database.tx,
  } = {}) {
    ownedScopes.add(policy.scopeId);
    const operation = `owner-admission-fixture:${randomUUID()}`;
    operations.add(operation);
    const id = await transaction((c) =>
      reserveGenerationSpend(c, policy, actor, 'text', operation, 1000, false),
    );
    explicitReservations.add(id);
    return id;
  }
  function engine(service = authority, outcome = 'success') {
    let calls = 0;
    const inner = {
      id: `synthetic-owner-${randomUUID()}`,
      version: 'synthetic-owner-v1',
      external: true,
      generate: async (r) => {
        calls++;
        if (outcome === '403')
          throw new ProviderFailure('PROVIDER_HTTP_403', true, 'synthetic-403');
        if (outcome === 'unknown') throw new Error('synthetic transport outcome unknown');
        return {
          requestId: `synthetic-${calls}`,
          proposal: r.context.mockProposal,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            costMicros: 5000,
            costEvidence: 'configured_rates',
          },
        };
      },
    };
    ownedProviders.add(inner.id);
    const ai = new NpcAiEngine(database, new ManualLiveProvider(inner, service), {
      externalApproved: true,
      providerUpperMicros: config.text.upperMicros,
      providerCapMicros: config.totalCapMicros,
      timeoutMs: 1000,
    });
    return {
      ai,
      calls: () => calls,
      queue: (r) =>
        ai.queue({
          scope: { campaignId, npcId: r.npcId, origin: 'system', purpose: 'plan' },
          operationId: r.id,
          context: r.context,
          runtimeRequestId: r.id,
        }),
    };
  }
  async function legacyEngine({
    outcome = 'success',
    mock = false,
    engineDatabase = database,
  } = {}) {
    let calls = 0;
    const provider = {
      id: `${mock ? 'synthetic-local' : 'synthetic-legacy'}-${randomUUID()}`,
      version: mock ? 'mock-v1' : 'synthetic-legacy-v1',
      external: !mock,
      generate: async (request) => {
        calls++;
        if (outcome === 'unknown') throw new Error('synthetic legacy outcome unknown');
        return {
          requestId: `synthetic-legacy-receipt-${calls}`,
          proposal: request.context.mockProposal,
          usage: { inputTokens: 0, outputTokens: 0, costMicros: mock ? 0 : 5000 },
        };
      },
    };
    assert.equal(
      (
        await db.query('SELECT provider_id FROM npc_ai_provider_budgets WHERE provider_id=$1', [
          provider.id,
        ])
      ).rowCount,
      0,
      'never adopt another test provider budget',
    );
    ownedProviders.add(provider.id);
    const ai = new NpcAiEngine(engineDatabase, provider, {
      externalApproved: true,
      providerUpperMicros: mock ? 0 : 10000,
      providerCapMicros: mock ? 0 : 1000000,
      timeoutMs: 1000,
    });
    return {
      ai,
      providerId: provider.id,
      calls: () => calls,
      queue: (request) =>
        ai.queue({
          scope: { campaignId, npcId: request.npcId, origin: 'system', purpose: 'plan' },
          operationId: request.id,
          context: request.context,
          runtimeRequestId: request.id,
        }),
    };
  }
  try {
    await run({
      owner,
      other,
      handle,
      otherHandle,
      campaignId,
      config,
      authority,
      fence,
      state,
      request,
      claim,
      consentInput,
      imageReserve,
      legacyReservation,
      externalReservation,
      engine,
      legacyEngine,
      authorizationId: () => authorizationId,
    });
  } finally {
    // Verify every row before cleanup. Never delete, reset or unblock unrelated test histories.
    const scopes = [...ownedScopes];
    const grants = (
      await db.query(
        'SELECT id,owner_id,scope_id FROM live_test_sessions WHERE scope_id=ANY($1::text[])',
        [scopes],
      )
    ).rows;
    for (const grant of grants)
      assert.ok([owner, other].includes(grant.owner_id), 'cleanup refuses an unrelated owner');
    const reservations = (
      await db.query(
        'SELECT id,actor_id,operation_key FROM generation_budget_reservations WHERE scope_id=ANY($1::text[])',
        [scopes],
      )
    ).rows;
    for (const row of reservations) {
      assert.ok(
        [owner, other].includes(row.actor_id) ||
          (row.actor_id === null && explicitReservations.has(row.id)),
        'cleanup refuses an unrelated actor',
      );
      assert.ok(
        explicitReservations.has(row.id) || operations.has(row.operation_key),
        'cleanup refuses unrecognized financial evidence',
      );
    }
    const grantIds = grants.map((row) => row.id);
    const permits = (
      await db.query(
        'SELECT id,request_id FROM live_test_text_permits WHERE session_id=ANY($1::uuid[])',
        [grantIds],
      )
    ).rows;
    for (const permit of permits)
      assert.ok(requests.has(permit.request_id), 'cleanup refuses an unrelated permit');
    const providers = [...ownedProviders];
    const jobs = (
      await db.query(
        'SELECT id,campaign_id,request_meta FROM npc_ai_jobs WHERE provider_id=ANY($1::text[])',
        [providers],
      )
    ).rows;
    for (const job of jobs) {
      assert.equal(job.campaign_id, campaignId, 'cleanup refuses an unrelated provider job');
      assert.ok(
        requests.has(job.request_meta.runtimeRequestId),
        'cleanup requires an exact fixture request',
      );
    }
    const linkedRequests = (
      await db.query(
        'SELECT id,campaign_id FROM game_npc_decision_requests WHERE job_id=ANY($1::uuid[])',
        [jobs.map((job) => job.id)],
      )
    ).rows;
    for (const request of linkedRequests) {
      assert.equal(request.campaign_id, campaignId);
      assert.ok(
        requests.has(request.id),
        'cleanup refuses another request linked to a fixture job',
      );
    }
    const caches = (
      await db.query(
        'SELECT cache_key,campaign_id FROM npc_ai_cache WHERE provider_id=ANY($1::text[])',
        [providers],
      )
    ).rows;
    for (const cached of caches) assert.equal(cached.campaign_id, campaignId);
    await db.query('DELETE FROM live_test_text_permits WHERE id=ANY($1::uuid[])', [
      permits.map((row) => row.id),
    ]);
    await db.query(
      'DELETE FROM game_npc_decision_requests WHERE id=ANY($1::uuid[]) AND campaign_id=$2',
      [[...requests], campaignId],
    );
    await db.query('DELETE FROM npc_ai_reconciliation WHERE job_id=ANY($1::uuid[])', [
      jobs.map((job) => job.id),
    ]);
    await db.query('DELETE FROM npc_ai_cache WHERE cache_key=ANY($1::text[])', [
      caches.map((cached) => cached.cache_key),
    ]);
    await db.query('DELETE FROM npc_ai_jobs WHERE id=ANY($1::uuid[]) AND campaign_id=$2', [
      jobs.map((job) => job.id),
      campaignId,
    ]);
    await db.query('DELETE FROM npc_ai_provider_budgets WHERE provider_id=ANY($1::text[])', [
      providers,
    ]);
    await db.query(
      'DELETE FROM live_test_sessions WHERE id=ANY($1::uuid[]) AND owner_id=ANY($2::uuid[])',
      [grantIds, [owner, other]],
    );
    await db.query(
      'DELETE FROM generation_budget_reservations WHERE id=ANY($1::uuid[]) AND (actor_id=ANY($2::uuid[]) OR actor_id IS NULL)',
      [reservations.map((row) => row.id), [owner, other]],
    );
    await db.query(
      'DELETE FROM generation_budget_scopes WHERE id=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM generation_budget_reservations r WHERE r.scope_id=generation_budget_scopes.id) AND NOT EXISTS(SELECT 1 FROM live_test_sessions s WHERE s.scope_id=generation_budget_scopes.id)',
      [scopes],
    );
  }
}

await test(
  'owner authorization stays finite and explicit without a temporary test-session clock',
  { timeout: 60000 },
  async (t) => {
    try {
      await t.test(
        'owner identity and explicit claim are required before wrapped enqueue, with no implicit budgets or calls',
        async () =>
          fixture(async (f) => {
            await assert.rejects(f.authority.requireOwner(f.other), denied(/FORBIDDEN/));
            await assert.rejects(
              f.authority.claim(f.other, { consent: true }),
              denied(/FORBIDDEN/),
            );
            await assert.rejects(f.authority.claim(f.owner, { consent: false }));
            const status = await f.authority.status(f.owner);
            assert.equal(status.state, 'unclaimed');
            const r = await f.request(),
              runner = f.engine();
            await assert.rejects(runner.queue(r), denied(/^GENERATION_CONSENT_REQUIRED$/));
            assert.equal(runner.calls(), 0);
            assert.equal(
              (await db.query('SELECT id FROM npc_ai_jobs WHERE campaign_id=$1', [f.campaignId]))
                .rowCount,
              0,
            );
            assert.equal(
              (
                await db.query(
                  'SELECT provider_id FROM npc_ai_provider_budgets WHERE provider_id=$1',
                  [runner.ai.provider.id],
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (await db.query('SELECT id FROM live_test_sessions WHERE scope_id=$1', [scopeId]))
                .rowCount,
              0,
            );
            assert.equal(
              (
                await db.query('SELECT id FROM generation_budget_reservations WHERE scope_id=$1', [
                  scopeId,
                ])
              ).rowCount,
              0,
            );
            assert.equal(
              (await db.query('SELECT id FROM live_test_text_permits WHERE request_id=$1', [r.id]))
                .rowCount,
              0,
            );
            const explicit = await f.claim();
            assert.equal(explicit.state, 'active');
            assert.equal(explicit.usedMicros, 0);
            assert.equal(explicit.heldMicros, 0);
            assert.equal(runner.calls(), 0);
          }),
      );

      await t.test(
        'explicit claim has a stable DB identity across restart, no expiry, and independent per-request consent',
        async () =>
          fixture(async (f) => {
            const first = await f.claim();
            assert.equal(first.mode, 'owner');
            assert.equal(first.expiresAt, null);
            assert.equal(first.capMicros, f.config.totalCapMicros);
            const id = f.authorizationId();
            const restarted = new GenerationAuthority(database, profile(f.handle));
            assert.equal((await restarted.claim(f.owner, { consent: true })).authorizationId, id);
            await db.query(
              "UPDATE live_test_sessions SET created_at=now()-interval '30 days' WHERE id=$1",
              [id],
            );
            const oldClock = Date.now;
            try {
              Date.now = () => oldClock() + 24 * 3600000;
              assert.equal((await restarted.status(f.owner)).state, 'active');
              assert.equal((await restarted.claim(f.owner, { consent: true })).authorizationId, id);
            } finally {
              Date.now = oldClock;
            }
            const stored = (
              await db.query(
                'SELECT mode,expires_at,config_hash FROM live_test_sessions WHERE id=$1',
                [id],
              )
            ).rows[0];
            assert.equal(stored.mode, 'owner');
            assert.equal(stored.expires_at, null);
            assert.equal(stored.config_hash, digest(f.config));
            const r = await f.request(),
              runner = f.engine(restarted),
              job = await runner.queue(r);
            const prepared = (
              await db.query(
                'SELECT provider_external,generation_authorization_id,status,started_at FROM npc_ai_jobs WHERE id=$1',
                [job.id],
              )
            ).rows[0];
            assert.deepEqual(prepared, {
              provider_external: true,
              generation_authorization_id: id,
              status: 'reserved',
              started_at: null,
            });
            await runner.ai.run(job.id, async () => true);
            assert.equal(runner.calls(), 0);
            await assert.rejects(
              restarted.consent(f.owner, f.campaignId, r.id, f.consentInput({ consent: false })),
            );
            await assert.rejects(
              restarted.consent(
                f.owner,
                f.campaignId,
                r.id,
                f.consentInput({ authorizationId: randomUUID() }),
              ),
              denied(/FORBIDDEN|AUTHORIZATION|SESSION/),
            );
            assert.equal((await restarted.status(f.owner)).heldMicros, 0);
            const consent = f.consentInput(),
              permit = await restarted.consent(f.owner, f.campaignId, r.id, consent);
            assert.equal(
              (await restarted.consent(f.owner, f.campaignId, r.id, consent)).id,
              permit.id,
            );
            await runner.ai.run(job.id, async () => true);
            await runner.ai.run(job.id, async () => true);
            assert.equal(runner.calls(), 1);
            assert.equal((await restarted.status(f.owner)).usedMicros, 5000);
            assert.equal((await restarted.status(f.owner)).heldMicros, 0);
            assert.equal(
              (await db.query('SELECT id FROM live_test_sessions WHERE scope_id=$1', [scopeId]))
                .rowCount,
              1,
            );
          }),
      );

      await t.test(
        'text and image consent race for one shared outstanding reservation, not independent allowances',
        async () =>
          fixture(async (f) => {
            await f.claim();
            const r = await f.request();
            const results = await Promise.allSettled([
              f.authority.consent(f.owner, f.campaignId, r.id, f.consentInput()),
              f.imageReserve(),
            ]);
            assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
            assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
            assert.match(
              String(codeOf(results.find((r) => r.status === 'rejected').reason)),
              /GENERATION_OUTSTANDING/,
            );
            const status = await f.authority.status(f.owner);
            assert.ok(
              [f.config.text.upperMicros, f.config.image.reserveMicros].includes(status.heldMicros),
            );
            if (results[0].status === 'fulfilled')
              await f.authority.complete(results[0].value.id, 0, 'SYNTHETIC_UNDISPATCHED');
            else await database.tx((c) => settleGenerationSpend(c, results[1].value, 0));
            assert.equal((await f.authority.status(f.owner)).heldMicros, 0);
          }),
      );

      await t.test(
        'changed caps, model, owner, fingerprint or manual mode never remints or resets a claimed ledger',
        async () =>
          fixture(async (f) => {
            await f.claim();
            const image = await f.imageReserve();
            await database.tx((c) => settleGenerationSpend(c, image, 12345));
            const before = (
              await db.query('SELECT * FROM live_test_sessions WHERE scope_id=$1', [scopeId])
            ).rows;
            const ledgers = (
              await db.query(
                'SELECT * FROM generation_budget_reservations WHERE scope_id=$1 ORDER BY id',
                [scopeId],
              )
            ).rows;
            for (const cfg of [
              profile(f.handle, { totalCapMicros: 700000 }),
              profile(f.handle, { textCapMicros: 500000 }),
              profile(f.handle, { imageCapMicros: 500000 }),
              profile(f.handle, { text: { model: 'synthetic-other-text' } }),
              profile(f.handle, { image: { model: 'synthetic-other-image' } }),
              profile(f.otherHandle),
              { ...f.config, configFingerprint: 'f'.repeat(64) },
            ]) {
              const changed = new GenerationAuthority(database, cfg);
              await assert.rejects(
                changed.claim(cfg.ownerHandle === f.otherHandle ? f.other : f.owner, {
                  consent: true,
                }),
                denied(/IMMUTABLE|CONFIG|OWNER|SCOPE/),
              );
              assert.deepEqual(
                (await db.query('SELECT * FROM live_test_sessions WHERE scope_id=$1', [scopeId]))
                  .rows,
                before,
              );
              assert.deepEqual(
                (
                  await db.query(
                    'SELECT * FROM generation_budget_reservations WHERE scope_id=$1 ORDER BY id',
                    [scopeId],
                  )
                ).rows,
                ledgers,
              );
            }
            assert.throws(
              () =>
                new GenerationAuthority(database, {
                  ...f.config,
                  scopeId: `forbidden-${randomUUID()}`,
                }),
              denied(/SCOPE_IMMUTABLE/),
            );
            assert.equal(
              (await db.query('SELECT id FROM generation_budget_scopes WHERE id=$1', [scopeId]))
                .rowCount,
              1,
            );
            const legacy = new LiveTestService(database, {
              enabled: true,
              ownerId: f.owner,
              sessionId: randomUUID(),
              expiresAt: new Date(Date.now() + 3600000),
            });
            await assert.rejects(
              legacy.claim(f.owner, { consent: true }),
              denied(/IMMUTABLE|MODE|SCOPE/),
            );
            assert.equal((await f.authority.status(f.owner)).usedMicros, 12345);
            assert.equal(
              (
                await new GenerationAuthority(database, profile(f.handle)).claim(f.owner, {
                  consent: true,
                })
              ).authorizationId,
              f.authorizationId(),
            );
          }),
      );

      for (const outcome of ['403', 'unknown'])
        await t.test(
          `${outcome} fake provider outcome holds liability, stops the grant, and cannot restart or retry`,
          async () =>
            fixture(async (f) => {
              await f.claim();
              const r = await f.request(),
                runner = f.engine(f.authority, outcome),
                job = await runner.queue(r);
              await f.authority.consent(f.owner, f.campaignId, r.id, f.consentInput());
              await runner.ai.run(job.id, async () => true);
              await runner.ai.run(job.id, async () => true);
              assert.equal(runner.calls(), 1);
              const status = await f.authority.status(f.owner);
              assert.equal(status.state, 'stopped');
              assert.equal(status.heldMicros, f.config.text.upperMicros);
              assert.match(status.stopCode, outcome === '403' ? /403/ : /UNKNOWN/);
              const restart = new GenerationAuthority(database, profile(f.handle));
              const next = await f.request();
              await assert.rejects(
                restart.consent(f.owner, f.campaignId, next.id, f.consentInput()),
                denied(/STOPPED|BLOCKED|UNRESOLVED/),
              );
              const claim = await restart.claim(f.owner, { consent: true }).catch((error) => {
                assert.match(String(codeOf(error)), /STOPPED|BLOCKED|UNRESOLVED/);
                return null;
              });
              if (claim) {
                assert.equal(claim.state, 'stopped');
                assert.equal(claim.authorizationId, f.authorizationId());
              }
              assert.equal(
                (await db.query('SELECT id FROM live_test_sessions WHERE scope_id=$1', [scopeId]))
                  .rowCount,
                1,
              );
              assert.equal(
                (
                  await db.query(
                    'SELECT status FROM generation_budget_reservations WHERE scope_id=$1',
                    [scopeId],
                  )
                ).rows[0].status,
                'held',
              );
            }),
        );

      await t.test(
        'overdue dispatched text stays permanently stopped when a known late receipt settles before maintenance',
        async () =>
          fixture(async (f) => {
            await f.claim();
            const request = await f.request();
            const runner = f.engine();
            const job = await runner.queue(request);
            const permit = await f.authority.consent(
              f.owner,
              f.campaignId,
              request.id,
              f.consentInput(),
            );
            assert.equal(
              await f.authority.begin({
                jobId: job.id,
                purpose: 'plan',
                context: request.context,
                signal: new AbortController().signal,
                maxCostMicros: f.config.text.upperMicros,
              }),
              permit.id,
            );
            await db.query(
              "UPDATE live_test_text_permits SET dispatched_at=now()-interval '61 seconds' WHERE id=$1 AND state='dispatched'",
              [permit.id],
            );
            // Intentionally no AI run/maintenance/sweeper: the late completion must latch the stop itself.
            const overdue = await f.authority.status(f.owner);
            assert.equal(overdue.state, 'stopped');
            assert.match(overdue.stopCode, /UNRESOLVED|UNKNOWN/);
            assert.equal(overdue.heldMicros, f.config.text.upperMicros);
            assert.equal(
              (await db.query('SELECT state FROM live_test_text_permits WHERE id=$1', [permit.id]))
                .rows[0].state,
              'dispatched',
            );

            await f.authority.complete(
              permit.id,
              5000,
              'PROVIDER_RESULT',
              'synthetic-late-receipt',
            );
            const settled = (
              await db.query('SELECT * FROM generation_budget_reservations WHERE scope_id=$1', [
                scopeId,
              ])
            ).rows;
            assert.equal(settled.length, 1);
            assert.equal(settled[0].status, 'settled');
            assert.equal(Number(settled[0].actual_micros), 5000);
            const persisted = (
              await db.query(
                'SELECT a.state,a.stop_code,b.blocked FROM live_test_sessions a JOIN generation_budget_scopes b ON b.id=a.scope_id WHERE a.id=$1',
                [f.authorizationId()],
              )
            ).rows[0];
            assert.deepEqual(persisted, {
              state: 'stopped',
              stop_code: 'PROVIDER_DEADLINE_EXCEEDED',
              blocked: true,
            });
            const receipt = (
              await db.query(
                'SELECT state,reservation_id FROM live_test_text_permits WHERE id=$1',
                [permit.id],
              )
            ).rows[0];
            assert.equal(receipt.state, 'settled');
            assert.equal(receipt.reservation_id, settled[0].id);
            await f.authority.complete(
              permit.id,
              5000,
              'PROVIDER_RESULT',
              'synthetic-late-receipt',
            );
            assert.deepEqual(
              (
                await db.query('SELECT * FROM generation_budget_reservations WHERE scope_id=$1', [
                  scopeId,
                ])
              ).rows,
              settled,
              'identical receipt replay must not add a charge or release its stop',
            );

            const restart = new GenerationAuthority(database, profile(f.handle));
            const status = await restart.status(f.owner);
            assert.equal(status.authorizationId, f.authorizationId());
            assert.equal(status.state, 'stopped');
            assert.equal(status.stopCode, 'PROVIDER_DEADLINE_EXCEEDED');
            assert.equal(status.usedMicros, 5000);
            assert.equal(status.heldMicros, 0);
            await assert.rejects(
              restart.claim(f.owner, { consent: true }),
              denied(/STOPPED|BLOCKED|UNRESOLVED/),
            );
            const next = await f.request();
            await assert.rejects(
              restart.consent(f.owner, f.campaignId, next.id, f.consentInput()),
              denied(/STOPPED|BLOCKED|UNRESOLVED/),
            );
            assert.equal(
              (await db.query('SELECT id FROM live_test_sessions WHERE scope_id=$1', [scopeId]))
                .rowCount,
              1,
            );
            assert.equal(
              (
                await db.query('SELECT blocked FROM generation_budget_scopes WHERE id=$1', [
                  scopeId,
                ])
              ).rows[0].blocked,
              true,
            );
            assert.equal(
              runner.calls(),
              0,
              'no real or fake transport is needed to settle an explicit late receipt',
            );
          }),
      );

      await t.test(
        'first owner claim includes legacy settled spend in finite cumulative limits',
        async () =>
          fixture(async (f) => {
            const old = await f.legacyReservation({ actual: 350000, upper: 350000 });
            await f.claim();
            const status = await f.authority.status(f.owner);
            assert.equal(status.usedMicros, 350000);
            assert.equal(status.remainingMicros, f.config.totalCapMicros - 350000);
            const r = await f.request();
            await assert.rejects(
              f.authority.consent(f.owner, f.campaignId, r.id, f.consentInput()),
              denied(/BUDGET_EXCEEDED/),
            );
            const image = await f.imageReserve();
            await database.tx((c) => settleGenerationSpend(c, image, 5000));
            assert.equal((await f.authority.status(f.owner)).usedMicros, 355000);
            const preserved = (
              await db.query(
                'SELECT status,actual_micros FROM generation_budget_reservations WHERE id=$1',
                [old],
              )
            ).rows[0];
            assert.equal(preserved.status, 'settled');
            assert.equal(Number(preserved.actual_micros), 350000);
          }),
      );

      await t.test(
        'owner-mode admission retains a same-owner manual grant and settled costs instead of replacing history',
        async () =>
          fixture(async (f) => {
            const manualId = randomUUID(),
              expiresAt = new Date(Date.now() + 3600000);
            const legacy = new LiveTestService(database, {
              enabled: true,
              ownerId: f.owner,
              sessionId: manualId,
              expiresAt,
            });
            await legacy.claim(f.owner, { consent: true });
            const old = await f.legacyReservation({ actual: 30000, upper: 30000 });
            const before = (
              await db.query('SELECT * FROM generation_budget_reservations WHERE id=$1', [old])
            ).rows[0];
            await f.claim();
            assert.notEqual(f.authorizationId(), manualId);
            const grants = (
              await db.query(
                'SELECT id,mode,state,stop_code,expires_at,cap_micros FROM live_test_sessions WHERE scope_id=$1 ORDER BY mode',
                [scopeId],
              )
            ).rows;
            assert.equal(grants.length, 2);
            const prior = grants.find((row) => row.id === manualId);
            assert.equal(prior.mode, 'manual');
            assert.equal(prior.state, 'stopped');
            assert.equal(prior.stop_code, 'OWNER_GENERATION_MODE_ACTIVE');
            assert.equal(new Date(prior.expires_at).getTime(), expiresAt.getTime());
            assert.equal(Number(prior.cap_micros), 1000000);
            assert.equal((await f.authority.status(f.owner)).usedMicros, 30000);
            assert.deepEqual(
              (await db.query('SELECT * FROM generation_budget_reservations WHERE id=$1', [old]))
                .rows[0],
              before,
            );
            await assert.rejects(
              legacy.claim(f.owner, { consent: true }),
              denied(/MODE_IMMUTABLE/),
            );
            assert.equal((await f.authority.status(f.owner)).usedMicros, 30000);
          }),
      );

      await t.test(
        'higher configured caps cannot enlarge a previously approved legacy financial ceiling',
        async () =>
          fixture(async (f) => {
            await f.legacyReservation({
              actual: 25000,
              upper: 25000,
              totalCap: 250000,
              textCap: 200000,
              imageCap: 200000,
            });
            const claimed = await f.claim();
            assert.equal(claimed.capMicros, 250000);
            assert.equal(claimed.remainingMicros, 225000);
            assert.equal(claimed.textCapMicros, 200000);
            assert.equal(claimed.imageCapMicros, 200000);
            assert.equal(claimed.text.capMicros, 200000);
            assert.equal(claimed.textUsedMicros, 25000);
            assert.equal(claimed.imageUsedMicros, 0);
            assert.equal(claimed.textRemainingMicros, 175000);
            assert.equal(claimed.imageRemainingMicros, 200000);
            const policy = await database.tx((c) =>
              f.authority.authorizeText(c, f.owner, f.authorizationId()),
            );
            assert.equal(policy.totalCapMicros, 250000);
            assert.equal(policy.textCapMicros, 200000);
            assert.equal(policy.imageCapMicros, 200000);
            for (let i = 0; i < 2; i++) {
              const reserve = await f.imageReserve();
              const held = await f.authority.status(f.owner);
              assert.equal(held.heldMicros, 100000);
              assert.equal(held.imageUsedMicros, (i + 1) * 100000);
              assert.equal(held.imageRemainingMicros, 200000 - (i + 1) * 100000);
              await database.tx((c) => settleGenerationSpend(c, reserve, 100000));
            }
            const exhausted = await f.authority.status(f.owner);
            assert.equal(exhausted.usedMicros, 225000);
            assert.equal(exhausted.heldMicros, 0);
            assert.equal(exhausted.remainingMicros, 25000);
            assert.equal(exhausted.textUsedMicros, 25000);
            assert.equal(exhausted.imageUsedMicros, 200000);
            assert.equal(exhausted.imageRemainingMicros, 0, 'total capacity is not image capacity');
            assert.equal(
              exhausted.textRemainingMicros,
              25000,
              'purpose availability is capped by the shared total',
            );
            await assert.rejects(f.imageReserve(f.authority, 1), denied(/BUDGET_EXCEEDED/));
            const request = await f.request();
            await assert.rejects(
              f.authority.consent(f.owner, f.campaignId, request.id, f.consentInput()),
              denied(/BUDGET_EXCEEDED/),
            );
            const restarted = new GenerationAuthority(database, profile(f.handle));
            assert.equal(
              (await restarted.claim(f.owner, { consent: true })).authorizationId,
              f.authorizationId(),
            );
            const restartedStatus = await restarted.status(f.owner);
            assert.equal(restartedStatus.capMicros, 250000);
            assert.equal(restartedStatus.textCapMicros, 200000);
            assert.equal(restartedStatus.imageCapMicros, 200000);
            assert.equal(restartedStatus.remainingMicros, 25000);
            assert.equal(restartedStatus.imageRemainingMicros, 0);
            assert.equal(restartedStatus.textRemainingMicros, 25000);
          }),
      );

      for (const ownerState of ['active', 'stopped'])
        await t.test(
          `unwrapped external NPC engine cannot enqueue under an owner grant marked ${ownerState}; mock stays local`,
          async () =>
            fixture(async (f) => {
              await f.claim();
              if (ownerState === 'stopped')
                await db.query(
                  "UPDATE live_test_sessions SET state='stopped',stop_code='SYNTHETIC_OWNER_STOP' WHERE id=$1",
                  [f.authorizationId()],
                );
              const legacy = await f.legacyEngine();
              const request = await f.request();
              await assert.rejects(
                legacy.queue(request),
                denied(/^GENERATION_AUTHORITY_IMMUTABLE$/),
              );
              assert.equal(legacy.calls(), 0);
              assert.equal(
                (await db.query('SELECT id FROM npc_ai_jobs WHERE campaign_id=$1', [f.campaignId]))
                  .rowCount,
                0,
              );
              assert.equal(
                (
                  await db.query(
                    'SELECT provider_id FROM npc_ai_provider_budgets WHERE provider_id=$1',
                    [legacy.providerId],
                  )
                ).rowCount,
                0,
              );
              const mock = await f.legacyEngine({ mock: true });
              const localRequest = await f.request();
              const local = await mock.queue(localRequest);
              await mock.ai.run(local.id, async () => true);
              assert.equal(mock.calls(), 1);
              assert.equal(
                (
                  await db.query(
                    'SELECT status,provider_actual_micros FROM npc_ai_jobs WHERE id=$1',
                    [local.id],
                  )
                ).rows[0].status,
                'result_received',
              );
              assert.equal(
                (
                  await db.query('SELECT provider_external FROM npc_ai_jobs WHERE id=$1', [
                    local.id,
                  ])
                ).rows[0].provider_external,
                false,
              );
              const localBudget = (
                await db.query(
                  'SELECT reserved_micros,spent_micros,unknown_micros FROM npc_ai_provider_budgets WHERE provider_id=$1',
                  [mock.providerId],
                )
              ).rows[0];
              assert.deepEqual(Object.values(localBudget).map(Number), [0, 0, 0]);
            }),
        );

      for (const history of [
        'reserved',
        'spent',
        'unknown',
        'blocked',
        'old-null-provenance',
        'orphan-reserved',
        'orphan-spent',
        'orphan-unknown',
        'orphan-blocked',
      ])
        await t.test(
          `unlinked legacy NPC ${history} evidence blocks first owner claim without changing history`,
          async () =>
            fixture(async (f) => {
              const legacy = await f.legacyEngine({
                outcome: history === 'unknown' ? 'unknown' : 'success',
              });
              if (history.startsWith('orphan-')) {
                await db.query(
                  'INSERT INTO npc_ai_provider_budgets(provider_id,cap_micros,reserved_micros,spent_micros,unknown_micros,blocked) VALUES($1,1000000,$2,$3,$4,$5)',
                  [
                    legacy.providerId,
                    history === 'orphan-reserved' ? 1000 : 0,
                    history === 'orphan-spent' ? 1000 : 0,
                    history === 'orphan-unknown' ? 1000 : 0,
                    history === 'orphan-blocked',
                  ],
                );
              } else {
                const request = await f.request();
                const job = await legacy.queue(request);
                if (['spent', 'unknown'].includes(history))
                  await legacy.ai.run(job.id, async () => true);
                if (history === 'old-null-provenance')
                  await db.query('UPDATE npc_ai_jobs SET provider_external=NULL WHERE id=$1', [
                    job.id,
                  ]);
                if (history === 'blocked')
                  await db.query(
                    'UPDATE npc_ai_provider_budgets SET blocked=true WHERE provider_id=$1',
                    [legacy.providerId],
                  );
              }
              const beforeBudget = (
                await db.query('SELECT * FROM npc_ai_provider_budgets WHERE provider_id=$1', [
                  legacy.providerId,
                ])
              ).rows;
              const beforeJobs = (
                await db.query('SELECT * FROM npc_ai_jobs WHERE provider_id=$1 ORDER BY id', [
                  legacy.providerId,
                ])
              ).rows;
              await assert.rejects(
                f.authority.claim(f.owner, { consent: true }),
                denied(/^GENERATION_PRIOR_NPC_RECONCILIATION_REQUIRED$/),
              );
              assert.deepEqual(
                (
                  await db.query('SELECT * FROM npc_ai_provider_budgets WHERE provider_id=$1', [
                    legacy.providerId,
                  ])
                ).rows,
                beforeBudget,
              );
              assert.deepEqual(
                (
                  await db.query('SELECT * FROM npc_ai_jobs WHERE provider_id=$1 ORDER BY id', [
                    legacy.providerId,
                  ])
                ).rows,
                beforeJobs,
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
              assert.equal(legacy.calls(), ['spent', 'unknown'].includes(history) ? 1 : 0);
            }),
        );

      await t.test(
        'already queued unwrapped external NPC job cannot dispatch after an owner grant appears',
        async () =>
          fixture(async (f) => {
            const legacy = await f.legacyEngine();
            const request = await f.request();
            const job = await legacy.queue(request);
            const before = (
              await db.query('SELECT * FROM npc_ai_provider_budgets WHERE provider_id=$1', [
                legacy.providerId,
              ])
            ).rows;
            // Synthetic impossible-in-normal-claim transition isolates the dispatch defense:
            // real claim is independently required to reject this existing legacy reservation.
            await db.query(
              'INSERT INTO generation_budget_scopes(id,approved,total_cap_micros,text_cap_micros,image_cap_micros,serialize_outstanding) VALUES($1,true,$2,$3,$4,true)',
              [scopeId, f.config.totalCapMicros, f.config.textCapMicros, f.config.imageCapMicros],
            );
            await db.query(
              "INSERT INTO live_test_sessions(id,owner_id,scope_id,expires_at,cap_micros,state,mode,config_hash,owner_handle,text_cap_micros,image_cap_micros) VALUES($1,$2,$3,NULL,$4,'active','owner',$5,$6,$7,$8)",
              [
                randomUUID(),
                f.owner,
                scopeId,
                f.config.totalCapMicros,
                digest(f.config),
                f.handle,
                f.config.textCapMicros,
                f.config.imageCapMicros,
              ],
            );
            await assert.rejects(
              legacy.ai.run(job.id, async () => true),
              denied(/^GENERATION_AUTHORITY_IMMUTABLE$/),
            );
            assert.equal(legacy.calls(), 0);
            const after = (
              await db.query('SELECT status,started_at,deadline_at FROM npc_ai_jobs WHERE id=$1', [
                job.id,
              ])
            ).rows[0];
            assert.deepEqual(after, { status: 'reserved', started_at: null, deadline_at: null });
            assert.deepEqual(
              (
                await db.query('SELECT * FROM npc_ai_provider_budgets WHERE provider_id=$1', [
                  legacy.providerId,
                ])
              ).rows,
              before,
            );
          }),
      );

      for (const winner of ['owner claim', 'legacy enqueue'])
        await t.test(
          `${winner} wins the PostgreSQL owner-versus-unwrapped-NPC admission race; both cannot commit`,
          async () =>
            fixture(async (f) => {
              const claimant = admissionBarrier(winner === 'owner claim');
              const enqueue = admissionBarrier(winner !== 'owner claim', 'provider');
              const authority = new GenerationAuthority(claimant.database, f.config);
              const legacy = await f.legacyEngine({ engineDatabase: enqueue.database });
              const request = await f.request();
              const startClaim = () => outcome(authority.claim(f.owner, { consent: true }));
              const startQueue = () => outcome(legacy.queue(request));
              const firstBarrier = winner === 'owner claim' ? claimant : enqueue;
              const secondBarrier = winner === 'owner claim' ? enqueue : claimant;
              const first = winner === 'owner claim' ? startClaim() : startQueue();
              let second;
              try {
                const firstPid = await beforeFinished(firstBarrier.ready, first, 'winner');
                second = winner === 'owner claim' ? startQueue() : startClaim();
                const secondPid = await beforeFinished(secondBarrier.attempted, second, 'loser');
                assert.notEqual(firstPid, secondPid);
                await assertAdvisoryBlocked(secondPid, firstPid);
              } finally {
                firstBarrier.release();
                await Promise.all([first, ...(second ? [second] : [])]);
              }
              const [accepted, rejected] = await Promise.all([first, second]);
              assert.equal(accepted.status, 'fulfilled', String(codeOf(accepted.reason)));
              assert.equal(rejected.status, 'rejected');
              assert.equal(
                codeOf(rejected.reason),
                winner === 'owner claim'
                  ? 'GENERATION_AUTHORITY_IMMUTABLE'
                  : 'GENERATION_PRIOR_NPC_RECONCILIATION_REQUIRED',
              );
              assert.equal(
                (await db.query('SELECT id FROM live_test_sessions WHERE scope_id=$1', [scopeId]))
                  .rowCount,
                winner === 'owner claim' ? 1 : 0,
              );
              const budgets = (
                await db.query(
                  'SELECT reserved_micros FROM npc_ai_provider_budgets WHERE provider_id=$1',
                  [legacy.providerId],
                )
              ).rows;
              const jobs = (
                await db.query(
                  'SELECT id,status,provider_external FROM npc_ai_jobs WHERE provider_id=$1',
                  [legacy.providerId],
                )
              ).rows;
              assert.equal(budgets.length, winner === 'owner claim' ? 0 : 1);
              assert.equal(jobs.length, winner === 'owner claim' ? 0 : 1);
              if (winner === 'legacy enqueue') {
                assert.equal(Number(budgets[0].reserved_micros), 10000);
                assert.equal(jobs[0].id, accepted.value.id);
                assert.equal(jobs[0].status, 'reserved');
                assert.equal(jobs[0].provider_external, true);
              }
              assert.equal(legacy.calls(), 0);
            }),
        );

      for (const winner of ['claim', 'foreign reservation'])
        await t.test(
          `${winner} wins the real PostgreSQL owner-versus-foreign-scope admission race; both cannot commit`,
          async () =>
            fixture(async (f) => {
              const foreignScope = `owner-race-fixture-${randomUUID()}`;
              const claimant = admissionBarrier(winner === 'claim');
              const reserver = admissionBarrier(winner !== 'claim');
              const authority = new GenerationAuthority(claimant.database, f.config);
              const startClaim = () => outcome(authority.claim(f.owner, { consent: true }));
              const startReserve = () =>
                outcome(
                  f.externalReservation({
                    scope: foreignScope,
                    actor: f.other,
                    transaction: reserver.database.tx,
                  }),
                );
              const firstBarrier = winner === 'claim' ? claimant : reserver;
              const secondBarrier = winner === 'claim' ? reserver : claimant;
              const first = winner === 'claim' ? startClaim() : startReserve();
              let second;
              try {
                const firstPid = await beforeFinished(firstBarrier.ready, first, 'winner');
                second = winner === 'claim' ? startReserve() : startClaim();
                const secondPid = await beforeFinished(secondBarrier.attempted, second, 'loser');
                assert.notEqual(firstPid, secondPid);
                await assertAdvisoryBlocked(secondPid, firstPid);
              } finally {
                firstBarrier.release();
                // Finish every started transaction before fixture cleanup, even on assertion failure.
                await Promise.all([first, ...(second ? [second] : [])]);
              }
              const [accepted, rejected] = await Promise.all([first, second]);
              assert.equal(accepted.status, 'fulfilled', String(codeOf(accepted.reason)));
              assert.equal(rejected.status, 'rejected', 'exactly one admission may commit');
              assert.equal(
                codeOf(rejected.reason),
                winner === 'claim'
                  ? 'GENERATION_AUTHORITY_IMMUTABLE'
                  : 'GENERATION_PRIOR_LIABILITY_UNRESOLVED',
                'a lock timeout/deadlock is not a safe admission outcome',
              );
              const grants = (
                await db.query('SELECT id,mode FROM live_test_sessions WHERE scope_id=$1', [
                  scopeId,
                ])
              ).rows;
              const reservations = (
                await db.query(
                  'SELECT id,actor_id,status,upper_micros FROM generation_budget_reservations WHERE scope_id=$1',
                  [foreignScope],
                )
              ).rows;
              assert.equal(grants.length, winner === 'claim' ? 1 : 0);
              assert.equal(reservations.length, winner === 'claim' ? 0 : 1);
              if (winner === 'claim') {
                assert.equal(grants[0].mode, 'owner');
                assert.equal(grants[0].id, accepted.value.authorizationId);
              } else {
                assert.equal(reservations[0].id, accepted.value);
                assert.equal(reservations[0].actor_id, f.other);
                assert.equal(reservations[0].status, 'held');
                assert.equal(Number(reservations[0].upper_micros), 1000);
              }
            }),
        );

      await t.test(
        'claimed owner scope rejects another actor, old manual policy and mismatched authorization before reserving',
        async () =>
          fixture(async (f) => {
            await f.claim();
            const policy = await database.tx((c) =>
              f.authority.authorizeText(c, f.owner, f.authorizationId()),
            );
            assert.equal(policy.generationMode, 'owner');
            assert.equal(policy.generationAuthorizationId, f.authorizationId());
            const legacyPolicy = { ...policy };
            delete legacyPolicy.generationMode;
            delete legacyPolicy.generationAuthorizationId;
            delete legacyPolicy.generationConfigFingerprint;
            for (const input of [
              { policy, actor: f.other },
              { policy: legacyPolicy },
              { policy: { ...policy, generationAuthorizationId: randomUUID() } },
            ])
              await assert.rejects(
                f.externalReservation(input),
                denied(/^GENERATION_AUTHORITY_IMMUTABLE$/),
              );
            assert.equal(
              (
                await db.query('SELECT id FROM generation_budget_reservations WHERE scope_id=$1', [
                  scopeId,
                ])
              ).rowCount,
              0,
            );
            const allowed = await f.externalReservation({ policy });
            assert.equal(
              (
                await db.query('SELECT actor_id FROM generation_budget_reservations WHERE id=$1', [
                  allowed,
                ])
              ).rows[0].actor_id,
              f.owner,
            );
          }),
      );

      for (const prior of [
        'held',
        'unknown',
        'blocked',
        'foreign-held',
        'foreign-blocked',
        'foreign-settled',
        'over-cap',
        'unapproved',
        'different-actor',
        'erased-actor',
      ])
        await t.test(
          `${prior} legacy liability blocks first owner admission without resetting evidence`,
          async () =>
            fixture(async (f) => {
              const legacyScope = prior.startsWith('foreign-')
                ? `owner-foreign-fixture-${randomUUID()}`
                : scopeId;
              const old = await f.legacyReservation({
                scope: legacyScope,
                actor:
                  prior === 'erased-actor'
                    ? null
                    : ['foreign-held', 'foreign-blocked', 'different-actor'].includes(prior)
                      ? f.other
                      : f.owner,
                status: prior.endsWith('held') ? 'held' : 'settled',
                blocked: prior.endsWith('blocked'),
                approved: prior !== 'unapproved',
                actual: prior === 'unknown' ? null : prior === 'over-cap' ? 500000 : 1000,
                upper: prior === 'over-cap' ? 500000 : 100000,
              });
              const before = (
                await db.query('SELECT * FROM generation_budget_reservations WHERE id=$1', [old])
              ).rows[0];
              const originalScopes = (
                await db.query(
                  'SELECT * FROM generation_budget_scopes WHERE id=ANY($1::text[]) ORDER BY id',
                  [[scopeId, legacyScope]],
                )
              ).rows;
              await assert.rejects(
                f.authority.claim(f.owner, { consent: true }),
                denied(
                  /HELD|OUTSTANDING|BLOCKED|UNRESOLVED|LEGACY|LIABILITY|RECONCILIATION|HISTORICAL_SPEND|UNAPPROVED|NOT_APPROVED|REVOKED|OWNER_IMMUTABLE/,
                ),
              );
              assert.deepEqual(
                (
                  await db.query(
                    'SELECT * FROM generation_budget_scopes WHERE id=ANY($1::text[]) ORDER BY id',
                    [[scopeId, legacyScope]],
                  )
                ).rows,
                originalScopes,
              );
              assert.deepEqual(
                (await db.query('SELECT * FROM generation_budget_reservations WHERE id=$1', [old]))
                  .rows[0],
                before,
              );
              assert.equal(
                (await db.query('SELECT id FROM live_test_sessions WHERE scope_id=$1', [scopeId]))
                  .rowCount,
                0,
              );
            }),
        );
    } finally {
      await db.end();
    }
  },
);
