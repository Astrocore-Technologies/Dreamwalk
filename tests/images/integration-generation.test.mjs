/** Real API/PostgreSQL/image admission, entirely synthetic provider transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { db, startApi, stopApi, client, until } from '../game/support-runtime.mjs';
import { createStory, fixturePng, uploadFixture } from './support.mjs';
const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const { ImageGenerationEngine } = require('../../apps/api/dist/image-generation/service.js');
const {
  FixtureImageProvider,
  OpenAiImageProvider,
} = require('../../apps/api/dist/image-generation/provider.js');
const { defaultImagePolicy } = require('../../apps/api/dist/image-generation/contracts.js');
const {
  eraseImageGeneration,
  exportImageGeneration,
} = require('../../apps/api/dist/image-generation/data-requests.js');
const database = new Db(),
  assets = new AssetReuseService(database);
const code = (expected) => (e) => e?.getResponse?.().code === expected;
const input = (adventureId, extra = {}) => ({
  adventureId,
  prompt: 'PRIVATE_SYNTHETIC_PROMPT',
  title: 'Fixture generation',
  kind: 'background',
  camera: 'top-down',
  tags: ['image-acceptance'],
  background: 'opaque',
  referenceRevisionIds: [],
  mode: 'mock',
  declineReuse: true,
  rights: {
    basis: 'generated',
    licenseLabel: 'Synthetic author attestation',
    attribution: 'Synthetic',
    allowAuthorReuse: true,
    attested: true,
  },
  ...extra,
});
const row = async (id) =>
  (await db.query('SELECT * FROM image_generation_jobs WHERE id=$1', [id])).rows[0];
const held = async (id) =>
  (
    await db.query(
      'SELECT r.* FROM generation_budget_reservations r JOIN image_generation_jobs j ON j.reservation_id=r.id WHERE j.id=$1',
      [id],
    )
  ).rows[0];
await test(
  'image generation authorization, zero-network fixtures and durable admission',
  { timeout: 120000 },
  async (t) => {
    try {
      await startApi();
      const owner = await client().register(),
        other = await client().register();
      const stories = [];
      for (let i = 0; i < 15; i++) stories.push(await createStory(owner));
      const ownArt = await uploadFixture(owner),
        foreignArt = await uploadFixture(other);
      await t.test(
        'HTTP authentication, search-before-generation and explicit consent',
        async () => {
          await client().request('/image-generation/config', undefined, 'GET', 401);
          const cfg = await owner.request('/image-generation/config');
          assert.equal(cfg.externalEnabled, false);
          const reuse = await owner.request(
            '/image-generation/quotes',
            input(stories[0].id, { declineReuse: false }),
          );
          assert.equal(reuse.decision, 'reuse');
          assert.equal(reuse.providerCalls, 0);
          assert.equal(reuse.charge, 0);
          const q = await owner.request(
            '/image-generation/quotes',
            input(stories[0].id, { tags: ['t'.repeat(48)] }),
          );
          await owner.request(
            '/image-generation/jobs',
            { quoteId: q.quote.id, operationId: randomUUID(), consent: false },
            'POST',
            400,
          );
          await other.request(
            '/image-generation/jobs',
            { quoteId: q.quote.id, operationId: randomUUID(), consent: true },
            'POST',
            404,
          );
          const body = { quoteId: q.quote.id, operationId: randomUUID(), consent: true };
          const j = await owner.request('/image-generation/jobs', body);
          assert.equal((await owner.request('/image-generation/jobs', body)).id, j.id);
          const done = await until(
            () => owner.request(`/image-generation/jobs/${j.id}`),
            (v) => v.status === 'admitted',
          );
          assert.ok(done.revisionId);
          assert.equal(done.actualMicros, 0);
          await other.request(`/image-generation/jobs/${j.id}`, undefined, 'GET', 404);
          const receipt = await owner.request(`/asset-library/revisions/${done.revisionId}`);
          assert.equal(receipt.mime, 'image/webp');
          assert.equal(receipt.metadata.provenance.source, 'generated');
          assert.ok(!JSON.stringify(receipt).includes('PRIVATE_SYNTHETIC_PROMPT'));
          const response = await fetch(
            process.env.TEST_GAME_API_URL + `/asset-library/revisions/${done.revisionId}/file`,
            { headers: { cookie: owner.cookie } },
          );
          assert.equal(response.status, 200);
          assert.equal(response.headers.get('content-type'), 'image/webp');
          assert.ok((await response.arrayBuffer()).byteLength > 0);
          await stopApi('SIGKILL');
          await startApi();
          assert.equal(
            (await owner.request(`/image-generation/jobs/${j.id}`)).revisionId,
            done.revisionId,
          );
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM image_generation_attempts WHERE job_id=$1',
                [j.id],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      // Direct engine fault injection must not race the application's automatic fixture worker.
      await stopApi();
      let storyIndex = 1;
      const engine = (provider = new FixtureImageProvider(), patch = {}) =>
        new ImageGenerationEngine(database, assets, provider, {
          ...defaultImagePolicy,
          scopeId: randomUUID(),
          ...patch,
        });
      const queue = async (e, extra = {}) => {
        const q = await e.quote(owner.user.id, input(stories[storyIndex++].id, extra));
        const j = await e.enqueue(owner.user.id, {
          quoteId: q.quote.id,
          operationId: randomUUID(),
          consent: true,
        });
        return { q, j };
      };
      await t.test(
        'strict ownership, derivative reference rights and unknown live bound fail closed',
        async () => {
          const e = engine();
          await assert.rejects(
            () => e.quote(other.user.id, input(stories[1].id)),
            code('NOT_FOUND'),
          );
          await assert.rejects(
            () =>
              e.quote(
                owner.user.id,
                input(stories[1].id, { referenceRevisionIds: [foreignArt.id] }),
              ),
            code('DERIVATIVE_REFERENCE_FORBIDDEN'),
          );
          await assert.rejects(
            () => e.quote(owner.user.id, input(stories[1].id, { mode: 'external' })),
            code('LIVE_COST_BOUND_REQUIRED'),
          );
          let calls = 0;
          const options = {
            enabled: true,
            apiKey: 'synthetic-never-used',
            verifiedUpperMicros: null,
            networkApproved: true,
            model: 'gpt-image-2.5-sunburst-2026-09-08',
            inputTextMicrosPerMillion: 1,
            inputImageMicrosPerMillion: 1,
            outputImageMicrosPerMillion: 1,
            fetchImpl: () => {
              calls++;
              throw Error('NETWORK_MUST_NOT_RUN');
            },
          };
          const p = new OpenAiImageProvider(options);
          assert.equal(
            p.id,
            new OpenAiImageProvider({ ...options, apiKey: 'different-synthetic-key' }).id,
          );
          assert.notEqual(
            p.id,
            new OpenAiImageProvider({ ...options, inputTextMicrosPerMillion: 2 }).id,
          );
          assert.notEqual(
            p.id,
            new OpenAiImageProvider({ ...options, verifiedUpperMicros: 100 }).id,
          );
          assert.throws(
            () => new OpenAiImageProvider({ ...options, model: 'unsupported' }),
            /INVALID_IMAGE_PROVIDER_POLICY/,
          );
          options.verifiedUpperMicros = 100; // caller mutation must not enable the already-created provider
          await assert.rejects(
            () => p.generate(input(stories[1].id), randomUUID(), []),
            /LIVE_COST_BOUND_REQUIRED/,
          );
          assert.equal(calls, 0);
        },
      );
      await t.test(
        'concurrent exact enqueue is one job; quote is consumed once and expiry cannot regain consent',
        async () => {
          const e = engine(),
            q = await e.quote(owner.user.id, input(stories[storyIndex++].id));
          const b = { quoteId: q.quote.id, operationId: randomUUID(), consent: true };
          const [a, z] = await Promise.all([
            e.enqueue(owner.user.id, b),
            e.enqueue(owner.user.id, b),
          ]);
          assert.equal(a.id, z.id);
          await assert.rejects(
            () => e.enqueue(owner.user.id, { ...b, operationId: randomUUID() }),
            code('QUOTE_CONSUMED'),
          );
          await e.cancel(owner.user.id, a.id);
          const expired = await e.quote(owner.user.id, input(stories[storyIndex++].id));
          await db.query(
            "UPDATE image_generation_quotes SET expires_at=now()-interval '1 second' WHERE id=$1",
            [expired.quote.id],
          );
          await assert.rejects(
            () =>
              e.enqueue(owner.user.id, {
                quoteId: expired.quote.id,
                operationId: randomUUID(),
                consent: true,
              }),
            code('QUOTE_EXPIRED'),
          );
        },
      );
      await t.test(
        'queued consent binds the quoted provider and never calls a replacement provider',
        async () => {
          const original = engine({
            id: 'quoted-provider',
            generate: async () => {
              throw Error('UNUSED');
            },
          });
          const { j } = await queue(original);
          let calls = 0;
          const changed = engine({
            id: 'different-provider',
            generate: async () => {
              calls++;
              throw Error('MUST_NOT_CALL');
            },
          });
          await changed.workOnce();
          assert.equal(calls, 0);
          assert.equal((await row(j.id)).status, 'rejected');
          assert.equal((await held(j.id)).status, 'released');
        },
      );
      await t.test(
        'source revoked before dispatch makes zero provider calls and releases undispatched hold',
        async () => {
          let calls = 0;
          const e = engine({
              id: 'synthetic',
              generate: async () => {
                calls++;
                throw Error('NOT_EXPECTED');
              },
            }),
            { j } = await queue(e);
          await db.query("UPDATE adventures SET status='archived' WHERE id=$1", [
            (await row(j.id)).adventure_id,
          ]);
          await e.workOnce();
          assert.equal(calls, 0);
          assert.ok(['cancelled', 'rejected'].includes((await row(j.id)).status));
          assert.equal((await held(j.id)).status, 'released');
        },
      );
      await t.test('owned reference takedown invalidates predispatch authorization', async () => {
        let calls = 0;
        const e = engine({
            id: 'synthetic',
            generate: async () => {
              calls++;
              throw Error('NOT_EXPECTED');
            },
          }),
          { j } = await queue(e, { referenceRevisionIds: [ownArt.id] });
        await assets.takedown(owner.user.id, ownArt.id, randomUUID());
        await e.workOnce();
        assert.equal(calls, 0);
        assert.equal((await row(j.id)).status, 'rejected');
        assert.equal((await held(j.id)).status, 'released');
      });
      await t.test(
        'ambiguous provider failure is never redispatched, reconstructed worker keeps hold',
        async () => {
          let calls = 0;
          const provider = {
              id: 'synthetic-unknown',
              generate: async () => {
                calls++;
                throw Error('AMBIGUOUS');
              },
            },
            e = engine(provider, { mockUpperMicros: 10 }),
            { j } = await queue(e);
          await e.workOnce();
          assert.equal((await row(j.id)).status, 'unknown');
          assert.equal((await held(j.id)).status, 'held');
          await e.workOnce();
          await engine(provider).workOnce();
          assert.equal(calls, 1);
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM image_generation_attempts WHERE job_id=$1',
                [j.id],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        'late known receipt settles once and immutable admission remains exactly one revision',
        async () => {
          const provider = {
              id: 'synthetic-late',
              generate: async () => {
                throw Error('AMBIGUOUS');
              },
            },
            e = engine(provider, { mockUpperMicros: 10 }),
            { j } = await queue(e);
          await e.workOnce();
          const receipt = {
            bytes: await fixturePng(),
            mime: 'image/png',
            actualMicros: 3,
            requestId: 'synthetic-receipt',
          };
          await Promise.all([e.recordResult(j.id, receipt), e.recordResult(j.id, receipt)]);
          await e.workOnce();
          const done = await e.get(owner.user.id, j.id);
          assert.equal(done.status, 'admitted');
          await e.recordResult(j.id, receipt);
          await e.workOnce();
          assert.equal(
            (
              await db.query('SELECT count(*)::int n FROM art_asset_revisions WHERE id=$1', [
                done.revisionId,
              ])
            ).rows[0].n,
            1,
          );
          await assert.rejects(
            () => e.recordResult(j.id, { ...receipt, actualMicros: 4 }),
            code('COST_CONFLICT'),
          );
          assert.equal(Number((await held(j.id)).actual_micros), 3);
        },
      );
      await t.test(
        'postdispatch source revoke retains actual provider cost but admits no asset',
        async () => {
          const e = engine(
              {
                id: 'synthetic-late',
                generate: async () => {
                  throw Error('AMBIGUOUS');
                },
              },
              { mockUpperMicros: 10 },
            ),
            { j } = await queue(e);
          await e.workOnce();
          await db.query("UPDATE adventures SET status='archived' WHERE id=$1", [
            (await row(j.id)).adventure_id,
          ]);
          await e.recordResult(j.id, {
            bytes: await fixturePng(),
            mime: 'image/png',
            actualMicros: 4,
            requestId: 'revoked-receipt',
          });
          await e.workOnce();
          assert.equal((await row(j.id)).admitted_revision_id, null);
          assert.equal(Number((await held(j.id)).actual_micros), 4);
        },
      );
      await t.test('opaque cutout is rejected without regeneration or cost refund', async () => {
        let calls = 0;
        const e = engine(
            {
              id: 'opaque-fixture',
              generate: async () => {
                calls++;
                return {
                  bytes: await fixturePng(),
                  mime: 'image/png',
                  actualMicros: 2,
                  requestId: 'opaque',
                };
              },
            },
            { mockUpperMicros: 10 },
          ),
          { j } = await queue(e, { kind: 'sprite', background: 'transparent' });
        await e.workOnce();
        assert.equal((await row(j.id)).status, 'rejected');
        assert.equal((await row(j.id)).error_code, 'INVALID_RASTER_OR_ALPHA');
        assert.equal(Number((await held(j.id)).actual_micros), 2);
        await e.workOnce();
        assert.equal(calls, 1);
      });
      await t.test(
        'durable dispatch marker after process loss becomes unknown without retry',
        async () => {
          const e = engine(),
            { j } = await queue(e);
          await db.query(
            "INSERT INTO image_generation_attempts(job_id,dispatch_id,provider,request_hash) SELECT id,$2,'synthetic-crash',request_hash FROM image_generation_jobs WHERE id=$1",
            [j.id, randomUUID()],
          );
          await db.query(
            "UPDATE image_generation_jobs SET status='dispatched',dispatched_at=now(),dispatch_deadline=now()-interval '1 second' WHERE id=$1",
            [j.id],
          );
          let calls = 0;
          const recovered = engine({
            id: 'synthetic-crash',
            generate: async () => {
              calls++;
              throw Error('MUST_NOT_RETRY');
            },
          });
          await recovered.workOnce();
          assert.equal((await row(j.id)).status, 'unknown');
          assert.equal(calls, 0);
          assert.equal((await held(j.id)).status, 'held');
        },
      );
      await t.test(
        'shared raster quota counts generation holds and expired queued consent releases quota',
        async () => {
          const e = engine(),
            ids = Array.from({ length: 200 }, () => randomUUID());
          const q = await e.quote(owner.user.id, input(stories[storyIndex++].id));
          try {
            await db.query(
              `INSERT INTO assets(id,owner_id,filename,mime,width,height,bytes,sha256)
            SELECT x,$2,x::text||'.webp','image/webp',32,32,100,repeat('a',64) FROM unnest($1::uuid[]) x`,
              [ids, owner.user.id],
            );
            await assert.rejects(
              () =>
                e.enqueue(owner.user.id, {
                  quoteId: q.quote.id,
                  operationId: randomUUID(),
                  consent: true,
                }),
              code('ASSET_QUOTA_EXCEEDED'),
            );
          } finally {
            await db.query('DELETE FROM assets WHERE id=ANY($1::uuid[])', [ids]);
          }
          const j = await e.enqueue(owner.user.id, {
            quoteId: q.quote.id,
            operationId: randomUUID(),
            consent: true,
          });
          assert.ok((await row(j.id)).quota_reserved_bytes > 0);
          await db.query(
            "UPDATE image_generation_jobs SET expires_at=now()-interval '1 second' WHERE id=$1",
            [j.id],
          );
          await e.maintenance();
          assert.equal((await row(j.id)).status, 'expired');
          assert.equal((await row(j.id)).quota_reserved_bytes, 0);
          assert.equal((await held(j.id)).status, 'released');
        },
      );
      await t.test(
        'export is actor scoped; confirmed erasure clears admitted and pending private inputs',
        async () => {
          const own = await database.tx((c) => exportImageGeneration(c, owner.user.id)),
            foreign = await database.tx((c) => exportImageGeneration(c, other.user.id));
          assert.ok(own.jobs.length);
          assert.equal(foreign.jobs.length, 0);
          const c = await db.connect();
          await c.query('BEGIN');
          try {
            await assert.rejects(
              () => eraseImageGeneration(c, owner.user.id),
              /CONFIRMED_ERASURE_REQUIRED/,
            );
            await c.query("SELECT set_config('dreamwalk.erasure','confirmed',true)");
            await c.query('UPDATE users SET deleted_at=now() WHERE id=$1', [owner.user.id]);
            await eraseImageGeneration(c, owner.user.id);
            const jobs = (
              await c.query(
                'SELECT input,reference_hashes FROM image_generation_jobs WHERE actor_id=$1',
                [owner.user.id],
              )
            ).rows;
            assert.ok(
              jobs.every(
                (x) =>
                  JSON.stringify(x.input) === '{}' && JSON.stringify(x.reference_hashes) === '{}',
              ),
            );
            assert.equal(
              (
                await c.query('SELECT 1 FROM generation_budget_reservations WHERE actor_id=$1', [
                  owner.user.id,
                ])
              ).rowCount,
              0,
            );
          } finally {
            await c.query('ROLLBACK');
            c.release();
          }
        },
      );
      await t.test(
        'operator purge retains durable cleanup on failure and succeeds on explicit retry',
        async () => {
          const job = (
            await db.query(
              'SELECT id FROM image_generation_jobs WHERE actor_id=$1 ORDER BY created_at LIMIT 1',
              [owner.user.id],
            )
          ).rows[0];
          assert.ok(job);
          const filename = `${job.id}.image-quarantine`;
          const path = resolve(process.env.ASSET_DIR, filename);
          await rm(path, { force: true });
          await mkdir(path);
          await db.query('UPDATE image_generation_jobs SET quarantine_filename=$2 WHERE id=$1', [
            job.id,
            filename,
          ]);
          await db.query('UPDATE users SET deleted_at=now() WHERE id=$1', [owner.user.id]);
          const requestId = randomUUID();
          await db.query(
            "INSERT INTO data_requests(id,user_id,kind,status) VALUES($1,$2,'deletion','requested')",
            [requestId, owner.user.id],
          );
          const run = () =>
            promisify(execFile)(
              process.execPath,
              [
                'scripts/process-data-request.mjs',
                '--request',
                requestId,
                '--operator',
                'image-acceptance',
                '--confirm-purge',
                requestId,
              ],
              { env: process.env, timeout: 30000 },
            );
          await assert.rejects(run, /EISDIR|illegal operation on a directory/);
          assert.equal((await row(job.id)).quarantine_filename, filename);
          assert.notDeepEqual((await row(job.id)).input, {});
          assert.equal(
            (await db.query('SELECT status FROM data_requests WHERE id=$1', [requestId])).rows[0]
              .status,
            'failed',
          );
          await rm(path, { recursive: true });
          await writeFile(path, Buffer.from('synthetic private quarantine'));
          await run();
          assert.equal(
            (await db.query('SELECT status FROM data_requests WHERE id=$1', [requestId])).rows[0]
              .status,
            'completed',
          );
          assert.deepEqual((await row(job.id)).input, {});
          assert.equal((await row(job.id)).quarantine_filename, null);
          await assert.rejects(() => access(path), { code: 'ENOENT' });
          await run(); // completed operator request is also idempotent
        },
      );
    } finally {
      await stopApi();
      await database.pool.end();
      await db.end();
    }
  },
);
