// Isolated PostgreSQL and injected configuration only. No live application or provider calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFile, readdir } = require('node:fs/promises');
const {
  BOUNDED_TEST,
  createBoundedTest,
  boundedTest,
  boundedPolicy,
  checkBoundedAdmission,
  assertBoundedTextSource,
} = require('../../apps/api/dist/generation/bounded-test');
const {
  reserveGenerationSpend,
  settleGenerationSpend,
} = require('../../apps/api/dist/image-generation/budget');
const { appendPolicyRevision } = require('../../apps/api/dist/generation/policy-revisions');
const { digest } = require('../../apps/api/dist/ai/context');
const { SparksAccounting } = require('../../apps/api/dist/generation/sparks-accounting');
const {
  reserveSparks,
  settleReservationSparks,
  sparkTariff,
} = require('../../apps/api/dist/generation/sparks-hooks');

const pricing = {
  source: 'https://developers.openai.com/api/docs/pricing',
  reviewedAt: '2025-01-01T00:00:00Z',
  validUntil: '2099-01-01T00:00:00Z',
};
const config = {
  mode: 'owner',
  ownerHandle: 'bounded_fixture',
  totalCapMicros: 1000000,
  textCapMicros: 300000,
  imageCapMicros: 1000000,
  text: {
    model: 'fixture-text',
    contextTokens: 100000,
    maxOutputTokens: 2048,
    maxInputBytes: 64000,
    inputMicrosPerMillion: 100000,
    outputMicrosPerMillion: 500000,
    upperMicros: 500000,
    pricing,
  },
  image: {
    model: 'fixture-image',
    size: '1024x1024',
    quality: 'low',
    outputs: 1,
    format: 'png',
    maxPromptUtf8Bytes: 8000,
    maxReferenceImages: 0,
    inputTextMicrosPerMillion: 5000000,
    inputImageMicrosPerMillion: 5000000,
    outputImageMicrosPerMillion: 10000000,
    estimatedTotalMicros: 100000,
    reserveMicros: 300000,
    estimateRiskAccepted: true,
    pricing,
    maxReferenceBytes: 5242880,
    maxReferencePixels: 16777216,
    costBasis: 'approved_estimate',
    providerEnforcesQuotedCap: false,
  },
  configFingerprint: 'f'.repeat(64),
};

