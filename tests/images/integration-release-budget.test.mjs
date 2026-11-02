/** Disposable PostgreSQL only: open-alpha actor isolation, strict Sparks, no provider transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db } from '../game/support-runtime.mjs';
const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db.js');
const { defaultImagePolicy } = require('../../apps/api/dist/image-generation/contracts.js');
const {
  reserveGenerationSpend,
  settleGenerationSpend,
} = require('../../apps/api/dist/image-generation/budget.js');
const {
  quoteSparks,
  reserveSparks,
  settleReservationSparks,
  sparkTariff,
} = require('../../apps/api/dist/generation/sparks-hooks.js');
const database = new Db();
const code = (value) => value?.getResponse?.().code ?? value?.message;
const rejectCode = (expected) => (value) => code(value) === expected;
const {
  aggregateGenerationExposure,
} = require('../../apps/api/dist/generation/aggregate-exposure.js');
const aggregateUsed = async () => (await aggregateGenerationExposure(db)).totalMicros;
async function actor({ balance = 1000, enabled = true, wallet = true } = {}) {
  const id = randomUUID(),
    authorization = randomUUID();
  const handle = `release_${id.replaceAll('-', '').slice(0, 12)}`;
  await db.query(
    "INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,'not-a-valid-login-hash','Synthetic release actor',$3)",
    [id, `${handle}@example.test`, handle],
  );
  if (wallet)
    await db.query(
      'INSERT INTO spark_wallets(owner_id,enabled,balance_subunits) VALUES($1,$2,$3)',
      [id, enabled, balance],
    );
  const p = {
    ...defaultImagePolicy,
    scopeId: `release:${id}`,
    generationMode: 'release',
    generationAuthorizationId: authorization,
    generationConfigFingerprint: 'a'.repeat(64),
    generationPolicyRevision: 1,
    generationPolicyHash: 'a'.repeat(64),
    approved: true,
    externalEnabled: true,
    costBasis: 'approved_estimate',
    verifiedUpperMicros: null,
    operationalReserveMicros: 60,
    estimatedTotalMicros: 50,
    totalCapMicros: 1000000,
    imageCapMicros: 1000000,
    textCapMicros: 1000000,
    releaseAggregateCapMicros: Number(await aggregateUsed()) + 1000000,
  };
  await db.query(
    'INSERT INTO generation_budget_scopes(id,approved,total_cap_micros,image_cap_micros,text_cap_micros) VALUES($1,true,1000000,1000000,1000000)',
    [p.scopeId],
  );
  await db.query(
    "INSERT INTO live_test_sessions(id,owner_id,scope_id,expires_at,cap_micros,state,mode,config_hash,owner_handle,text_cap_micros,image_cap_micros,policy_revision,policy_hash) VALUES($1,$2,$3,NULL,1000000,'active','release',$4,NULL,1000000,1000000,1,$4)",
    [authorization, id, p.scopeId, p.generationConfigFingerprint],
  );
  return { id, p };
}
async function quote(a, reserve = 60) {
  const sourceId = randomUUID();
  return database.tx((c) =>
    quoteSparks(
      c,
      {
        ownerId: a.id,
        operationId: sourceId,
        sourceKind: 'image',
        sourceId,
        reserveSubunits: String(reserve),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        providerQuote: { fixture: true, sourceId },
        tariff: sparkTariff(
          { model: 'synthetic', inputMicrosPerMillion: 1000000, outputMicrosPerMillion: 1000000 },
          'synthetic',
          'release-fixture-v1',
        ),
      },
      { required: true },
    ),
  );
}
async function reserve(a, q, operation = randomUUID()) {
  return database.tx(async (c) => {
    const reservation = await reserveGenerationSpend(c, a.p, a.id, 'image', operation, 60);
    await reserveSparks(c, a.id, q, reservation, { required: true });
    return reservation;
  });
}
await test(
  'release financial admission is actor-bound, atomic, and retains liabilities',
  { timeout: 45000 },
  async (t) => {
    try {
      assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^images-test-/);
      await t.test('missing/disabled/zero wallets cannot skip charging', async () => {
        for (const options of [{ wallet: false }, { enabled: false }, { balance: 0 }]) {
          const a = await actor(options);
          await assert.rejects(
            quote(a),
            rejectCode(options.balance === 0 ? 'INSUFFICIENT_SPARKS' : 'SPARK_WALLET_NOT_ENABLED'),
          );
          await assert.rejects(
            reserve(a, null),
            rejectCode(options.balance === 0 ? 'SPARK_QUOTE_REQUIRED' : 'SPARK_WALLET_NOT_ENABLED'),
          );
          await assert.rejects(
            database.tx(async (c) => {
              const reservation = await reserveGenerationSpend(
                c,
                a.p,
                a.id,
                'image',
                randomUUID(),
                60,
              );
              // Caller omits the required option: persisted release provenance still fails closed.
              await reserveSparks(c, a.id, null, reservation);
            }),
            rejectCode(options.balance === 0 ? 'SPARK_QUOTE_REQUIRED' : 'SPARK_WALLET_NOT_ENABLED'),
          );
          assert.equal(
            (
              await db.query('SELECT id FROM generation_budget_reservations WHERE scope_id=$1', [
                a.p.scopeId,
              ])
            ).rowCount,
            0,
          );
        }
      });
      await t.test(
        'two users reserve independently, replay cannot double-hold, forged authority fails',
        async () => {
          const a = await actor(),
            b = await actor();
          const qa = await quote(a),
            qb = await quote(b),
            operation = randomUUID();
          const [ra, rb] = await Promise.all([reserve(a, qa, operation), reserve(b, qb)]);
          assert.notEqual(ra, rb);
          assert.equal(await reserve(a, qa, operation), ra);
          assert.equal(
            (await db.query('SELECT held_subunits FROM spark_wallets WHERE owner_id=$1', [a.id]))
              .rows[0].held_subunits,
            '60',
          );
          await assert.rejects(
            reserve({ id: b.id, p: a.p }, qb),
            rejectCode('GENERATION_AUTHORIZATION_MISMATCH'),
          );
          const extra = await quote(a);
          await assert.rejects(reserve(a, extra), rejectCode('GENERATION_OUTSTANDING_REQUEST'));
        },
      );
      await t.test('cross-user aggregate race admits at most the explicit ceiling', async () => {
        const a = await actor(),
          b = await actor();
        const qa = await quote(a),
          qb = await quote(b);
        const cap = Number(await aggregateUsed()) + 100;
        a.p.releaseAggregateCapMicros = b.p.releaseAggregateCapMicros = cap;
        const results = await Promise.allSettled([reserve(a, qa), reserve(b, qb)]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(
          code(results.find((r) => r.status === 'rejected').reason),
          'GENERATION_AGGREGATE_BUDGET_EXCEEDED',
        );
        assert.ok((await aggregateUsed()) <= BigInt(cap));
      });
      await t.test(
        'unknown holds stay pending; a late overrun affects its actor, not another user',
        async () => {
          const a = await actor(),
            b = await actor();
          const qa = await quote(a),
            reservation = await reserve(a, qa);
          await database.tx((c) =>
            settleReservationSparks(c, reservation, {
              outcome: 'unknown',
              receiptId: 'synthetic-unknown',
            }),
          );
          await database.tx(async (c) => {
            await settleGenerationSpend(c, reservation, 75);
            await settleReservationSparks(c, reservation, {
              outcome: 'success',
              actualMicros: '75',
              evidence: 'reported',
              receiptId: 'synthetic-late',
            });
          });
          const held = (
            await db.query('SELECT status,captured_subunits FROM spark_holds WHERE id=$1', [qa])
          ).rows[0];
          assert.deepEqual(held, { status: 'pending', captured_subunits: null });
          assert.equal(
            (
              await db.query('SELECT blocked FROM generation_budget_scopes WHERE id=$1', [
                a.p.scopeId,
              ])
            ).rows[0].blocked,
            true,
          );
          assert.ok(await reserve(b, await quote(b)));
          assert.equal(
            (
              await db.query(
                'SELECT actual_micros FROM generation_budget_reservations WHERE id=$1',
                [reservation],
              )
            ).rows[0].actual_micros,
            '75',
          );
        },
      );
      await t.test(
        'legacy unlinked counters reduce release aggregate availability without rewriting history',
        async () => {
          const {
            aggregateGenerationExposure,
          } = require('../../apps/api/dist/generation/aggregate-exposure.js');
          const before = await aggregateGenerationExposure(db);
          const providerId = `legacy-${randomUUID()}`;
          await db.query(
            'INSERT INTO npc_ai_provider_budgets(provider_id,cap_micros,reserved_micros,spent_micros,unknown_micros,overrun_micros) VALUES($1,1000,10,20,30,40)',
            [providerId],
          );
          const after = await aggregateGenerationExposure(db);
          assert.equal(after.legacyNpcMicros - before.legacyNpcMicros, 100n);
          const a = await actor();
          a.p.releaseAggregateCapMicros = Number(before.totalMicros) + 120;
          await assert.rejects(
            reserve(a, await quote(a)),
            rejectCode('GENERATION_AGGREGATE_BUDGET_EXCEEDED'),
          );
          assert.equal(
            (
              await db.query(
                'SELECT overrun_micros FROM npc_ai_provider_budgets WHERE provider_id=$1',
                [providerId],
              )
            ).rows[0].overrun_micros,
            '40',
          );
        },
      );
      await t.test(
        'native/permit shared receipts count once, mock is explicit, NULL provenance stays charged',
        async () => {
          const {
            aggregateGenerationExposure,
          } = require('../../apps/api/dist/generation/aggregate-exposure.js');
          const insertJob = async (
            a,
            {
              reservation = null,
              external = true,
              upper = 60,
              actual = 60,
              status = 'spent',
              spent = 60,
              unknown = 0,
              overrun = 0,
              permit = false,
            } = {},
          ) => {
            const campaignId = randomUUID(),
              jobId = randomUUID(),
              providerId = `aggregate-${randomUUID()}`;
            await db.query(
              "INSERT INTO game_campaigns(id,owner_id,playable_version,state) VALUES($1,$2,'synthetic','{}')",
              [campaignId, a.id],
            );
            await db.query(
              'INSERT INTO npc_ai_provider_budgets(provider_id,cap_micros,spent_micros,unknown_micros,overrun_micros) VALUES($1,10000,$2,$3,$4)',
              [providerId, spent, unknown, overrun],
            );
            await db.query(
              "INSERT INTO npc_ai_jobs(id,campaign_id,npc_id,operation_id,request_hash,origin,requester_user_id,payer_user_id,purpose,context_hash,context,provider_id,provider_version,policy_version,status,reservation_expires_at,provider_upper_micros,provider_actual_micros,provider_budget_status,provider_external,generation_authorization_id,generation_reservation_id) VALUES($1,$2,'fixture',$3,'fixture','user',$4,$4,'plan','fixture','{}',$5,'fixture','fixture','committed',now()+interval '1 hour',$6,$7,$8,$9,$10,$11)",
              [
                jobId,
                campaignId,
                randomUUID(),
                a.id,
                providerId,
                upper,
                actual,
                status,
                external,
                reservation ? a.p.generationAuthorizationId : null,
                permit ? null : reservation,
              ],
            );
            if (permit) {
              const requestId = randomUUID();
              await db.query(
                "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,context,job_id) VALUES($1,$2,'fixture','plan','fixture','{}',$3)",
                [requestId, campaignId, jobId],
              );
              await db.query(
                "INSERT INTO live_test_text_permits(id,session_id,campaign_id,request_id,operation_id,context_hash,round_id,phase_epoch,reservation_id,state,job_id) VALUES($1,$2,$3,$4,$5,'fixture',$6,1,$7,'settled',$8)",
                [
                  randomUUID(),
                  a.p.generationAuthorizationId,
                  campaignId,
                  requestId,
                  randomUUID(),
                  randomUUID(),
                  reservation,
                  jobId,
                ],
              );
            }
            return { jobId, providerId };
          };
          const native = await actor();
          const reservation = await reserve(native, await quote(native));
          await database.tx((c) => settleGenerationSpend(c, reservation, 100));
          const before = await aggregateGenerationExposure(db);
          const j = await insertJob(native, { reservation, actual: 100, spent: 60, overrun: 40 });
          assert.deepEqual(
            await aggregateGenerationExposure(db),
            before,
            'Clipped60+overrun40 is already shared actual100',
          );
          await db.query(
            'UPDATE npc_ai_provider_budgets SET spent_micros=spent_micros+100 WHERE provider_id=$1',
            [j.providerId],
          );
          assert.equal(
            (await aggregateGenerationExposure(db)).totalMicros - before.totalMicros,
            100n,
            'Unexplained provider remainder is never subtracted',
          );
          const legacy = await actor();
          const permitReservation = await reserve(legacy, await quote(legacy));
          await database.tx((c) => settleGenerationSpend(c, permitReservation, 60));
          const permitBefore = await aggregateGenerationExposure(db);
          await insertJob(legacy, { reservation: permitReservation, permit: true });
          assert.deepEqual(
            await aggregateGenerationExposure(db),
            permitBefore,
            'Historical permit link also counts once',
          );
          const mockBefore = await aggregateGenerationExposure(db);
          await insertJob(await actor(), { external: false });
          assert.deepEqual(
            await aggregateGenerationExposure(db),
            mockBefore,
            'Only explicit provider_external=false is free',
          );
          await insertJob(await actor(), { external: null });
          assert.equal(
            (await aggregateGenerationExposure(db)).totalMicros - mockBefore.totalMicros,
            60n,
            'NULL provenance is not a mock',
          );
        },
      );
    } finally {
      await database.onApplicationShutdown();
      await db.end();
    }
  },
);
