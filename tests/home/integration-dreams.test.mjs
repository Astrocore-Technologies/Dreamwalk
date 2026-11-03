import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, startApi, stopApi, client } from '../game/support-runtime.mjs';
import { SparksAccounting } from '../../apps/api/dist/generation/sparks-accounting.js';
import { grantRegistrationDreams } from '../../apps/api/dist/generation/starter-dreams.js';
import { quoteFunding } from '../../apps/api/dist/generation/currency-funding.js';
import { createSparkTariffSnapshot } from '../../packages/contracts/dist/sparks.js';
const accounting = new SparksAccounting();
async function tx(work) {
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
}
const tariff = createSparkTariffSnapshot({
  provider: 'fixture',
  model: 'fixture',
  providerRateVersion: 'v1',
  inputMicrosPerMillion: '100000',
  cachedInputMicrosPerMillion: '10000',
  outputMicrosPerMillion: '500000',
});
await test('Dreams-first dual wallet grants once and atomically splits every generation currency', async (t) => {
  try {
    await startApi();
    const user = await client().register(),
      legacy = await client().registerLegacyFixture(),
      guest = client();
    const ownerId = user.user.id;
    const wallet = () => user.request('/currencies/wallet');
    const quote = (amount, kind = 'text') =>
      tx((c) =>
        accounting.quote(c, {
          ownerId,
          operationId: randomUUID(),
          sourceKind: kind,
          sourceId: randomUUID(),
          reserveSubunits: amount,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          policyVersion: 'test',
          providerQuote: { synthetic: true },
          tariff,
        }),
      );
    const settle = (id, micros) =>
      tx((c) =>
        accounting.settle(c, ownerId, id, {
          outcome: 'success',
          actualMicros: micros,
          evidence: 'configured_rates',
          receiptId: 'synthetic',
        }),
      );
    await t.test(
      'new accounts get exactly 50 Dreams and zero Sparks; old users get neither backfill nor daily grant',
      async () => {
        const w = await wallet();
        assert.equal(w.dreams.balanceSubunits, '500000');
        assert.equal(w.sparks.balanceSubunits, '0');
        assert.equal(w.sparks.enabled, true);
        assert.equal(w.dreams.spendingAvailable, true);
        await Promise.all(
          Array.from({ length: 5 }, () => tx((c) => grantRegistrationDreams(c, ownerId))),
        );
        assert.equal(
          (await wallet()).dreams.ledger.filter((x) => x.kind === 'starter_grant').length,
          1,
        );
        assert.equal(await tx((c) => grantRegistrationDreams(c, legacy.user.id)), false);
        assert.equal((await legacy.request('/currencies/wallet')).dreams.balanceSubunits, '0');
        await guest.request('/currencies/wallet', undefined, 'GET', 401);
      },
    );
    await t.test(
      'all-free text: duplicate reserves/settlement do not double charge and unused hold releases',
      async () => {
        const q = await quote('100000');
        assert.deepEqual((await tx((c) => quoteFunding(c, q.id))).dreamsReservedSubunits, '100000');
        const holds = await Promise.all(
          Array.from({ length: 5 }, () => tx((c) => accounting.reserve(c, ownerId, q.id))),
        );
        assert.ok(holds.every((h) => h.id === q.id));
        assert.equal((await wallet()).dreams.heldSubunits, '100000');
        assert.equal((await wallet()).sparks.heldSubunits, '0');
        await settle(q.id, '5000');
        await settle(q.id, '5000');
        assert.equal((await wallet()).dreams.balanceSubunits, '490000');
        assert.equal((await wallet()).dreams.heldSubunits, '0');
        assert.equal((await wallet()).sparks.balanceSubunits, '0');
        const f = await tx((c) => quoteFunding(c, q.id));
        assert.equal(f.dreamsCapturedSubunits, '10000');
        assert.equal(f.sparksCapturedSubunits, '0');
        await assert.rejects(settle(q.id, '5001'), /CONFLICT/);
      },
    );
    await t.test(
      'image generation uses identical free-first split, actual capture and refund rules',
      async () => {
        // Explicit isolated balance fixture, never a product funding path.
        await db.query('UPDATE spark_wallets SET balance_subunits=200000 WHERE owner_id=$1', [
          ownerId,
        ]);
        const q = await quote('600000', 'image');
        await tx((c) => accounting.reserve(c, ownerId, q.id));
        let w = await wallet();
        assert.equal(w.dreams.heldSubunits, '490000');
        assert.equal(w.sparks.heldSubunits, '110000');
        await settle(q.id, '275000');
        w = await wallet();
        assert.equal(w.dreams.balanceSubunits, '0');
        assert.equal(w.sparks.balanceSubunits, '140000');
        assert.equal(w.sparks.heldSubunits, '0');
        const f = await tx((c) => quoteFunding(c, q.id));
        assert.equal(f.dreamsCapturedSubunits, '490000');
        assert.equal(f.sparksCapturedSubunits, '60000');
        assert.equal(
          w.sparks.ledger
            .filter((x) => x.kind === 'capture')
            .reduce((sum, x) => sum + BigInt(x.amountSubunits), 0n),
          60000n,
        );
      },
    );
    await t.test(
      'legacy in-flight quote stays Sparks-only even when Dreams later become available',
      async () => {
        await db.query('UPDATE dream_wallets SET balance_subunits=100000 WHERE owner_id=$1', [
          ownerId,
        ]);
        const id = randomUUID();
        await db.query(
          "INSERT INTO spark_quotes(id,owner_id,operation_id,request_hash,source_kind,source_id,price_snapshot,reserve_subunits,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,50000,now()+interval '1 minute')",
          [
            id,
            ownerId,
            randomUUID(),
            'legacy-fixture',
            'text',
            randomUUID(),
            JSON.stringify({ tariff, providerQuote: {} }),
          ],
        );
        await tx((c) => accounting.reserve(c, ownerId, id));
        await settle(id, '10000');
        const w = await wallet();
        assert.equal(w.dreams.balanceSubunits, '100000');
        assert.equal(w.sparks.balanceSubunits, '120000');
        assert.equal(await tx((c) => quoteFunding(c, id)), undefined);
      },
    );
    await t.test(
      'unknown outcomes keep both reserves and require explicit reconciliation',
      async () => {
        const q = await quote('150000', 'npc');
        await tx((c) => accounting.reserve(c, ownerId, q.id));
        await tx((c) =>
          accounting.settle(c, ownerId, q.id, { outcome: 'unknown', receiptId: 'unknown' }),
        );
        let w = await wallet();
        assert.equal(w.dreams.heldSubunits, '100000');
        assert.equal(w.sparks.heldSubunits, '50000');
        await assert.rejects(
          tx((c) =>
            accounting.settle(c, ownerId, q.id, {
              outcome: 'not_dispatched',
              receiptId: 'confirmed',
            }),
          ),
          /RECONCILIATION_REQUIRED/,
        );
        await tx((c) =>
          accounting.settle(
            c,
            ownerId,
            q.id,
            { outcome: 'not_dispatched', receiptId: 'confirmed' },
            true,
          ),
        );
        w = await wallet();
        assert.equal(w.dreams.heldSubunits, '0');
        assert.equal(w.sparks.heldSubunits, '0');
        assert.equal(w.dreams.balanceSubunits, '100000');
        assert.equal(w.sparks.balanceSubunits, '120000');
      },
    );
    await t.test(
      'concurrent different quotes cannot overdraw either wallet; overruns retain both holds',
      async () => {
        const one = await quote('150000'),
          two = await quote('150000');
        const results = await Promise.allSettled(
          [one, two].map((q) => tx((c) => accounting.reserve(c, ownerId, q.id))),
        );
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
        const id = results[0].status === 'fulfilled' ? one.id : two.id;
        await settle(id, '100000'); // 200000 exceeds the agreed total reserve of 150000.
        let w = await wallet();
        assert.equal(w.dreams.balanceSubunits, '100000');
        assert.equal(w.sparks.balanceSubunits, '120000');
        assert.equal(w.dreams.heldSubunits, '100000');
        assert.equal(w.sparks.heldSubunits, '50000');
        await tx((c) =>
          accounting.settle(
            c,
            ownerId,
            id,
            { outcome: 'not_dispatched', receiptId: 'reviewed-fixture' },
            true,
          ),
        );
        w = await wallet();
        assert.equal(w.dreams.heldSubunits, '0');
        assert.equal(w.sparks.heldSubunits, '0');
      },
    );
    await t.test(
      'insufficient funds and unauthorized reserve roll back, ledger and allocation are immutable',
      async () => {
        const q = await quote('999999');
        await assert.rejects(
          tx((c) => accounting.reserve(c, ownerId, q.id)),
          /INSUFFICIENT/,
        );
        await assert.rejects(
          tx((c) => accounting.reserve(c, legacy.user.id, q.id)),
          /QUOTE_NOT_FOUND/,
        );
        assert.equal((await wallet()).dreams.heldSubunits, '0');
        assert.equal((await wallet()).sparks.heldSubunits, '0');
        await assert.rejects(
          db.query('UPDATE dream_ledger SET amount_subunits=0 WHERE owner_id=$1', [ownerId]),
          /immutable/,
        );
        await assert.rejects(
          db.query(
            'UPDATE spark_holds SET sparks_reserved_subunits=0 WHERE owner_id=$1 AND sparks_reserved_subunits>0',
            [ownerId],
          ),
          /immutable/i,
        );
      },
    );
  } finally {
    await stopApi();
    await db.end();
  }
});
