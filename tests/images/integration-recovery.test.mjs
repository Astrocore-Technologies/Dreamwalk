/** Isolated PostgreSQL, fake image transport, no real credential or provider call. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client } from '../game/support-runtime.mjs';
import { createStory, failureCode, fixturePng } from './support.mjs';
import { ownerProfile, ownerEnvironment } from './owner-config-fixture.mjs';
const require = createRequire(import.meta.url);
const { ImageGenerationEngine } = require('../../apps/api/dist/image-generation/service.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const {
  ImageProviderFailure,
} = require('../../apps/api/dist/image-generation/error-diagnostics.js');
const { GenerationAuthority } = require('../../apps/api/dist/generation/service.js');
const { readOwnerGenerationConfig } = require('../../apps/api/dist/generation/config.js');
const { createOwnerImageRuntime } = require('../../apps/api/dist/image-generation/config.js');
const {
  isRecoverableModelRejection,
  recoverModelRejectionTx,
} = require('../../apps/api/dist/image-generation/recovery.js');
await test('explicit model rejection recovery keeps one financial scope and requires external billing evidence', async (t) => {
  let sql, database;
  try {
    await startApi();
    const owner = await client().register(),
      other = await client().register(),
      story = await createStory(owner);
    await stopApi();
    assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^images-test-/);
    sql = await db.connect();
    const { Db } = require('../../apps/api/dist/db.js');
    database = new Db();
    const configured = readOwnerGenerationConfig(ownerEnvironment(ownerProfile(), owner.handle));
    const authority = new GenerationAuthority(database, configured);
    await authority.claim(owner.user.id, {
      consent: true,
      candidateFingerprint: configured.configFingerprint,
    });
    const runtime = createOwnerImageRuntime(configured, {
      resolveApiKey: () => {
        throw Error('NO_REAL_KEY_ALLOWED');
      },
    });
    let calls = 0;
    const diagnostic = {
      httpStatus: 403,
      providerCode: 'model_not_found',
      providerType: 'invalid_request_error',
      category: 'model_access',
      requestId: 'req_recovery_fixture',
      evidence: 'provider_reported',
      billing: 'unknown',
    };
    const engine = new ImageGenerationEngine(
      database,
      new AssetReuseService(database),
      {
        id: 'fake-rejection',
        generate: async () => {
          calls++;
          throw new ImageProviderFailure(diagnostic);
        },
      },
      runtime.policy,
      runtime.capabilities,
    );
    engine.setLiveAuthorizer((c, u, id) => authority.authorizeImage(c, u, id));
    const request = {
      adventureId: story.id,
      prompt: 'Synthetic empty room',
      title: 'Recovery fixture',
      kind: 'background',
      camera: 'top-down',
      tags: [],
      background: 'opaque',
      referenceRevisionIds: [],
      privateReferenceAssetIds: [],
      mode: 'external',
      declineReuse: true,
      rights: {
        basis: 'generated',
        licenseLabel: 'Synthetic fixture',
        attribution: '',
        allowAuthorReuse: false,
        attested: true,
      },
    };
    const quoted = await engine.quote(owner.user.id, request);
    const job = await engine.enqueue(owner.user.id, {
      quoteId: quoted.quote.id,
      operationId: randomUUID(),
      consent: true,
      estimateRiskConsent: true,
    });
    await engine.workOnce();
    const held = (
      await sql.query(
        'SELECT r.*,j.safe_diagnostic FROM generation_budget_reservations r JOIN image_generation_jobs j ON j.reservation_id=r.id WHERE j.id=$1',
        [job.id],
      )
    ).rows[0];
    const evidence = {
      source: 'provider_usage',
      reference: 'usage-report-fixture-001',
      requestId: diagnostic.requestId,
      actualMicros: 0,
      chargeVerified: true,
      modelAccessRestored: true,
    };
    const operationId = randomUUID(),
      reviewBody = { mode: 'review', operationId, evidence };
    let review;
    await t.test(
      'HTTP 403 alone leaves the full hold; timeout/5xx/unknown are ineligible',
      async () => {
        assert.equal(calls, 1);
        assert.equal(held.status, 'held');
        assert.equal(held.actual_micros, null);
        assert.equal(isRecoverableModelRejection(diagnostic), true);
        for (const d of [
          null,
          { ...diagnostic, httpStatus: 500 },
          { ...diagnostic, providerCode: undefined },
          { ...diagnostic, requestId: undefined },
          { ...diagnostic, httpStatus: 408 },
        ])
          assert.equal(isRecoverableModelRejection(d), false);
        await assert.rejects(
          engine.recoverModelRejection(owner.user.id, job.id, {
            ...reviewBody,
            evidence: { ...evidence, chargeVerified: false },
          }),
        );
        await assert.rejects(
          engine.recoverModelRejection(other.user.id, job.id, reviewBody),
          failureCode('NOT_FOUND'),
        );
        review = await engine.recoverModelRejection(owner.user.id, job.id, reviewBody);
        assert.equal(review.status, 'reviewed');
        assert.equal(
          (
            await sql.query('SELECT status FROM generation_budget_reservations WHERE id=$1', [
              held.id,
            ])
          ).rows[0].status,
          'held',
        );
      },
    );
    await t.test('stale review and conflicting stops cannot clear an authorization', async () => {
      await assert.rejects(
        engine.recoverModelRejection(owner.user.id, job.id, {
          ...reviewBody,
          mode: 'apply',
          expectedFingerprint: 'a'.repeat(64),
        }),
        failureCode('STALE_STATE'),
      );

      // Rollback-isolated conflict fixture: never erase a committed immutable veto
      // merely to reuse its grant for the independent happy-path confirmation.
      for (const cause of [
        'PROVIDER_HTTP_403',
        'DATA_ERASED',
        'ADMIN_STOP',
        'AUTHORIZATION_EXPIRED',
      ]) {
        await sql.query('BEGIN');
        try {
          await sql.query("UPDATE live_test_sessions SET stop_code=$1 WHERE mode='owner'", [cause]);
          await sql.query(
            "UPDATE live_test_sessions SET stop_code='IMAGE_MODEL_ACCESS_REJECTION' WHERE mode='owner'",
          );
          await assert.rejects(
            recoverModelRejectionTx(sql, owner.user.id, job.id, reviewBody, runtime.policy),
            failureCode('IMAGE_RECOVERY_DURABLE_STOP_REQUIRES_REVIEW'),
          );
          assert.equal(
            (
              await sql.query(
                'SELECT count(*)::int n FROM image_generation_recoveries WHERE job_id=$1',
                [job.id],
              )
            ).rows[0].n,
            0,
          );
        } finally {
          await sql.query('ROLLBACK');
        }
      }
      await assert.rejects(
        recoverModelRejectionTx(sql, owner.user.id, job.id, reviewBody, {
          ...runtime.policy,
          externalExpiresAt: '2000-01-01T00:00:00.000Z',
        }),
        failureCode('IMAGE_RECOVERY_DURABLE_STOP_REQUIRES_REVIEW'),
      );
      for (const mutation of [
        "UPDATE adventures SET deleted_at=now(),status='archived',deletion_id=gen_random_uuid() WHERE id=(SELECT adventure_id FROM image_generation_jobs WHERE id=$1)",
        "UPDATE image_generation_jobs SET safe_diagnostic=jsonb_set(safe_diagnostic,'{providerCode}','\"model_access_denied\"') WHERE id=$1",
        'UPDATE image_generation_jobs SET cancel_requested=true WHERE id=$1',
      ]) {
        await sql.query('BEGIN');
        try {
          await sql.query(mutation, mutation.includes('$1') ? [job.id] : []);
          await assert.rejects(
            recoverModelRejectionTx(sql, owner.user.id, job.id, reviewBody, runtime.policy),
            failureCode('IMAGE_RECOVERY_DURABLE_STOP_REQUIRES_REVIEW'),
          );
        } finally {
          await sql.query('ROLLBACK');
        }
      }
    });
    await t.test(
      'apply settles only confirmed cost, preserves original error, and duplicate/restarted calls settle once',
      async () => {
        const apply = { ...reviewBody, mode: 'apply', expectedFingerprint: review.fingerprint };
        await sql.query(
          `CREATE FUNCTION reject_recovery_fixture_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='image_rejection_recovered' THEN RAISE EXCEPTION 'INJECTED_RECOVERY_AUDIT_FAILURE'; END IF; RETURN NEW; END $$`,
        );
        await sql.query(
          'CREATE TRIGGER reject_recovery_fixture_audit BEFORE INSERT ON audit FOR EACH ROW EXECUTE FUNCTION reject_recovery_fixture_audit()',
        );
        try {
          await assert.rejects(
            engine.recoverModelRejection(owner.user.id, job.id, apply),
            /INJECTED_RECOVERY_AUDIT_FAILURE/,
          );
          assert.equal(
            (
              await sql.query(
                'SELECT count(*)::int n FROM image_generation_recoveries WHERE job_id=$1',
                [job.id],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await sql.query('SELECT status FROM generation_budget_reservations WHERE id=$1', [
                held.id,
              ])
            ).rows[0].status,
            'held',
          );
          assert.equal((await engine.get(owner.user.id, job.id)).status, 'unknown');
        } finally {
          await sql.query('DROP TRIGGER reject_recovery_fixture_audit ON audit');
          await sql.query('DROP FUNCTION reject_recovery_fixture_audit()');
        }

        for (const result of await Promise.all([
          engine.recoverModelRejection(owner.user.id, job.id, apply),
          engine.recoverModelRejection(owner.user.id, job.id, apply),
        ]))
          assert.equal(result.status, 'recovered');
        assert.equal(
          (await engine.recoverModelRejection(owner.user.id, job.id, apply)).status,
          'recovered',
        );
        assert.equal(
          (await engine.modelRejectionRecovery(owner.user.id, job.id)).status,
          'recovered',
        );
        const row = (
          await sql.query(
            "SELECT j.status,j.error_code,j.safe_diagnostic,r.actual_micros,r.status budget_status,s.blocked,a.state,a.stop_code FROM image_generation_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id JOIN generation_budget_scopes s ON s.id=r.scope_id JOIN live_test_sessions a ON a.scope_id=s.id AND a.mode='owner' WHERE j.id=$1",
            [job.id],
          )
        ).rows[0];
        assert.equal(row.status, 'rejected');
        assert.equal(row.budget_status, 'settled');
        assert.equal(Number(row.actual_micros), 0);
        assert.equal(row.state, 'active');
        assert.equal(row.blocked, false);
        assert.equal(row.safe_diagnostic.requestId, diagnostic.requestId);
        assert.equal(row.error_code, 'DISPATCH_UNCERTAIN');
        const receipts = (
          await sql.query('SELECT * FROM image_generation_recoveries WHERE job_id=$1', [job.id])
        ).rows;
        assert.equal(receipts.length, 1);
        assert.equal(receipts[0].original_job.status, 'unknown');
        assert.equal(receipts[0].evidence.source, 'provider_usage');
        await assert.rejects(
          engine.recoverModelRejection(owner.user.id, job.id, {
            ...apply,
            evidence: { ...evidence, actualMicros: 1 },
          }),
          failureCode('IDEMPOTENCY_CONFLICT'),
        );
        await engine.workOnce();
        assert.equal(calls, 1);
      },
    );
    await t.test('late contradictory images cannot revive the confirmed rejection', async () => {
      await assert.rejects(
        engine.recordResult(job.id, {
          bytes: await fixturePng(),
          mime: 'image/png',
          requestId: diagnostic.requestId,
          actualMicros: 0,
        }),
        failureCode('RECOVERED_REJECTION_RECEIPT_CONFLICT'),
      );
      assert.equal((await engine.get(owner.user.id, job.id)).status, 'rejected');
      assert.equal(
        (
          await sql.query('SELECT count(*)::int n FROM image_generation_attempts WHERE job_id=$1', [
            job.id,
          ])
        ).rows[0].n,
        1,
      );
    });
    await t.test(
      'a new image needs a fresh specific quote and consent; no retry is dispatched',
      async () => {
        const newQuote = await engine.quote(owner.user.id, request);
        assert.notEqual(newQuote.quote.id, quoted.quote.id);
        await assert.rejects(
          engine.enqueue(owner.user.id, {
            quoteId: newQuote.quote.id,
            operationId: randomUUID(),
            consent: false,
            estimateRiskConsent: true,
          }),
        );
        assert.equal(calls, 1);
      },
    );
  } finally {
    if (sql) {
      sql.release();
    }
    await stopApi();
    if (database) await database.pool.end();
    await db.end();
  }
});
