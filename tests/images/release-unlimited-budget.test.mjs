/** Disposable PostgreSQL only: open-alpha actor isolation, strict Sparks, no provider transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db } from '../game/support-runtime.mjs';
import { requestEstimateOwnerProfile } from './owner-config-fixture.mjs';
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
async function actor({ balance = 1000, enabled = true, wallet = true, unlimited = true } = {}) {
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
  if (unlimited) {
    await db.query(
      'UPDATE generation_budget_scopes SET unlimited_allowance=true,total_cap_micros=NULL,text_cap_micros=NULL,image_cap_micros=NULL WHERE id=$1',
      [p.scopeId],
    );
    await db.query(
      'UPDATE live_test_sessions SET unlimited_allowance=true,cap_micros=NULL,text_cap_micros=NULL,image_cap_micros=NULL WHERE id=$1',
      [authorization],
    );
    Object.assign(p, {
      releaseUnlimitedAllowance: true,
      totalCapMicros: null,
      textCapMicros: null,
      imageCapMicros: null,
      releaseAggregateCapMicros: null,
    });
  }
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
        reserveSubunits: String(reserve * 2), // Provider-micro fixture at 2 Sparks per cent.
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
  'explicit unlimited release allowance preserves financial admission',
  { timeout: 45000 },
  async (t) => {
    try {
      assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^images-test-/);
      await t.test(
        'real release admission persists explicit uncapped policy without changing wallet',
        async () => {
          const { readGenerationConfig } = require('../../apps/api/dist/generation/config.js');
          const { ReleaseAdmission } = require('../../apps/api/dist/generation/release.js');
          const profile = requestEstimateOwnerProfile();
          delete profile.totalCapMicros;
          delete profile.textCapMicros;
          delete profile.imageCapMicros;
          const config = readGenerationConfig({
            GENERATION_MODE: 'release',
            GENERATION_CONFIG_JSON: JSON.stringify({ ...profile, allowance: 'unlimited' }),
          });
          assert.equal(config.totalCapMicros, null);
          assert.equal(config.aggregateCapMicros, null);
          const id = randomUUID();
          await db.query(
            "INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,'unusable','Unlimited fixture',$3)",
            [id, `${id}@example.test`, 'unl_' + id.replaceAll('-', '').slice(0, 12)],
          );
          await db.query(
            'INSERT INTO spark_wallets(owner_id,enabled,balance_subunits) VALUES($1,true,1000)',
            [id],
          );
          const admission = new ReleaseAdmission(config);
          const policy = await database.tx((c) => admission.policy(c, id));
          assert.equal(policy.releaseUnlimitedAllowance, true);
          assert.equal(policy.totalCapMicros, null);
          assert.equal(policy.releaseAggregateCapMicros, null);
          await database.tx((c) =>
            admission.active(c, policy.generationAuthorizationId, config.configFingerprint),
          );
          const row = (
            await db.query(
              'SELECT unlimited_allowance,cap_micros,text_cap_micros,image_cap_micros FROM live_test_sessions WHERE id=$1',
              [policy.generationAuthorizationId],
            )
          ).rows[0];
          assert.deepEqual(row, {
            unlimited_allowance: true,
            cap_micros: null,
            text_cap_micros: null,
            image_cap_micros: null,
          });
          assert.equal(
            (await db.query('SELECT balance_subunits FROM spark_wallets WHERE owner_id=$1', [id]))
              .rows[0].balance_subunits,
            '1000',
          );
        },
      );
      await t.test(
        'null lifetime/global caps admit finite wallet-backed reserves despite historical spend',
        async () => {
          const a = await actor();
          await db.query(
            "INSERT INTO generation_budget_reservations(id,scope_id,actor_id,kind,operation_key,upper_micros,actual_micros,status) VALUES($1,$2,$3,'text',$4,2000000,2000000,'settled')",
            [randomUUID(), a.p.scopeId, a.id, randomUUID()],
          );
          const q = await quote(a),
            operation = randomUUID();
          const r = await reserve(a, q, operation);
          assert.equal(await reserve(a, q, operation), r);
          assert.equal(
            (await db.query('SELECT held_subunits FROM spark_wallets WHERE owner_id=$1', [a.id]))
              .rows[0].held_subunits,
            '120',
          );
          await assert.rejects(reserve(a, q), rejectCode('GENERATION_OUTSTANDING_REQUEST'));
          await database.tx(async (c) => {
            await settleGenerationSpend(c, r, 50);
            await settleReservationSparks(c, r, {
              outcome: 'success',
              evidence: 'configured_rates',
              actualMicros: '50',
              receiptId: 'unlimited-synthetic',
            });
          });
          assert.deepEqual(
            (
              await db.query(
                'SELECT balance_subunits,held_subunits FROM spark_wallets WHERE owner_id=$1',
                [a.id],
              )
            ).rows[0],
            { balance_subunits: '900', held_subunits: '0' },
          );
        },
      );
      await t.test('forged policy flag cannot remove persisted finite caps', async () => {
        const a = await actor({ unlimited: false });
        a.p.releaseUnlimitedAllowance = true;
        a.p.releaseAggregateCapMicros = null;
        a.p.totalCapMicros = null;
        a.p.textCapMicros = null;
        a.p.imageCapMicros = null;
        await assert.rejects(
          reserve(a, await quote(a)),
          rejectCode('GENERATION_AUTHORIZATION_MISMATCH'),
        );
      });
      await t.test(
        'missing disabled and insufficient wallets still reject unlimited requests',
        async () => {
          for (const options of [{ wallet: false }, { enabled: false }, { balance: 0 }]) {
            const a = await actor(options);
            await assert.rejects(
              quote(a),
              rejectCode(
                options.balance === 0 ? 'INSUFFICIENT_SPARKS' : 'SPARK_WALLET_NOT_ENABLED',
              ),
            );
            await assert.rejects(
              reserve(a, null),
              rejectCode(
                options.balance === 0 ? 'SPARK_QUOTE_REQUIRED' : 'SPARK_WALLET_NOT_ENABLED',
              ),
            );
          }
        },
      );
      await t.test(
        'unknown holds stay pending and ordinary legacy scopes cannot become unlimited',
        async () => {
          const a = await actor(),
            q = await quote(a),
            r = await reserve(a, q);
          await database.tx((c) =>
            settleReservationSparks(c, r, { outcome: 'unknown', receiptId: 'unknown-unlimited' }),
          );
          await database.tx((c) =>
            settleReservationSparks(c, r, {
              outcome: 'success',
              evidence: 'configured_rates',
              actualMicros: '10',
              receiptId: 'late-unlimited',
            }),
          );
          assert.equal(
            (await db.query('SELECT status FROM spark_holds WHERE id=$1', [q])).rows[0].status,
            'pending',
          );
          await assert.rejects(
            db.query(
              'INSERT INTO generation_budget_scopes(id,unlimited_allowance,total_cap_micros,text_cap_micros,image_cap_micros) VALUES($1,true,NULL,NULL,NULL)',
              ['legacy-' + randomUUID()],
            ),
            (e) => e.code === '23514',
          );
          await assert.rejects(
            db.query(
              'INSERT INTO generation_budget_scopes(id,total_cap_micros,text_cap_micros,image_cap_micros) VALUES($1,NULL,NULL,NULL)',
              ['release:' + randomUUID()],
            ),
            (e) => e.code === '23514',
          );
        },
      );
    } finally {
      await db.end();
      await database.onApplicationShutdown();
    }
  },
);
