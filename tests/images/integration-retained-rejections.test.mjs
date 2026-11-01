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
await test('a distinct consented image can use remaining budget while confirmed rejection holds remain intact', async (t) => {
  let sql, database;
  try {
    await startApi();
    const owner = await client().register(),
      story = await createStory(owner);
    await stopApi();
    assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^images-test-/);
    sql = await db.connect();
    const { Db } = require('../../apps/api/dist/db.js');
    database = new Db();
    const configured = readOwnerGenerationConfig(
      ownerEnvironment(
        {
          ...ownerProfile(),
          totalCapMicros: 200000,
          textCapMicros: 200000,
          imageCapMicros: 200000,
        },
        owner.handle,
      ),
    );
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
    const png = await require('sharp')(await fixturePng())
      .resize(1536, 1024)
      .png()
      .toBuffer();
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
          if (calls === 1) throw new ImageProviderFailure(diagnostic);
          return {
            bytes: png,
            mime: 'image/png',
            requestId: 'req_distinct_image_fixture',
            actualMicros: 5000,
          };
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

    const first = (await sql.query('SELECT * FROM image_generation_jobs WHERE id=$1', [job.id]))
      .rows[0];
    let secondJob;
    await t.test(
      'old hold is fully deducted; image-only capability does not activate text or alter the ledger',
      async () => {
        const status = await authority.status(owner.user.id);
        assert.equal(status.imageOnlyAdmission, true);
        assert.equal(status.retainedImageHoldMicros, 100000);
        assert.equal(status.remainingMicros, 100000);
        assert.equal(status.state, 'stopped');
        await assert.rejects(
          database.tx((c) => authority.resolveAuthorizationId(c, owner.user.id)),
        );
        assert.equal(
          (
            await sql.query('SELECT status FROM generation_budget_reservations WHERE id=$1', [
              first.reservation_id,
            ])
          ).rows[0].status,
          'held',
        );
        assert.equal(calls, 1);
      },
    );
    await t.test('timeout, 5xx and other ambiguous failures remain stopped', async () => {
      for (const d of [
        null,
        { ...diagnostic, httpStatus: 500 },
        { ...diagnostic, requestId: undefined },
        {
          ...diagnostic,
          providerCode: 'organization_verification_required',
          category: 'organization_verification',
        },
      ]) {
        await sql.query('UPDATE image_generation_jobs SET safe_diagnostic=$2 WHERE id=$1', [
          job.id,
          d,
        ]);
        await assert.rejects(engine.quote(owner.user.id, request));
        assert.equal((await authority.status(owner.user.id)).imageOnlyAdmission, false);
      }
      await sql.query('UPDATE image_generation_jobs SET safe_diagnostic=$2 WHERE id=$1', [
        job.id,
        first.safe_diagnostic,
      ]);
      assert.equal(calls, 1);
    });
    await t.test(
      'fresh quote and explicit consent admit one concurrent new image without releasing old hold',
      async () => {
        const a = await engine.quote(owner.user.id, request),
          b = await engine.quote(owner.user.id, request);
        assert.notEqual(a.quote.id, b.quote.id);
        assert.notEqual(a.quote.id, quoted.quote.id);
        await assert.rejects(
          engine.enqueue(owner.user.id, {
            quoteId: a.quote.id,
            operationId: randomUUID(),
            consent: false,
            estimateRiskConsent: true,
          }),
        );
        const results = await Promise.allSettled(
          [a, b].map((q) =>
            engine.enqueue(owner.user.id, {
              quoteId: q.quote.id,
              operationId: randomUUID(),
              consent: true,
              estimateRiskConsent: true,
            }),
          ),
        );
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        secondJob = results.find((r) => r.status === 'fulfilled').value;
        assert.equal(
          (
            await sql.query(
              "SELECT count(*)::int n FROM generation_budget_reservations WHERE status='held'",
            )
          ).rows[0].n,
          2,
        );
        assert.equal((await authority.status(owner.user.id)).imageActiveHeldMicros, 100000);
        assert.equal(calls, 1);
      },
    );
    await t.test(
      'reconstructed worker dispatches only the new job and persists a usable library image',
      async () => {
        const restarted = new ImageGenerationEngine(
          database,
          new AssetReuseService(database),
          engine.provider,
          runtime.policy,
          runtime.capabilities,
        );
        restarted.setLiveAuthorizer((c, u, id) => authority.authorizeImage(c, u, id));
        await restarted.workOnce();
        await restarted.workOnce();
        await restarted.workOnce();
        assert.equal(calls, 2);
        const output = await restarted.get(owner.user.id, secondJob.id);
        assert.equal(output.status, 'admitted');
        assert.ok(output.revisionId);
        const prior = await restarted.get(owner.user.id, job.id);
        assert.equal(prior.status, 'unknown');
        assert.equal(prior.heldMicros, 100000);
        assert.equal(prior.actualMicros, undefined);
        assert.equal(
          (
            await sql.query(
              'SELECT count(*)::int n FROM image_generation_attempts WHERE job_id=$1',
              [job.id],
            )
          ).rows[0].n,
          1,
        );
        const current = await authority.status(owner.user.id);
        assert.equal(current.remainingMicros, 95000);
        assert.equal(current.imageOnlyAdmission, true);
        assert.equal(
          (
            await sql.query(
              'SELECT count(DISTINCT scope_id)::int n FROM generation_budget_reservations',
            )
          ).rows[0].n,
          1,
        );
      },
    );
    await t.test(
      'retained liability prevents a further unaffordable request; no auto retry or zero-cost fiction',
      async () => {
        await assert.rejects(async () => {
          const q = await engine.quote(owner.user.id, request);
          await engine.enqueue(owner.user.id, {
            quoteId: q.quote.id,
            operationId: randomUUID(),
            consent: true,
            estimateRiskConsent: true,
          });
        }, failureCode('GENERATION_BUDGET_EXCEEDED'));
        assert.equal(calls, 2);
        const row = (
          await sql.query(
            'SELECT status,actual_micros FROM generation_budget_reservations WHERE id=$1',
            [first.reservation_id],
          )
        ).rows[0];
        assert.equal(row.status, 'held');
        assert.equal(row.actual_micros, null);
        assert.equal(
          (await sql.query('SELECT count(*)::int n FROM image_generation_recoveries')).rows[0].n,
          0,
        );
      },
    );
  } finally {
    if (sql) sql.release();
    if (database) await database.pool.end();
    await stopApi();
    await db.end();
  }
});
