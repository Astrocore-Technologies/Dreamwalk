/** Actual PostgreSQL ledger races, no provider or external transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { db, startApi, stopApi, client } from '../game/support-runtime.mjs';
const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db.js');
const {
  reserveGenerationSpend,
  settleGenerationSpend,
  releaseUndispatchedGenerationSpend,
} = require('../../apps/api/dist/image-generation/budget.js');
const { defaultImagePolicy } = require('../../apps/api/dist/image-generation/contracts.js');
const database = new Db();
const errorCode = (e) => e?.getResponse?.().code;
await test(
  'image/text shared budget uses real transactional limits and settlement identity',
  { timeout: 45000 },
  async (t) => {
    try {
      await startApi();
      const user = await client().register();
      const policy = () => ({
        ...defaultImagePolicy,
        scopeId: randomUUID(),
        approved: true,
        externalEnabled: true,
        verifiedUpperMicros: 60,
        totalCapMicros: 100,
        textCapMicros: 100,
        imageCapMicros: 100,
      });
      const reserve = (p, kind, amount, key = randomUUID()) =>
        database.tx((c) => reserveGenerationSpend(c, p, user.user.id, kind, key, amount));
      await t.test(
        'simultaneous image and text reservations cannot exceed one total cap',
        async () => {
          const p = policy();
          const results = await Promise.allSettled([
            reserve(p, 'image', 60),
            reserve(p, 'text', 60),
          ]);
          assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
          assert.equal(
            errorCode(results.find((x) => x.status === 'rejected').reason),
            'GENERATION_BUDGET_EXCEEDED',
          );
          assert.equal(
            Number(
              (
                await db.query(
                  "SELECT sum(upper_micros) AS held FROM generation_budget_reservations WHERE scope_id=$1 AND status='held'",
                  [p.scopeId],
                )
              ).rows[0].held,
            ),
            60,
          );
        },
      );
      await t.test(
        'unknown exposure stays held, exact reserve replay is unique, changed payload conflicts',
        async () => {
          const p = policy(),
            key = randomUUID(),
            id = await reserve(p, 'image', 60, key);
          assert.equal(await reserve(p, 'image', 60, key), id);
          await assert.rejects(
            () => reserve(p, 'image', 59, key),
            (e) => errorCode(e) === 'IDEMPOTENCY_CONFLICT',
          );
          await assert.rejects(
            () => reserve(p, 'text', 41),
            (e) => errorCode(e) === 'GENERATION_BUDGET_EXCEEDED',
          );
          assert.equal(
            (await db.query('SELECT status FROM generation_budget_reservations WHERE id=$1', [id]))
              .rows[0].status,
            'held',
          );
        },
      );
      await t.test(
        'two different simultaneous receipts cannot silently settle the same reservation',
        async () => {
          const p = policy(),
            id = await reserve(p, 'image', 60);
          // Hold scope so both callers arrive before either settlement may commit.
          const lock = await db.connect();
          await lock.query('BEGIN');
          await lock.query('SELECT id FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [
            p.scopeId,
          ]);
          const first = database.tx((c) => settleGenerationSpend(c, id, 20));
          const second = database.tx((c) => settleGenerationSpend(c, id, 30));
          const outcomes = Promise.allSettled([first, second]);
          await new Promise((resolve) => setTimeout(resolve, 150));
          await lock.query('COMMIT');
          lock.release();
          const results = await outcomes;
          assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
          assert.equal(
            errorCode(results.find((x) => x.status === 'rejected').reason),
            'COST_CONFLICT',
          );
          const actual = Number(
            (
              await db.query(
                'SELECT actual_micros FROM generation_budget_reservations WHERE id=$1',
                [id],
              )
            ).rows[0].actual_micros,
          );
          assert.ok([20, 30].includes(actual));
          await database.tx((c) => settleGenerationSpend(c, id, actual));
        },
      );
      await t.test(
        'known overrun is retained and blocks subsequent spend; release cannot erase settled cost',
        async () => {
          const p = policy(),
            id = await reserve(p, 'image', 60);
          await database.tx((c) => settleGenerationSpend(c, id, 110));
          const row = (
            await db.query('SELECT * FROM generation_budget_reservations WHERE id=$1', [id])
          ).rows[0];
          assert.equal(Number(row.actual_micros), 110);
          await database.tx((c) => releaseUndispatchedGenerationSpend(c, id));
          assert.equal(
            (await db.query('SELECT status FROM generation_budget_reservations WHERE id=$1', [id]))
              .rows[0].status,
            'settled',
          );
          await assert.rejects(
            () => reserve(p, 'image', 1),
            (e) => errorCode(e) === 'GENERATION_BUDGET_BLOCKED',
          );
        },
      );
    } finally {
      await stopApi();
      await database.pool.end();
      await db.end();
    }
  },
);
