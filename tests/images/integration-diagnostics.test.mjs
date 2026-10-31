/** Synthetic provider errors only: durable diagnostics must not weaken billing or privacy. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client } from '../game/support-runtime.mjs';
import { createStory } from './support.mjs';
const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const { ImageGenerationEngine } = require('../../apps/api/dist/image-generation/service.js');
const { defaultImagePolicy } = require('../../apps/api/dist/image-generation/contracts.js');
const {
  ImageProviderFailure,
  safeImageErrorDiagnostic,
} = require('../../apps/api/dist/image-generation/error-diagnostics.js');
const { eraseImageGeneration } = require('../../apps/api/dist/image-generation/data-requests.js');
const database = new Db();
await test(
  'provider diagnostics persist safely without retry or releasing uncertain spend',
  { timeout: 90000 },
  async (t) => {
    try {
      await startApi();
      const owner = await client().register(),
        other = await client().register();
      const stories = [await createStory(owner), await createStory(owner)];
      await stopApi();
      const assets = new AssetReuseService(database),
        policy = { ...defaultImagePolicy, scopeId: randomUUID(), mockUpperMicros: 10 };
      let calls = 0;
      const diagnostics = [];
      const provider = {
        id: 'synthetic-diagnostic',
        generate: async () => {
          calls++;
          throw new ImageProviderFailure(diagnostics.shift());
        },
      };
      const engine = () => new ImageGenerationEngine(database, assets, provider, policy);
      const e = engine(),
        jobs = [];
      for (const [i, error] of [
        {
          code: 'organization_verification_required',
          type: 'permission_error',
          message: 'Organization must be verified; org_PRIVATE_CANARY key sk_PRIVATE_CANARY',
        },
        {
          code: 'PRIVATE_CODE_CANARY',
          type: 'PRIVATE_TYPE_CANARY',
          message: 'PRIVATE_PROMPT_CANARY org-private key-private',
        },
      ].entries()) {
        diagnostics.push(
          await safeImageErrorDiagnostic(
            new Response(JSON.stringify({ error }), {
              status: 403,
              headers: { 'x-request-id': i === 0 ? 'req_fixture_403' : 'PRIVATE_REQUEST_CANARY' },
            }),
          ),
        );
        const q = await e.quote(owner.user.id, {
          adventureId: stories[i].id,
          prompt: 'Synthetic landscape',
          title: 'Diagnostic fixture',
          kind: 'background',
          camera: 'top-down',
          tags: [],
          background: 'opaque',
          referenceRevisionIds: [],
          mode: 'mock',
          declineReuse: true,
          rights: {
            basis: 'generated',
            licenseLabel: 'Synthetic',
            attribution: 'Synthetic',
            allowAuthorReuse: true,
            attested: true,
          },
        });
        const j = await e.enqueue(owner.user.id, {
          quoteId: q.quote.id,
          operationId: randomUUID(),
          consent: true,
        });
        jobs.push(j.id);
        await e.workOnce();
      }
      await t.test(
        'known code yields canonical diagnostic; unknown prose and identifiers never persist',
        async () => {
          const a = await e.get(owner.user.id, jobs[0]),
            b = await e.get(owner.user.id, jobs[1]);
          assert.equal(a.status, 'unknown');
          assert.equal(a.diagnostic.httpStatus, 403);
          assert.equal(a.diagnostic.requestId, 'req_fixture_403');
          assert.equal(a.diagnostic.category, 'organization_verification');
          assert.equal(a.diagnostic.evidence, 'provider_reported');
          assert.equal(a.diagnostic.billing, 'unknown');
          assert.equal(b.diagnostic.providerCode, undefined);
          assert.equal(b.diagnostic.providerType, undefined);
          assert.equal(b.diagnostic.message, undefined);
          assert.equal(b.diagnostic.requestId, undefined);
          const rows = (
            await db.query(
              'SELECT safe_diagnostic,provider_request_id FROM image_generation_jobs WHERE id=ANY($1::uuid[])',
              [jobs],
            )
          ).rows;
          assert.ok(!JSON.stringify(rows).includes('PRIVATE_'));
        },
      );
      await t.test(
        'reconstructed worker retains two held reservations and never dispatches again',
        async () => {
          await e.workOnce();
          await engine().workOnce();
          assert.equal(calls, 2);
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM image_generation_attempts WHERE job_id=ANY($1::uuid[])',
                [jobs],
              )
            ).rows[0].n,
            2,
          );
          const held = (
            await db.query(
              'SELECT r.status FROM generation_budget_reservations r JOIN image_generation_jobs j ON j.reservation_id=r.id WHERE j.id=ANY($1::uuid[])',
              [jobs],
            )
          ).rows;
          assert.equal(held.length, 2);
          assert.ok(held.every((r) => r.status === 'held'));
        },
      );
      await t.test('actual restarted authenticated API exposes only owner diagnostic', async () => {
        await startApi();
        const own = await owner.request(`/image-generation/jobs/${jobs[0]}`);
        assert.equal(own.diagnostic.requestId, 'req_fixture_403');
        await other.request(`/image-generation/jobs/${jobs[0]}`, undefined, 'GET', 404);
        await stopApi();
      });
      await t.test(
        'confirmed erasure removes diagnostics and provider identifiers, not uncertain liability',
        async () => {
          await database.tx(async (c) => {
            await c.query("SELECT set_config('dreamwalk.erasure','confirmed',true)");
            await c.query('UPDATE users SET deleted_at=now() WHERE id=$1', [owner.user.id]);
            await eraseImageGeneration(c, owner.user.id);
          });
          const rows = (
            await db.query(
              'SELECT safe_diagnostic,provider_request_id FROM image_generation_jobs WHERE id=ANY($1::uuid[])',
              [jobs],
            )
          ).rows;
          assert.ok(rows.every((r) => !r.safe_diagnostic && !r.provider_request_id));
          const attempts = (
            await db.query(
              'SELECT provider_request_id FROM image_generation_attempts WHERE job_id=ANY($1::uuid[])',
              [jobs],
            )
          ).rows;
          assert.ok(attempts.every((r) => r.provider_request_id === null));
          const holds = (
            await db.query(
              'SELECT r.status,r.actor_id FROM generation_budget_reservations r JOIN image_generation_jobs j ON j.reservation_id=r.id WHERE j.id=ANY($1::uuid[])',
              [jobs],
            )
          ).rows;
          assert.ok(holds.every((r) => r.status === 'held' && r.actor_id === null));
        },
      );
    } finally {
      await stopApi();
      await database.pool.end();
      await db.end();
    }
  },
);
