/** Disposable PostgreSQL, real accounting, synthetic providers only. Never production history. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db } from './support-runtime.mjs';
import { prepareMixedTerminalLiabilities } from './verified-access-fixtures.mjs';
import { requestEstimateOwnerProfile } from '../images/owner-config-fixture.mjs';
const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db.js');
const { activateReleaseDeployment } = require('../images/release-deployment-fixture.cjs');
const { readGenerationConfig } = require('../../apps/api/dist/generation/config.js');
const { GenerationAuthority } = require('../../apps/api/dist/generation/service.js');
const { ImageGenerationEngine } = require('../../apps/api/dist/image-generation/service.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const { createOwnerImageRuntime } = require('../../apps/api/dist/image-generation/config.js');
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
    "INSERT INTO spark_ledger(owner_id,event_key,kind,amount_subunits,evidence) VALUES($1,$2,'admin_credit',1000000,$3)",
    [id, `admin-adjust:v1:${randomUUID()}`, { actorId: id, reason: 'Synthetic fixture funding' }],
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
const {
  recoverVerifiedGenerationAccessTx,
} = require('../../apps/api/dist/generation/verified-access-recovery.js');
async function retainedKnownImage(who) {
  let release, signal;
  const started = new Promise((resolve) => {
    signal = resolve;
  });
  const delayed = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const images = engine({
    id: runtime.provider.id,
    generate: async () => {
      calls++;
      signal();
      return delayed;
    },
  });
  const q = await images.quote(who.id, input(who, false));
  const job = await images.enqueue(who.id, {
    quoteId: q.quote.id,
    operationId: randomUUID(),
    consent: true,
    estimateRiskConsent: true,
  });
  const work = images.workOnce();
  await started;
  await images.cancel(who.id, job.id);
  release({
    bytes: png,
    mime: 'image/png',
    requestId: `retained-${job.id}`,
    actualMicros: 71,
    costVerifiedForSparks: true,
  });
  await work;
  const source = (await db.query('SELECT * FROM image_generation_jobs WHERE id=$1', [job.id]))
    .rows[0];
  const hold = (await db.query('SELECT * FROM spark_holds WHERE id=$1', [source.spark_quote_id]))
    .rows[0];
  assert.equal(source.status, 'rejected');
  assert.equal(hold.status, 'pending');
  assert.equal(calls, 1);
  const snapshot = async () => ({
    source: (await db.query('SELECT * FROM image_generation_jobs WHERE id=$1', [job.id])).rows,
    hold: (await db.query('SELECT * FROM spark_holds WHERE id=$1', [source.spark_quote_id])).rows,
    ledger: (
      await db.query('SELECT * FROM spark_ledger WHERE hold_id=$1 ORDER BY id', [
        source.spark_quote_id,
      ])
    ).rows,
  });
  return { read: snapshot, before: await snapshot() };
}
async function recoveryScenario(kind) {
  const who = await actor();
  const mixed =
    kind === 'mixed'
      ? await prepareMixedTerminalLiabilities({ db, database, who, configured })
      : undefined;
  const retained = kind === 'retained' ? await retainedKnownImage(who) : undefined;
  let calls = 0;
  const receipt = {
    bytes: png,
    mime: 'image/png',
    requestId: `synthetic-${who.id}`,
    costVerifiedForSparks: true,
  };
  const images = engine({
    id: runtime.provider.id,
    generate: async () => {
      calls++;
      if (kind === 'unattributed')
        await db.query('UPDATE generation_budget_scopes SET blocked=true WHERE id=$1', [
          `release:${who.id}`,
        ]);
      return receipt;
    },
  });
  const q = await images.quote(who.id, input(who, true));
  const job = await images.enqueue(who.id, {
    quoteId: q.quote.id,
    operationId: randomUUID(),
    consent: true,
    estimateRiskConsent: true,
    automaticKnownCostPolicyHash: q.quote.automaticKnownCostSettlement.fingerprint,
  });
  await images.workOnce();
  const scopeId = `release:${who.id}`;
  const session = (await db.query('SELECT * FROM live_test_sessions WHERE scope_id=$1', [scopeId]))
    .rows[0];
  const scope = (await db.query('SELECT * FROM generation_budget_scopes WHERE id=$1', [scopeId]))
    .rows[0];
  assert.equal(session.state, 'stopped');
  assert.equal(session.stop_code, 'IMAGE_RESULT_UNKNOWN');
  assert.equal(scope.blocked, true);
  assert.ok(scope.stop_epoch_id);
  const recover = () =>
    database.tx((c) => recoverVerifiedGenerationAccessTx(c, scopeId, configured));
  assert.equal((await recover()).recovered, false, 'unknown cost remains stopped');
  if (kind === 'veto')
    await db.query(
      "UPDATE live_test_sessions SET state='stopped',stop_code=stop_code WHERE id=$1",
      [session.id],
    );
  if (kind === 'timeout' || kind === 'timeout-veto')
    await db.query(
      "UPDATE image_generation_jobs SET dispatch_deadline=clock_timestamp()-interval '1 second' WHERE id=$1",
      [job.id],
    );
  if (kind === 'cancel') await images.cancel(who.id, job.id);
  if (kind === 'timeout-veto')
    await db.query(
      "UPDATE live_test_sessions SET state='stopped',stop_code='AUTHORIZATION_EXPIRED' WHERE id=$1",
      [session.id],
    );
  await images.recordResult(job.id, { ...receipt, actualMicros: 100 });
  if (['timeout', 'timeout-veto', 'cancel'].includes(kind)) {
    const discarded = (
      await db.query('SELECT status,admitted_revision_id FROM image_generation_jobs WHERE id=$1', [
        job.id,
      ])
    ).rows[0];
    assert.equal(discarded.status, 'rejected');
    assert.equal(discarded.admitted_revision_id, null);
  } else {
    assert.equal((await recover()).recovered, false, 'generated but unadmitted remains stopped');
    await images.admit(job.id);
  }
  const financial = async () => ({
    wallet: (await db.query('SELECT * FROM spark_wallets WHERE owner_id=$1', [who.id])).rows,
    holds: (await db.query('SELECT * FROM spark_holds WHERE owner_id=$1', [who.id])).rows,
    ledger: (await db.query('SELECT * FROM spark_ledger WHERE owner_id=$1 ORDER BY id', [who.id]))
      .rows,
    reservations: (
      await db.query('SELECT * FROM generation_budget_reservations WHERE scope_id=$1', [scopeId])
    ).rows,
  });
  const before = await financial();
  const mixedBefore = mixed ? await mixed.readSnapshot() : undefined;
  if (kind === 'rollback') {
    await db.query(`CREATE FUNCTION synthetic_recovery_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_RECOVERY_FAULT'; END $$;
      CREATE TRIGGER synthetic_recovery_fault BEFORE INSERT ON audit FOR EACH ROW WHEN (NEW.action='generation.verified_access.recovered') EXECUTE FUNCTION synthetic_recovery_fault();`);
    try {
      await assert.rejects(recover(), /SYNTHETIC_RECOVERY_FAULT/);
    } finally {
      await db.query(
        'DROP TRIGGER synthetic_recovery_fault ON audit; DROP FUNCTION synthetic_recovery_fault()',
      );
    }
    assert.equal(
      (await db.query('SELECT blocked FROM generation_budget_scopes WHERE id=$1', [scopeId]))
        .rows[0].blocked,
      true,
    );
    assert.equal(
      (await db.query('SELECT state FROM live_test_sessions WHERE id=$1', [session.id])).rows[0]
        .state,
      'stopped',
    );
  }
  if (kind === 'contention') {
    const concurrent = await db.connect();
    try {
      await concurrent.query('BEGIN');
      await concurrent.query('SELECT id FROM image_generation_jobs WHERE id=$1 FOR UPDATE', [
        job.id,
      ]);
      await assert.rejects(recover(), (error) => error.code === '55P03');
      assert.equal(
        (await db.query('SELECT blocked FROM generation_budget_scopes WHERE id=$1', [scopeId]))
          .rows[0].blocked,
        true,
      );
    } finally {
      await concurrent.query('ROLLBACK');
      concurrent.release();
    }
  }
  const results = await Promise.all([recover(), recover()]);
  const expected = [
    'clean',
    'rollback',
    'timeout',
    'cancel',
    'mixed',
    'retained',
    'contention',
  ].includes(kind);
  assert.equal(
    results.filter((r) => r.recovered).length,
    expected ? 1 : 0,
    JSON.stringify(results),
  );
  const after = (await db.query('SELECT * FROM generation_budget_scopes WHERE id=$1', [scopeId]))
    .rows[0];
  assert.equal(after.blocked, !expected);
  assert.equal(
    (
      await db.query('SELECT count(*)::int n FROM generation_access_recoveries WHERE scope_id=$1', [
        scopeId,
      ])
    ).rows[0].n,
    expected ? 1 : 0,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM audit WHERE target_id=$1 AND action='generation.verified_access.recovered'",
        [session.id],
      )
    ).rows[0].n,
    expected ? 1 : 0,
  );
  assert.equal((await recover()).recovered, false);
  assert.deepEqual(await financial(), before, 'reopening never touches financial records');
  if (mixed)
    assert.deepEqual(
      await mixed.readSnapshot(),
      mixedBefore,
      'mixed terminal sources and accounting remain unchanged',
    );
  if (retained)
    assert.deepEqual(
      await retained.read(),
      retained.before,
      'old funded hold is never captured/released',
    );
  assert.equal(calls, 1);
  assert.equal(
    (
      await db.query('SELECT count(*)::int n FROM image_generation_attempts WHERE job_id=$1', [
        job.id,
      ])
    ).rows[0].n,
    1,
  );
}
async function provenanceMigration() {
  const c = await db.connect();
  const schema = `proof_${randomUUID().replaceAll('-', '')}`;
  const authorizationId = randomUUID();
  try {
    await c.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
      CREATE TABLE generation_budget_scopes(id text PRIMARY KEY,blocked boolean NOT NULL DEFAULT false);
      CREATE TABLE live_test_sessions(id uuid PRIMARY KEY,owner_id uuid,scope_id text,state text,stop_code text,policy_revision integer,policy_hash text,config_hash text);
      CREATE TABLE npc_ai_provider_budgets(provider_id text PRIMARY KEY,blocked boolean NOT NULL DEFAULT false);
      INSERT INTO generation_budget_scopes VALUES('historical',true),('future',false);
    `);
    await c.query(
      "INSERT INTO live_test_sessions VALUES($1,$1,'historical','stopped','IMAGE_RESULT_UNKNOWN',1,'policy','config')",
      [authorizationId],
    );
    const { readFile } = await import('node:fs/promises');
    await c.query(
      await readFile(
        new URL('../../packages/db/migrations/064_generation_stop_provenance.sql', import.meta.url),
        'utf8',
      ),
    );
    assert.equal(
      (await c.query('SELECT count(*)::int n FROM generation_stop_epochs')).rows[0].n,
      0,
      'migration never backfills',
    );
    await c.query('BEGIN');
    await c.query("SELECT set_config('dreamwalk.generation_stop_context',$1,true)", [
      JSON.stringify({
        authorizationId,
        sourceKind: 'image',
        sourceId: randomUUID(),
        reason: 'IMAGE_RESULT_UNKNOWN',
        stopClass: 'request',
        recoverable: true,
      }),
    ]);
    await c.query("UPDATE live_test_sessions SET state='stopped' WHERE id=$1", [authorizationId]);
    await c.query("UPDATE generation_budget_scopes SET blocked=true WHERE id='historical'");
    await c.query('COMMIT');
    assert.ok(
      (await c.query('SELECT baseline_unknown FROM generation_stop_epochs')).rows.every(
        (e) => e.baseline_unknown === true,
      ),
      'old true plus new eligible stop remains unknown baseline',
    );
    const fresh = randomUUID();
    await c.query(
      "INSERT INTO live_test_sessions(id,owner_id,scope_id,state,policy_revision,policy_hash,config_hash) VALUES($1,$1,'future','active',1,'policy','config')",
      [fresh],
    );
    await c.query('BEGIN');
    await c.query("SELECT set_config('dreamwalk.generation_stop_context',$1,true)", [
      JSON.stringify({
        authorizationId: fresh,
        sourceKind: 'image',
        sourceId: randomUUID(),
        reason: 'IMAGE_RESULT_UNKNOWN',
        stopClass: 'request',
        recoverable: true,
      }),
    ]);
    await c.query(
      "UPDATE live_test_sessions SET state='stopped',stop_code='IMAGE_RESULT_UNKNOWN' WHERE id=$1",
      [fresh],
    );
    await c.query("UPDATE generation_budget_scopes SET blocked=true WHERE id='future'");
    await c.query('COMMIT');
    const epoch = (
      await c.query(
        "SELECT e.* FROM generation_stop_epochs e JOIN generation_budget_scopes s ON s.stop_epoch_id=e.id WHERE s.id='future'",
      )
    ).rows[0];
    assert.equal(epoch.baseline_unknown, false);
    await c.query("UPDATE generation_budget_scopes SET blocked=true WHERE id='future'");
    const events = (
      await c.query('SELECT * FROM generation_stop_events WHERE epoch_id=$1 ORDER BY id', [
        epoch.id,
      ])
    ).rows;
    assert.deepEqual(
      events.map((e) => e.recoverable),
      [true, false],
    );
    assert.equal(events[1].reason, 'UNATTRIBUTED_STOP');
    await assert.rejects(
      c.query('UPDATE generation_stop_events SET recoverable=true WHERE id=$1', [events[1].id]),
      /immutable/,
    );
    await c.query("INSERT INTO generation_budget_scopes(id,blocked) VALUES('insert-stop',true)");
    assert.equal(
      (
        await c.query(
          "SELECT e.baseline_unknown FROM generation_stop_epochs e JOIN generation_budget_scopes s ON s.stop_epoch_id=e.id WHERE s.id='insert-stop'",
        )
      ).rows[0].baseline_unknown,
      true,
    );
    await c.query(
      "INSERT INTO npc_ai_provider_budgets(provider_id,blocked) VALUES('provider',true)",
    );
    assert.equal(
      (
        await c.query(
          "SELECT count(*)::int n FROM generation_stop_epochs WHERE target_kind='provider'",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await c.query('ROLLBACK');
    await c.query(`SET search_path TO public; DROP SCHEMA ${schema} CASCADE`);
    c.release();
  }
}
await test(
  'future verified access recovery: atomic, idempotent and no new provider work',
  { timeout: 120000 },
  async (t) => {
    try {
      assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^game-test-/);
      await t.test('future-only durable provenance migration', provenanceMigration);
      await database.tx((c) => activateReleaseDeployment(c, configured));
      for (const kind of process.env.VERIFIED_ACCESS_CASES?.split(',') ?? [
        'clean',
        'unattributed',
        'veto',
        'rollback',
        'timeout',
        'cancel',
        'timeout-veto',
        'mixed',
        'retained',
        'contention',
      ])
        await t.test(kind, () => recoveryScenario(kind));
    } finally {
      await database.pool.end();
      await db.end();
    }
  },
);
