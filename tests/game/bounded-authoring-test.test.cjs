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
    } finally {
      await pool.end();
      await pg.stop();
    }
  },
);
