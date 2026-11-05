/** Disposable local PostgreSQL and synthetic text provider only. No production history or provider transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client } from './support-runtime.mjs';
import { requestEstimateOwnerProfile } from '../images/owner-config-fixture.mjs';
const require = createRequire(import.meta.url);
const { activateReleaseDeployment } = require('../images/release-deployment-fixture.cjs');
const { Db } = require('../../apps/api/dist/db.js');
const {
  KnownAuthoringSettlement,
} = require('../../apps/api/dist/live-test/known-authoring-settlement.js');
const { DreamsAccounting } = require('../../apps/api/dist/generation/dreams-accounting.js');
const { AuthoringTextEngine } = require('../../apps/api/dist/live-test/authoring-text.js');
const { GenerationAuthority } = require('../../apps/api/dist/generation/service.js');
const { readGenerationConfig } = require('../../apps/api/dist/generation/config.js');
const { estimateTextRequest } = require('../../apps/api/dist/generation/estimates.js');
const { digest } = require('../../apps/api/dist/ai/context.js');
const database = new Db();
async function scenario(dreamReserve) {
  try {
    assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^game-test-/);
    await startApi();
    const owner = await client().registerLegacyFixture(),
      outsider = await client().registerLegacyFixture();
    await stopApi();
    await db.query(
      'INSERT INTO spark_wallets(owner_id,enabled,balance_subunits) VALUES($1,true,1000000)',
      [owner.user.id],
    );
    if (dreamReserve)
      await db.query(
        'INSERT INTO dream_wallets(owner_id,enabled,balance_subunits) VALUES($1,true,$2)',
        [owner.user.id, dreamReserve],
      );
    const profile = requestEstimateOwnerProfile();
    Object.assign(profile.text, {
      inputMicrosPerMillion: 100000,
      outputMicrosPerMillion: 500000,
      cachePricing: {
        cachedInputMicrosPerMillion: 10000,
        cacheWrite30mMicrosPerMillion: 125000,
        cacheWrite12hMicrosPerMillion: 250000,
      },
    });
    const config = readGenerationConfig({
      GENERATION_MODE: 'release',
      GENERATION_CONFIG_JSON: JSON.stringify({ ...profile, aggregateCapMicros: 10000000 }),
    });
    await database.tx((c) => activateReleaseDeployment(c, config));
    const authority = new GenerationAuthority(database, config);
    const projectId = randomUUID(),
      sourceHash = digest('synthetic source'),
      readsetHash = digest('synthetic readset');
    await db.query(
      "INSERT INTO visual_authoring_projects(id,owner_id,kind,brief,source_hash,status) VALUES($1,$2,'location',$3,$4,'concept')",
      [
        projectId,
        owner.user.id,
        JSON.stringify({ name: 'Synthetic authoring recovery' }),
        sourceHash,
      ],
    );
    let dispatches = 0,
      commits = 0;
    const provider = {
      version: 'synthetic-authoring-recovery-v1',
      profile: config.text,
      prepareTextRequest(context) {
        const body = JSON.stringify(context);
        return { body, snapshot: estimateTextRequest(body, config.text, this.version) };
      },
      async generate() {
        dispatches++;
        return {
          proposal: { title: 'Unusable synthetic plan' },
          requestId: `synthetic-${randomUUID()}`,
          usage: {
            inputTokens: 6405,
            cachedInputTokens: 1383,
            outputTokens: 201,
            cacheWriteInputTokens: 5019,
            cacheWriteInputTokensDetails: { ttl30mTokens: 5019, ttl12hTokens: 0 },
            costMicros: 743,
            costEvidence: 'configured_rates',
            costVerifiedForSparks: true,
          },
        };
      },
    };
    const engine = new AuthoringTextEngine(database, authority, provider, {
      version: 'synthetic-v1',
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
      assert.equal(row.owner_id, owner.user.id);
      assert.equal(row.source_hash, sourceHash);
    };
    const quote = await engine.quote(
      owner.user.id,
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
    const queued = await engine.enqueue(
      owner.user.id,
      { operationId: randomUUID(), quoteId: quote.id, consent: true },
      guard,
    );
    // The mixed case simulates a pre-upgrade persisted failure. Recovery must
    // close it without a browser or provider dispatch after a process restart.
    const auto = KnownAuthoringSettlement.prototype.settleAutomatic;
    if (dreamReserve) KnownAuthoringSettlement.prototype.settleAutomatic = async () => undefined;
    try {
      await engine.run(owner.user.id, queued.id, guard, async () => {
        commits++;
        throw new Error('MAP_IMAGE_UNCERTAIN');
      });
    } finally {
      KnownAuthoringSettlement.prototype.settleAutomatic = auto;
    }
    const path = `/generation/authoring-text/jobs/${queued.id}/settlement`;
    const immutable = async () => ({
      job: (await db.query('SELECT * FROM live_authoring_text_jobs WHERE id=$1', [queued.id]))
        .rows[0],
      native: (await db.query('SELECT * FROM live_authoring_text_quotes WHERE id=$1', [quote.id]))
        .rows[0],
      project: (await db.query('SELECT * FROM visual_authoring_projects WHERE id=$1', [projectId]))
        .rows[0],
      reservation: (
        await db.query(
          'SELECT r.* FROM generation_budget_reservations r JOIN live_authoring_text_jobs j ON j.reservation_id=r.id WHERE j.id=$1',
          [queued.id],
        )
      ).rows[0],
      authorization: (
        await db.query(
          'SELECT s.* FROM live_test_sessions s JOIN live_authoring_text_jobs j ON j.session_id=s.id WHERE j.id=$1',
          [queued.id],
        )
      ).rows[0],
      scope: (
        await db.query(
          'SELECT s.* FROM generation_budget_scopes s JOIN generation_budget_reservations r ON r.scope_id=s.id JOIN live_authoring_text_jobs j ON j.reservation_id=r.id WHERE j.id=$1',
          [queued.id],
        )
      ).rows[0],
    });
    const before = await immutable();
    assert.equal(before.job.status, 'stale');
    assert.equal(before.job.error_code, 'MAP_IMAGE_UNCERTAIN');
    assert.equal(before.reservation.status, 'settled');
    assert.equal(dispatches, 1);
    assert.equal(commits, 1);
    const holdId = before.job.spark_quote_id;
    const heldDreamId = (
      await db.query('SELECT dream_hold_id FROM spark_holds WHERE id=$1', [holdId])
    ).rows[0].dream_hold_id;
    const accounting = async () => ({
      hold: (await db.query('SELECT * FROM spark_holds WHERE id=$1', [holdId])).rows[0],
      wallet: (await db.query('SELECT * FROM spark_wallets WHERE owner_id=$1', [owner.user.id]))
        .rows[0],
      dreams: dreamReserve
        ? {
            hold: (await db.query('SELECT * FROM dream_holds WHERE id=$1', [heldDreamId])).rows[0],
            wallet: (
              await db.query('SELECT * FROM dream_wallets WHERE owner_id=$1', [owner.user.id])
            ).rows[0],
            ledger: (
              await db.query('SELECT * FROM dream_ledger WHERE hold_id=$1 ORDER BY event_key', [
                heldDreamId,
              ])
            ).rows,
          }
        : null,
      ledger: (
        await db.query('SELECT * FROM spark_ledger WHERE hold_id=$1 ORDER BY event_key', [holdId])
      ).rows,
    });
    const held = await accounting();
    assert.equal(held.hold.status, dreamReserve ? 'pending' : 'settled');
    assert.equal(held.hold.reason, dreamReserve ? 'failure_policy_pending' : null);
    const settlement = new KnownAuthoringSettlement(database, authority);
    const view = await settlement.handle(owner.user.id, queued.id);
    assert.deepEqual(await settlement.handle(owner.user.id, queued.id), view);
    assert.deepEqual(await accounting(), held, 'read-only review never settles a pending hold');
    assert.deepEqual(await immutable(), before);
    assert.equal(view.actualMicros, '743');
    assert.equal(view.captureSubunits, '1486');
    assert.equal(view.noAuthoringEffect, true);
    assert.equal(view.requiresConsent, !!dreamReserve);
    const body = {
      operationId: before.job.operation_id,
      holdId,
      expectedActualMicros: view.actualMicros,
      expectedReservedSubunits: view.reservedSubunits,
      expectedCaptureSubunits: view.captureSubunits,
      consent: true,
    };
    if (dreamReserve) {
      // Inject a nested accounting failure inside a disposable transaction only. The outer
      // ledger must roll back even if the shared accounting primitive returns a pending hold.
      const original = DreamsAccounting.prototype.settle;
      DreamsAccounting.prototype.settle = async (c, actorId, id) =>
        (await c.query('SELECT * FROM dream_holds WHERE id=$1 AND owner_id=$2', [id, actorId]))
          .rows[0];
      try {
        await assert.rejects(
          database.tx((c) => settlement.settleAutomatic(c, owner.user.id, queued.id)),
          (e) => e.getResponse?.().code === 'AUTHORING_SETTLEMENT_UNAVAILABLE',
        );
      } finally {
        DreamsAccounting.prototype.settle = original;
      }
      assert.deepEqual(
        await accounting(),
        held,
        'partial nested settlement rolls back both wallets and ledgers',
      );
      assert.deepEqual(await immutable(), before);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM audit WHERE target_id=$1 AND action='authoring.known_failure.settled'",
            [queued.id],
          )
        ).rows[0].n,
        0,
      );
    }
    const results = await Promise.all([
      database.tx((c) => settlement.settleAutomatic(c, owner.user.id, queued.id)),
      database.tx((c) => settlement.settleAutomatic(c, owner.user.id, queued.id)),
    ]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].status, 'settled');
    assert.equal(results[0].requiresConsent, false);
    const settled = await accounting();
    assert.equal(settled.wallet.balance_subunits, dreamReserve ? '999514' : '998514');
    if (dreamReserve) {
      assert.equal(settled.dreams.hold.status, 'settled');
      assert.equal(settled.dreams.hold.captured_subunits, '1000');
      assert.equal(settled.dreams.wallet.balance_subunits, '0');
      assert.equal(settled.dreams.wallet.held_subunits, '0');
      assert.deepEqual(
        settled.dreams.ledger
          .filter((r) => ['capture', 'release'].includes(r.kind))
          .map((r) => [r.kind, r.amount_subunits]),
        [
          ['capture', '1000'],
          ['release', '0'],
        ],
      );
    }
    assert.equal(settled.wallet.held_subunits, '0');
    assert.deepEqual(
      settled.ledger
        .filter((r) => ['capture', 'release'].includes(r.kind))
        .map((r) => [r.kind, r.amount_subunits]),
      [
        ['capture', view.funding.sparksCaptureSubunits],
        ['release', view.funding.sparksReleaseSubunits],
      ],
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM audit WHERE target_id=$1 AND action='authoring.known_failure.settled'",
          [queued.id],
        )
      ).rows[0].n,
      1,
    );
    assert.deepEqual(await immutable(), before);
    assert.equal(dispatches, 1);
    assert.equal(commits, 1);
    await settlement.recoverPending();
    await startApi();
    await outsider.request(path, undefined, 'GET', 404);
    await outsider.request(path, body, 'POST', 404);
    for (const patch of [
      { holdId: randomUUID() },
      { expectedActualMicros: '744' },
      { expectedReservedSubunits: '1' },
      { expectedCaptureSubunits: '1' },
    ])
      await owner.request(path, { ...body, ...patch }, 'POST', 409);
    await owner.request(path, { ...body, consent: false }, 'POST', 400);
    await stopApi('SIGKILL');
    await startApi();
    assert.deepEqual(await owner.request(path), results[0]);
    assert.deepEqual(await owner.request(path, body), results[0]);
    await owner.request(path, { ...body, operationId: randomUUID() }, 'POST', 409);
    assert.deepEqual(await accounting(), settled);
    assert.deepEqual(await immutable(), before);
  } finally {
    await stopApi();
  }
}
await test(
  'known authoring settlement uses one atomic receipt and survives concurrent/restart replay',
  { timeout: 120000 },
  async (t) => {
    try {
      await t.test('all Sparks', () => scenario(0));
      await t.test('mixed Dreams and Sparks', () => scenario(1000));
    } finally {
      await stopApi();
      await database.pool.end();
      await db.end();
    }
  },
);