test(
  'bounded authoring: 043 after040, exact anchor, complete aggregate, concurrency, replay, expiration and retained unknown',
  { timeout: 120000 },
  async () => {
    const net = require('node:net'),
      { once } = require('node:events'),
      { Pool } = require('pg');
    const { startLocalPostgres } = await import('../../scripts/postgres-local.mjs');
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((r) => server.close(r));
    process.env.NODE_ENV = 'test';
    delete process.env.DATABASE_URL;
    process.env.LOCAL_POSTGRES_CLUSTER = 'bounded-' + randomUUID();
    process.env.LOCAL_POSTGRES_PORT = String(port);
    const pg = await startLocalPostgres(),
      pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const owner = randomUUID(),
      other = randomUUID(),
      story = randomUUID(),
      oldStory = randomUUID(),
      hold = randomUUID(),
      job = randomUUID(),
      quote = randomUUID();
    const legacyScope = 'legacy-fixture',
      priorScope = 'confirmed-prior-fixture';
    const barrierClients = new Set();
    async function barrierClient() {
      const c = await pool.connect();
      barrierClients.add(c);
      return c;
    }
    function releaseBarrier(c) {
      barrierClients.delete(c);
      c.release();
    }
    async function tx(work) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await work(c);
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    }
    const createInput = {
      operationId: randomUUID(),
      adventureId: story,
      candidateFingerprint: config.configFingerprint,
      consent: true,
      isolatedSyntheticStory: true,
      lifetimeMinutes: 1,
    };
    async function locked(c, id) {
      await c.query('SELECT id FROM live_test_sessions WHERE id=$1 FOR NO KEY UPDATE', [id]);
      await c.query(
        'SELECT id FROM generation_budget_scopes WHERE id=(SELECT scope_id FROM live_test_sessions WHERE id=$1) FOR UPDATE',
        [id],
      );
    }
    async function reserve(id, kind, amount, operation) {
      return tx(async (c) => {
        await locked(c, id);
        const b = await boundedTest(c, id);
        const p = await boundedPolicy(c, b, owner, config);
        return reserveGenerationSpend(c, p, owner, kind, operation, amount);
      });
    }
    async function oldSnapshot() {
      return JSON.stringify(
        (
          await pool.query(
            'SELECT row_to_json(s) s,row_to_json(b) b,row_to_json(r) r,row_to_json(j) j FROM live_test_sessions s JOIN generation_budget_scopes b ON b.id=s.scope_id JOIN generation_budget_reservations r ON r.scope_id=b.id JOIN image_generation_jobs j ON j.reservation_id=r.id WHERE s.id=$1',
            [BOUNDED_TEST.legacyAuthorizationId],
          )
        ).rows,
      );
    }
    try {
      for (const file of (await readdir('packages/db/migrations'))
        .filter((x) => x.endsWith('.sql'))
        .sort())
        await pool.query(await readFile('packages/db/migrations/' + file, 'utf8'));
      await pool.query(
        "INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,'bounded@fixture.invalid','fixture','Bounded','bounded_fixture'),($2,'other@fixture.invalid','fixture','Other','other_fixture')",
        [owner, other],
      );
      for (const [id, created] of [
        [story, new Date()],
        [oldStory, new Date('2026-10-01')],
      ])
        await pool.query(
          "INSERT INTO adventures(id,owner_id,slug,title,genre,data,visibility,created_at) VALUES($1,$2,($1::uuid)::text,'Synthetic test','test','{}','private',$3)",
          [id, owner, created],
        );
      await pool.query(
        'INSERT INTO generation_budget_scopes(id,approved,total_cap_micros,text_cap_micros,image_cap_micros,blocked,serialize_outstanding) VALUES($1,true,1000000,1000000,1000000,true,true),($2,true,1000000,1000000,1000000,false,true)',
        [legacyScope, priorScope],
      );
      await pool.query(
        "INSERT INTO live_test_sessions(id,owner_id,scope_id,expires_at,cap_micros,state,stop_code,mode,config_hash,owner_handle,text_cap_micros,image_cap_micros) VALUES($1,$2,$3,NULL,1000000,'stopped','IMAGE_RESULT_UNKNOWN','owner',$4,'bounded_fixture',1000000,1000000)",
        [BOUNDED_TEST.legacyAuthorizationId, owner, legacyScope, digest(config)],
      );
      await pool.query(
        "INSERT INTO generation_budget_reservations(id,scope_id,actor_id,kind,operation_key,upper_micros,status,actual_micros) VALUES($1,$2,$3,'image','legacy',66900,'held',NULL),($4,$5,$3,'text','earlier',10000,'settled',10000)",
        [hold, legacyScope, owner, randomUUID(), priorScope],
      );
      await pool.query(
        "INSERT INTO image_generation_quotes(id,actor_id,adventure_id,request_hash,input,reference_hashes,mode,policy_version,upper_micros,expires_at) VALUES($1,$2,$3,'fixture','{}','{}','external','fixture',66900,now()+interval '1 hour')",
        [quote, owner, oldStory],
      );
      const diagnostic = {
        httpStatus: 403,
        requestId: BOUNDED_TEST.requestId,
        providerCode: 'model_not_found',
        category: 'model_access',
        evidence: 'provider_reported',
        billing: 'unknown',
      };
      await pool.query(
        "INSERT INTO image_generation_jobs(id,actor_id,adventure_id,operation_id,quote_id,request_hash,input,reference_hashes,mode,policy_version,status,reservation_id,upper_micros,expires_at,upload_id,family_id,revision_id,safe_diagnostic,pricing_profile_snapshot) VALUES($1,$2,$3,$4,$5,'fixture','{}','{}','external','fixture','unknown',$6,66900,now()+interval '1 hour',$7,$8,$9,$10,$11)",
        [
          job,
          owner,
          oldStory,
          randomUUID(),
          quote,
          hold,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          JSON.stringify(diagnostic),
          JSON.stringify({ model: BOUNDED_TEST.model }),
        ],
      );
      await pool.query(
        "INSERT INTO image_generation_attempts(job_id,dispatch_id,provider,request_hash) VALUES($1,$2,'fixture','fixture')",
        [job, randomUUID()],
      );
      await assert.rejects(
        tx((c) => createBoundedTest(c, owner, createInput, config)),
        /BOUNDED_PRIOR_RISK_ACK_REQUIRED/,
      );
      await tx((c) =>
        appendPolicyRevision(c, {
          authorizationId: BOUNDED_TEST.legacyAuthorizationId,
          scopeId: legacyScope,
          revision: 1,
          hash: digest(config),
          previousHash: null,
          config,
          operationId: randomUUID(),
          requestHash: digest('fixture-ack'),
        }),
      );
      // Synthetic enabled-wallet fixture only: the real historical grant predates Sparks.
      const accounting = new SparksAccounting();
      await tx((c) => accounting.ensureWallet(c, owner));
      await pool.query(
        'UPDATE spark_wallets SET enabled=true,balance_subunits=1000000 WHERE owner_id=$1',
        [owner],
      );
      const makeSparkQuote = (sourceId, reserveSubunits, sourceKind = 'text') =>
        tx((c) =>
          accounting.quote(c, {
            ownerId: owner,
            operationId: randomUUID(),
            sourceKind,
            sourceId,
            reserveSubunits,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            providerQuote: { fixture: true },
            tariff: sparkTariff(config.text, 'fixture', 'v1'),
          }),
        );
      const legacySpark = await makeSparkQuote('synthetic-legacy', '66900', 'image');
      await tx((c) => reserveSparks(c, owner, legacySpark.id, hold));
      const preserved = await oldSnapshot();
      await assert.rejects(
        tx((c) => createBoundedTest(c, other, createInput, config)),
        /FORBIDDEN/,
      );
      await assert.rejects(
        tx((c) => createBoundedTest(c, owner, { ...createInput, adventureId: oldStory }, config)),
        /ISOLATED_TEST_STORY_REQUIRED/,
      );
      await assert.rejects(
        tx((c) => createBoundedTest(c, owner, createInput, { ...config, totalCapMicros: 550000 })),
        /PRIOR_POLICY_MISMATCH/,
      );
      await pool.query(
        "INSERT INTO npc_ai_provider_budgets(provider_id,cap_micros,spent_micros) VALUES('orphan-evidence',100,1)",
      );
      await assert.rejects(
        tx((c) => createBoundedTest(c, owner, createInput, config)),
        /PRIOR_NPC_LIABILITY_UNRESOLVED/,
      );
      await pool.query("DELETE FROM npc_ai_provider_budgets WHERE provider_id='orphan-evidence'");
      const extra = randomUUID();
      await pool.query(
        "INSERT INTO generation_budget_reservations(id,scope_id,actor_id,kind,operation_key,upper_micros,status) VALUES($1,$2,$3,'text','unresolved',1,'held')",
        [extra, priorScope, owner],
      );
      await assert.rejects(
        tx((c) => createBoundedTest(c, owner, createInput, config)),
        /PRIOR_LIABILITY_UNRESOLVED/,
      );
      await pool.query('DELETE FROM generation_budget_reservations WHERE id=$1', [extra]);
      await pool.query('UPDATE image_generation_jobs SET safe_diagnostic=$2 WHERE id=$1', [
        job,
        JSON.stringify({ ...diagnostic, providerCode: 'invalid_api_key' }),
      ]);
      await assert.rejects(
        tx((c) => createBoundedTest(c, owner, createInput, config)),
        /LEGACY_EVIDENCE_MISMATCH/,
      );
      await pool.query('UPDATE image_generation_jobs SET safe_diagnostic=$2 WHERE id=$1', [
        job,
        JSON.stringify(diagnostic),
      ]);
      // An earlier settled scope cannot disappear from the parent cap computation.
      const expensive = randomUUID();
      await pool.query(
        "INSERT INTO generation_budget_reservations(id,scope_id,actor_id,kind,operation_key,upper_micros,status,actual_micros) VALUES($1,$2,$3,'text','prior-expensive',500000,'settled',500000)",
        [expensive, priorScope, owner],
      );
      await assert.rejects(
        tx((c) => createBoundedTest(c, owner, createInput, config)),
        /GLOBAL_CAP_CONFLICT/,
      );
      await pool.query('DELETE FROM generation_budget_reservations WHERE id=$1', [expensive]);
      const admissions = await Promise.all([
        tx((c) => createBoundedTest(c, owner, createInput, config)),
        tx((c) => createBoundedTest(c, owner, createInput, config)),
      ]);
      assert.equal(admissions[0].authorization_id, admissions[1].authorization_id);
      const b = admissions[0];
      assert.equal(b.cap_micros, '500000');
      assert.equal(b.baseline_spent_micros, '10000');
      assert.equal(b.aggregate_cap_micros, '576900');
      assert.equal(
        (
          await pool.query('SELECT text_cap_micros FROM generation_budget_scopes WHERE id=$1', [
            b.scope_id,
          ])
        ).rows[0].text_cap_micros,
        '300000',
      );
      await assert.rejects(
        tx((c) => checkBoundedAdmission(c, b, owner, 290001, 'text')),
        /BUDGET_EXCEEDED/,
      );

      assert.equal(
        (await tx((c) => createBoundedTest(c, owner, createInput, config))).authorization_id,
        b.authorization_id,
      );
      await assert.rejects(
        tx((c) =>
          createBoundedTest(c, owner, { ...createInput, operationId: randomUUID() }, config),
        ),
        /IDEMPOTENCY_CONFLICT/,
      );
      await assert.rejects(
        pool.query(
          'UPDATE bounded_authoring_tests SET cap_micros=999999 WHERE authorization_id=$1',
          [b.authorization_id],
        ),
        /immutable/,
      );
      await assert.rejects(
        tx((c) => boundedPolicy(c, b, other, config)),
        /FORBIDDEN/,
      );
      await assert.rejects(
        tx((c) =>
          boundedPolicy(c, b, owner, { ...config, text: { ...config.text, model: 'changed' } }),
        ),
        /POLICY_CHANGED/,
      );
      await assert.rejects(
        tx((c) =>
          boundedPolicy(c, b, owner, config, {
            adventureId: oldStory,
            studioLocationContext: { locationId: 'room' },
            kind: 'background',
          }),
        ),
        /LOCATION_ONLY/,
      );
      await assert.rejects(
        tx((c) => assertBoundedTextSource(c, b.authorization_id, randomUUID())),
        /STORY_PLAN_ONLY/,
      );
      const now = Date.now;
      Date.now = () => new Date(b.expires_at).getTime() + 1;
      try {
        await assert.rejects(
          tx((c) => checkBoundedAdmission(c, b, owner)),
          /EXPIRED/,
        );
      } finally {
        Date.now = now;
      }
      // A late invoice on another scope must serialize ahead of fresh admission.
      const late = randomUUID();
      await pool.query(
        "INSERT INTO generation_budget_reservations(id,scope_id,actor_id,kind,operation_key,upper_micros,status) VALUES($1,$2,$3,'text','late-invoice',1,'released')",
        [late, priorScope, owner],
      );
      const settling = await pool.connect();
      await settling.query('BEGIN');
      await settleGenerationSpend(settling, late, 500000);
      const waiting = reserve(b.authorization_id, 'text', 1, 'while-late-settles').then(
        () => 'admitted',
        (e) => e.message,
      );
      assert.equal(
        await Promise.race([waiting, new Promise((r) => setTimeout(() => r('waiting'), 50))]),
        'waiting',
      );
      await settling.query('COMMIT');
      settling.release();
      assert.match(await waiting, /OUTCOME_UNRESOLVED|BUDGET_EXCEEDED/);
      assert.equal(
        (
          await pool.query('SELECT actual_micros FROM generation_budget_reservations WHERE id=$1', [
            late,
          ])
        ).rows[0].actual_micros,
        '500000',
      );
      // Reset only this synthetic scenario, never any live history.
      await pool.query('DELETE FROM generation_budget_reservations WHERE id=$1', [late]);
      await pool.query('UPDATE generation_budget_scopes SET blocked=false WHERE id=$1', [
        priorScope,
      ]);
      // Controlled ABBA regression: real child scope holds the global fence while a
      // same-owner legacy callback tries wallet then provider settlement. It must wait
      // before acquiring the wallet, so child admission can finish without a deadlock.
      const earlyConfig = require.resolve('../../apps/api/dist/config');
      require.cache[earlyConfig] = {
        id: earlyConfig,
        filename: earlyConfig,
        loaded: true,
        exports: { config: { DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: 'test' } },
      };
      const directProbe = Object.create(
        require('../../apps/api/dist/ai/npc-ai.service').NpcAiEngine.prototype,
      );
      directProbe.provider = { id: 'direct-active-child-race', external: true };
      await pool.query(
        "INSERT INTO npc_ai_provider_budgets(provider_id,cap_micros) VALUES('direct-active-child-race',1000)",
      );
      const qRace = await makeSparkQuote('child-lock-race', '1');
      const admission = await barrierClient(),
        receipt = await barrierClient();
      await admission.query('BEGIN');
      await receipt.query('BEGIN');
      await admission.query("SET LOCAL lock_timeout='3000ms'");
      await receipt.query("SET LOCAL lock_timeout='3000ms'");
      await locked(admission, b.authorization_id);
      const racePolicy = await boundedPolicy(admission, b, owner, config);
      const raceReservation = await reserveGenerationSpend(
        admission,
        racePolicy,
        owner,
        'text',
        'wallet-global-race',
        1,
      );
      const directAttempt = await barrierClient();
      await directAttempt.query('BEGIN');
      await directAttempt.query("SET LOCAL lock_timeout='3000ms'");
      await directAttempt.query(
        'SELECT * FROM npc_ai_provider_budgets WHERE provider_id=$1 FOR UPDATE',
        [directProbe.provider.id],
      );
      // This is the production gate called by BOTH direct enqueue and dispatch.
      const escaping = directProbe.excludeLegacyOwnerBypass(directAttempt).then(
        () => null,
        (e) => e,
      );
      for (let tries = 0; ; tries++) {
        const blockers = (
          await pool.query('SELECT pg_blocking_pids($1) p', [directAttempt.processID])
        ).rows[0].p;
        if (blockers.includes(admission.processID)) break;
        assert.ok(tries < 100, 'direct admission must wait for active child fence');
        await new Promise((r) => setTimeout(r, 10));
      }
      await locked(receipt, BOUNDED_TEST.legacyAuthorizationId);
      const callback = (async () => {
        await settleReservationSparks(receipt, hold, {
          outcome: 'unknown',
          receiptId: 'synthetic-legacy-callback',
        });
        await settleGenerationSpend(receipt, hold, 66900);
        assert.equal(
          (await receipt.query('SELECT status FROM spark_holds WHERE id=$1', [legacySpark.id]))
            .rows[0].status,
          'pending',
        );
      })();
      // Explicit database lock evidence, not a timing-only assertion.
      for (let tries = 0; ; tries++) {
        const blockers = (await pool.query('SELECT pg_blocking_pids($1) p', [receipt.processID]))
          .rows[0].p;
        if (blockers.includes(admission.processID)) break;
        assert.ok(tries < 100, 'receipt must wait for the child global fence');
        await new Promise((r) => setTimeout(r, 10));
      }
      await reserveSparks(admission, owner, qRace.id, raceReservation);
      await admission.query('COMMIT');
      assert.match((await escaping)?.message ?? '', /GENERATION_AUTHORITY_IMMUTABLE/);
      await directAttempt.query('ROLLBACK');
      releaseBarrier(directAttempt);
      assert.equal(
        (
          await pool.query(
            'SELECT reserved_micros FROM npc_ai_provider_budgets WHERE provider_id=$1',
            [directProbe.provider.id],
          )
        ).rows[0].reserved_micros,
        '0',
      );
      await callback;
      // Roll back only this synthetic late provider-receipt scenario: historical
      // reservation/actual remains unchanged for the remaining preservation checks.
      await receipt.query('ROLLBACK');
      releaseBarrier(admission);
      releaseBarrier(receipt);
      await tx(async (c) => {
        await settleGenerationSpend(c, raceReservation, 0);
        await settleReservationSparks(c, raceReservation, {
          outcome: 'application_cache',
          receiptId: 'cache-race',
        });
        await settleReservationSparks(c, raceReservation, {
          outcome: 'application_cache',
          receiptId: 'cache-race',
        });
        await settleReservationSparks(c, hold, {
          outcome: 'unknown',
          receiptId: 'synthetic-legacy-unknown',
        });
      });
      assert.equal(
        (await pool.query('SELECT status FROM spark_holds WHERE id=$1', [legacySpark.id])).rows[0]
          .status,
        'pending',
      );
      assert.equal(
        (await pool.query('SELECT held_subunits FROM spark_wallets WHERE owner_id=$1', [owner]))
          .rows[0].held_subunits,
        '66900',
      );
      const outcomes = await Promise.allSettled([
        reserve(b.authorization_id, 'text', 270000, 'first'),
        reserve(b.authorization_id, 'image', 270000, 'second'),
      ]);
      assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
      assert.match(
        outcomes.find((x) => x.status === 'rejected').reason.message,
        /BUDGET_EXCEEDED|OUTSTANDING/,
      );
      const winner = outcomes.find((x) => x.status === 'fulfilled').value;
      const winnerRow = (
        await pool.query('SELECT * FROM generation_budget_reservations WHERE id=$1', [winner])
      ).rows[0];
      assert.equal(
        await reserve(b.authorization_id, winnerRow.kind, 270000, winnerRow.operation_key),
        winner,
      );
      const oldPolicy = {
        ...(await tx((c) => boundedPolicy(c, b, owner, config))),
        scopeId: legacyScope,
        generationAuthorizationId: BOUNDED_TEST.legacyAuthorizationId,
        preserveModelRejectionHolds: true,
      };
      await assert.rejects(
        tx((c) => reserveGenerationSpend(c, oldPolicy, owner, 'image', 'old-escape', 1)),
        /BOUNDED_TEST_SESSION_REQUIRED/,
      );
      await tx((c) => settleGenerationSpend(c, winner, 100000));
      const next = await reserve(b.authorization_id, 'image', 350000, 'third');
      await tx((c) => settleGenerationSpend(c, next, 350000));
      await assert.rejects(reserve(b.authorization_id, 'text', 50001, 'over'), /BUDGET_EXCEEDED/);
      const unknown = await reserve(b.authorization_id, 'text', 49000, 'unknown');
      await tx(async (c) => {
        await c.query('SAVEPOINT overrun_case');
        await settleGenerationSpend(c, unknown, 50000);
        await assert.rejects(checkBoundedAdmission(c, b, owner), /STOPPED/);
        assert.equal(
          (
            await c.query('SELECT actual_micros FROM generation_budget_reservations WHERE id=$1', [
              unknown,
            ])
          ).rows[0].actual_micros,
          '50000',
        );
        await c.query('ROLLBACK TO SAVEPOINT overrun_case');
      });
      await pool.query(
        "UPDATE live_test_sessions SET state='stopped',stop_code='PROVIDER_OUTCOME_UNKNOWN' WHERE id=$1",
        [b.authorization_id],
      );
      await pool.query('UPDATE generation_budget_scopes SET blocked=true WHERE id=$1', [
        b.scope_id,
      ]);
      await assert.rejects(reserve(b.authorization_id, 'image', 1, 'after-unknown'), /STOPPED/);
      const retained = (
        await pool.query('SELECT * FROM generation_budget_reservations WHERE id=$1', [unknown])
      ).rows[0];
      assert.equal(retained.status, 'held');
      assert.equal(retained.actual_micros, null);
      assert.equal(await oldSnapshot(), preserved);
      const newUsage = (
        await pool.query(
          "SELECT sum(CASE WHEN status='held' THEN upper_micros ELSE actual_micros END) total FROM generation_budget_reservations WHERE scope_id=$1",
          [b.scope_id],
        )
      ).rows[0];
      assert.equal(newUsage.total, '499000');
      // Direct NPC terminal helper uses real PG provider-budget/wallet locks.
      // No NPC provider is constructed or dispatched; the job data is synthetic.
      const configModule = require.resolve('../../apps/api/dist/config');
      require.cache[configModule] = {
        id: configModule,
        filename: configModule,
        loaded: true,
        exports: { config: { DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: 'test' } },
      };
      const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service');
      const { ManualLiveProvider } = require('../../apps/api/dist/live-test/provider');
      const engine = Object.create(NpcAiEngine.prototype);
      engine.provider = { id: 'direct-lock-fixture', external: true };
      await pool.query(
        "INSERT INTO npc_ai_provider_budgets(provider_id,cap_micros,reserved_micros) VALUES('direct-lock-fixture',1000,50)",
      );
      await assert.rejects(
        tx(async (c) => {
          await c.query('SELECT * FROM npc_ai_provider_budgets WHERE provider_id=$1 FOR UPDATE', [
            engine.provider.id,
          ]);
          await engine.excludeLegacyOwnerBypass(c);
        }),
        /GENERATION_AUTHORITY_IMMUTABLE/,
      );
      assert.equal(
        (await pool.query('SELECT balance_subunits FROM spark_wallets WHERE owner_id=$1', [owner]))
          .rows[0].balance_subunits,
        '1000000',
      );
      const failedQuote = await makeSparkQuote('npc-failure-lock', '50', 'npc');
      const nextQuote = await makeSparkQuote('npc-next-lock', '20', 'npc');
      await tx((c) => accounting.reserve(c, owner, failedQuote.id));
      const npc = {
        id: randomUUID(),
        provider_id: 'direct-lock-fixture',
        provider_upper_micros: '50',
        provider_budget_status: 'reserved',
        spark_hold_id: failedQuote.id,
        payer_user_id: owner,
      };
      const enqueue = await barrierClient(),
        terminal = await barrierClient();
      await enqueue.query('BEGIN');
      await terminal.query('BEGIN');
      await enqueue.query("SET LOCAL lock_timeout='3000ms'");
      await terminal.query("SET LOCAL lock_timeout='3000ms'");
      await enqueue.query('SELECT * FROM npc_ai_provider_budgets WHERE provider_id=$1 FOR UPDATE', [
        npc.provider_id,
      ]);
      const failure = (async () => {
        await engine.settleNpcSparks(terminal, npc, {
          outcome: 'failure_policy_pending',
          receiptId: 'npc-failure',
        });
        await engine.settleProvider(terminal, npc, 0, false);
      })();
      for (let tries = 0; ; tries++) {
        const blockers = (await pool.query('SELECT pg_blocking_pids($1) p', [terminal.processID]))
          .rows[0].p;
        if (blockers.includes(enqueue.processID)) break;
        assert.ok(tries < 100, 'NPC terminal must wait for provider budget before wallet');
        await new Promise((r) => setTimeout(r, 10));
      }
      await accounting.reserve(enqueue, owner, nextQuote.id);
      await enqueue.query('COMMIT');
      await failure;
      await terminal.query('COMMIT');
      releaseBarrier(enqueue);
      releaseBarrier(terminal);
      assert.equal(
        (await pool.query('SELECT status FROM spark_holds WHERE id=$1', [failedQuote.id])).rows[0]
          .status,
        'pending',
      );
      const successful = {
        ...npc,
        id: randomUUID(),
        spark_hold_id: nextQuote.id,
        provider_budget_status: 'spent',
      };
      await tx(async (c) => {
        const success = {
          outcome: 'success',
          actualMicros: '5',
          evidence: 'configured_rates',
          receiptId: 'npc-success',
        };
        await engine.settleNpcSparks(c, successful, success);
        await engine.settleNpcSparks(c, successful, success);
      });
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM spark_ledger WHERE hold_id=$1 AND kind='capture'",
            [nextQuote.id],
          )
        ).rows[0].n,
        1,
      );
      const walletAfter = (
        await pool.query(
          'SELECT balance_subunits,held_subunits FROM spark_wallets WHERE owner_id=$1',
          [owner],
        )
      ).rows[0];
      assert.deepEqual(walletAfter, { balance_subunits: '999990', held_subunits: '66950' });
      // Actual wrapped engine -> GenerationAuthority settlement and reconciliation
      // must wait on provider budget BEFORE taking the shared global fence.
      const { GenerationAuthority } = require('../../apps/api/dist/generation/service');
      const { fenceGenerationAdmission } = require('../../apps/api/dist/generation/scope-fence');
      const campaignId = randomUUID();
      await pool.query(
        'INSERT INTO game_campaigns(id,owner_id,playable_version,state) VALUES($1,$2,$3,$4)',
        [campaignId, owner, 'synthetic', '{}'],
      );
      for (const reconcile of [false, true]) {
        const providerId = 'wrapped-lock-' + reconcile,
          requestId = randomUUID(),
          jobId = randomUUID(),
          reservation = randomUUID(),
          permit = randomUUID();
        await pool.query(
          'INSERT INTO npc_ai_provider_budgets(provider_id,cap_micros,reserved_micros,unknown_micros) VALUES($1,1000,$2,$3)',
          [providerId, reconcile ? 0 : 10, reconcile ? 10 : 0],
        );
        await pool.query(
          "INSERT INTO generation_budget_reservations(id,scope_id,actor_id,kind,operation_key,upper_micros,status) VALUES($1,$2,$3,'text',($1::uuid)::text,10,'held')",
          [reservation, b.scope_id, owner],
        );
        await pool.query(
          "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,requester_user_id,context) VALUES($1,$2,$3,'speech',($1::uuid)::text,$4,'{}')",
          [requestId, campaignId, jobId, owner],
        );
        await pool.query(
          "INSERT INTO npc_ai_jobs(id,campaign_id,npc_id,operation_id,request_hash,origin,purpose,context_hash,context,provider_id,provider_version,policy_version,status,reservation_expires_at,provider_upper_micros,provider_budget_status) VALUES($1,$2,($1::uuid)::text,$3,'fixture','system','speech','fixture','{}',$4,'fixture','fixture','reconciling',now()+interval '1 hour',10,$5)",
          [jobId, campaignId, randomUUID(), providerId, reconcile ? 'unknown' : 'reserved'],
        );
        await pool.query(
          "INSERT INTO live_test_text_permits(id,session_id,campaign_id,request_id,operation_id,context_hash,round_id,phase_epoch,reservation_id,state,job_id) VALUES($1,$2,$3,$4,$5,'fixture','fixture',1,$6,$7,$8)",
          [
            permit,
            b.authorization_id,
            campaignId,
            requestId,
            randomUUID(),
            reservation,
            reconcile ? 'unknown' : 'authorized',
            jobId,
          ],
        );
        const actualJob = (await pool.query('SELECT * FROM npc_ai_jobs WHERE id=$1', [jobId]))
          .rows[0];
        const wrapped = Object.create(ManualLiveProvider.prototype);
        wrapped.session = Object.create(GenerationAuthority.prototype);
        engine.provider = wrapped;
        const competing = await barrierClient();
        await competing.query('BEGIN');
        await competing.query("SET LOCAL lock_timeout='3000ms'");
        await competing.query(
          'SELECT * FROM npc_ai_provider_budgets WHERE provider_id=$1 FOR UPDATE',
          [providerId],
        );
        let terminalPid;
        engine.db = {
          tx: (work) =>
            tx(async (c) => {
              terminalPid = c.processID;
              await c.query("SET LOCAL lock_timeout='3000ms'");
              return work(c);
            }),
        };
        const eventKey = 'fixture-' + randomUUID();
        const completion = reconcile
          ? engine.reconcile(jobId, eventKey, 0)
          : engine.db.tx((c) => engine.settleProvider(c, actualJob, 0, false));
        for (let tries = 0; ; tries++) {
          const blockers = terminalPid
            ? (await pool.query('SELECT pg_blocking_pids($1) p', [terminalPid])).rows[0].p
            : [];
          if (blockers.includes(competing.processID)) break;
          assert.ok(tries < 100, 'wrapped terminal must wait for provider budget');
          await new Promise((r) => setTimeout(r, 10));
        }
        await fenceGenerationAdmission(competing);
        await competing.query('COMMIT');
        releaseBarrier(competing);
        await completion;
        if (reconcile) await engine.reconcile(jobId, eventKey, 0);
        assert.equal(
          (
            await pool.query(
              'SELECT actual_micros FROM generation_budget_reservations WHERE id=$1',
              [reservation],
            )
          ).rows[0].actual_micros,
          '0',
        );
        assert.equal(
          (await pool.query('SELECT state FROM live_test_text_permits WHERE id=$1', [permit]))
            .rows[0].state,
          reconcile ? 'settled' : 'cancelled',
        );
      }
      // Reuse only the two disposable wrapped fixtures as an expired mixed-provider
      // sweep. Both provider rows must be locked before the first shared fence.
      await pool.query(
        "UPDATE npc_ai_jobs SET status='reserved',provider_budget_status='reserved',provider_actual_micros=NULL,reservation_expires_at=now()-interval '1 minute' WHERE provider_id LIKE 'wrapped-lock-%'",
      );
      await pool.query(
        "UPDATE npc_ai_provider_budgets SET reserved_micros=10,unknown_micros=0,spent_micros=0 WHERE provider_id LIKE 'wrapped-lock-%'",
      );
      await pool.query(
        "UPDATE live_test_text_permits SET state='authorized' WHERE campaign_id=$1",
        [campaignId],
      );
      const sweepCompetitor = await barrierClient();
      await sweepCompetitor.query('BEGIN');
      await sweepCompetitor.query("SET LOCAL lock_timeout='3000ms'");
      await sweepCompetitor.query(
        "SELECT * FROM npc_ai_provider_budgets WHERE provider_id='wrapped-lock-true' FOR UPDATE",
      );
      let sweepPid;
      engine.db = {
        tx: (work) =>
          tx(async (c) => {
            sweepPid = c.processID;
            await c.query("SET LOCAL lock_timeout='3000ms'");
            return work(c);
          }),
      };
      const sweeping = engine.sweep(campaignId);
      for (let tries = 0; ; tries++) {
        const blockers = sweepPid
          ? (await pool.query('SELECT pg_blocking_pids($1) p', [sweepPid])).rows[0].p
          : [];
        if (blockers.includes(sweepCompetitor.processID)) break;
        assert.ok(tries < 100, 'mixed-provider sweep must prelock its financial rows');
        await new Promise((r) => setTimeout(r, 10));
      }
      await fenceGenerationAdmission(sweepCompetitor);
      await sweepCompetitor.query('COMMIT');
      releaseBarrier(sweepCompetitor);
      await sweeping;
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM npc_ai_jobs WHERE provider_id LIKE 'wrapped-lock-%' AND status='stale'",
          )
        ).rows[0].n,
        2,
      );
      // Operator erasure must fail fast on the provider row BEFORE locking auth/scope.
      // This executes the real data-request lock helper, not a recreated lock sequence.
      const { lockManualLiveData } = await import('../../scripts/manual-live-data-requests.mjs');
      const retainedReceipt = await barrierClient();
      await retainedReceipt.query('BEGIN');
      await retainedReceipt.query("SET LOCAL lock_timeout='3000ms'");
      await retainedReceipt.query(
        "SELECT * FROM npc_ai_provider_budgets WHERE provider_id='wrapped-lock-false' FOR UPDATE",
      );
      await assert.rejects(
        tx((c) => lockManualLiveData(c, owner, [{ id: campaignId }])),
        (e) => e.code === '55P03',
      );
      await locked(retainedReceipt, b.authorization_id);
      await fenceGenerationAdmission(retainedReceipt);
      await retainedReceipt.query('COMMIT');
      releaseBarrier(retainedReceipt);
      await tx((c) => lockManualLiveData(c, owner, [{ id: campaignId }]));
      // Wrapped NPC work must never capture a second direct hold.
      engine.provider = Object.create(ManualLiveProvider.prototype);
      await assert.rejects(
        tx((c) =>
          engine.settleNpcSparks(c, npc, { outcome: 'unknown', receiptId: 'invalid-double-hold' }),
        ),
        /SPARK_ACCOUNTING_AUTHORITY_CONFLICT/,
      );
    } finally {
      await Promise.all(
        [...barrierClients].map(async (c) => {
          try {
            await c.query('ROLLBACK');
          } finally {
            c.release();
          }
        }),
      );
      await pool.end();
      await pg.stop();
    }
  },
);
