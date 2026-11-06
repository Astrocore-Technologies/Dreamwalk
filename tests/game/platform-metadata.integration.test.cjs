/** Full disposable schema and injected provider. No external request or existing database. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readdir, readFile, rm } = require('node:fs/promises');
const { once } = require('node:events');
const net = require('node:net');
const { Pool } = require('pg');

test(
  'platform metadata durable dedup, private ACL, erasure and shared cost accounting',
  { timeout: 120000 },
  async (t) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    const { forceMockNpcTestEnvironment } = await import('../../scripts/mock-npc-test-env.mjs');
    forceMockNpcTestEnvironment();
    process.env.NODE_ENV = 'test';
    process.env.LOCAL_POSTGRES_CLUSTER = 'platform-translation-' + randomUUID();
    process.env.LOCAL_POSTGRES_PORT = String(port);
    delete process.env.DATABASE_URL;
    const { startLocalPostgres } = await import('../../scripts/postgres-local.mjs');
    const cluster = await startLocalPostgres();
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const ends = [];
    pool.on('connect', (c) => ends.push(new Promise((resolve) => c.once('end', resolve))));
    const db = {
      query: async (sql, args) => (await pool.query(sql, args)).rows,
      async tx(work) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const result = await work(c);
          await c.query('COMMIT');
          return result;
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally {
          c.release();
        }
      },
    };
    try {
      for (const file of (await readdir('packages/db/migrations'))
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await pool.query(await readFile('packages/db/migrations/' + file, 'utf8'));
      const { readGenerationConfig } = require('../../apps/api/dist/generation/config');
      const { activateReleaseDeployment } = require('../images/release-deployment-fixture.cjs');
      const { requestEstimateOwnerProfile } = await import('../images/owner-config-fixture.mjs');
      const {
        PlatformMetadataTranslations,
      } = require('../../apps/api/dist/translation/platform-metadata');
      const { canonical } = require('../../apps/api/dist/ai/context');
      const { estimateTextRequest } = require('../../apps/api/dist/generation/estimates');
      const {
        aggregateGenerationExposure,
      } = require('../../apps/api/dist/generation/aggregate-exposure');
      const { ProviderFailure } = require('../../apps/api/dist/ai/types');
      const profile = requestEstimateOwnerProfile();
      const config = readGenerationConfig({
        GENERATION_MODE: 'release',
        GENERATION_CONFIG_JSON: JSON.stringify({
          allowance: 'unlimited',
          text: profile.text,
          image: profile.image,
        }),
      });
      await db.tx((c) => activateReleaseDeployment(c, config));
      const owner = randomUUID(),
        reader = randomUUID(),
        stranger = randomUUID();
      for (const id of [owner, reader, stranger])
        await pool.query(
          "INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,'fixture','Fixture',$3)",
          [id, id + '@example.test', 'u_' + id.replaceAll('-', '').slice(0, 20)],
        );
      const calls = [];
      let behavior;
      const provider = {
        version: 'synthetic-translation-v1',
        prepareTextRequest(context) {
          const body = JSON.stringify(canonical(context));
          return { body, snapshot: estimateTextRequest(body, config.text, this.version) };
        },
        async generate(request) {
          calls.push(request);
          if (behavior) {
            const override = await behavior(request);
            if (override) return override;
          }
          return {
            requestId: 'fixture-' + request.jobId,
            usage: {
              inputTokens: 10,
              outputTokens: 10,
              costMicros: 30,
              costEvidence: 'configured_rates',
            },
            proposal: {
              translations: request.context.items.map((item) => ({
                id: item.id,
                text: 'Translated ' + item.text,
              })),
            },
          };
        },
      };
      const service = () => new PlatformMetadataTranslations(db, provider, config);
      async function source(visibility = 'public', text = 'Лес') {
        const id = randomUUID();
        const value = {
          id,
          visibility,
          status: 'published',
          title: text,
          synopsis: 'Описание ' + text,
          sourceLanguage: 'ru',
          sourceRevision: 1,
          translations: {},
          content: { world: 'SECRET CANON' },
        };
        await pool.query(
          "INSERT INTO adventures(id,owner_id,slug,title,synopsis,genre,status,visibility,data,published_snapshot) VALUES($1,$2,$3,$4,$5,'fixture','published',$6,$7,$8)",
          [
            id,
            owner,
            id,
            text,
            value.synopsis,
            visibility,
            JSON.stringify(value),
            visibility === 'public' ? JSON.stringify(value) : null,
          ],
        );
        if (visibility === 'private') {
          const version = randomUUID(),
            release = randomUUID();
          await pool.query(
            "INSERT INTO game_playable_versions(id,adventure_id,source_revision,audience,package,checksum) VALUES($1,$2,1,'private','{}','fixture')",
            [version, id],
          );
          await pool.query(
            "INSERT INTO adventure_private_releases(id,adventure_id,playable_version_id,owner_id,operation_id,request_hash,source_edit_revision,snapshot) VALUES($1,$2,$3,$4,$5,'fixture',1,$6)",
            [release, id, version, owner, randomUUID(), JSON.stringify(value)],
          );
          await pool.query('UPDATE adventures SET private_release_id=$2 WHERE id=$1', [
            id,
            release,
          ]);
          await pool.query(
            "INSERT INTO adventure_invitations(adventure_id,owner_id,recipient_id,status) VALUES($1,$2,$3,'accepted')",
            [id, owner, reader],
          );
        }
        return value;
      }
      const localize = (worker, value, viewer = null, locale = 'en') =>
        worker.localize('/adventures/fixture', value, locale, viewer);
      await t.test(
        'many readers/replicas admit one batch, restart reuses it, revision-only edit is free',
        async () => {
          const value = await source(),
            a = service(),
            b = service();
          const before = calls.length;
          const admissions = await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
              localize(i % 2 ? a : b, value, i % 3 ? reader : null),
            ),
          );
          assert.ok(admissions.every((row) => row.pending));
          await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()]);
          assert.equal(calls.length, before + 1);
          assert.equal(calls.at(-1).context.items.length, 2);
          assert.ok(!JSON.stringify(calls.at(-1).context).includes('SECRET CANON'));
          const saved = await localize(service(), value, stranger);
          assert.equal(saved.value.translations.en.title, 'Translated Лес');
          assert.equal(saved.pending, false);
          await pool.query(
            "UPDATE adventures SET published_snapshot=jsonb_set(published_snapshot,'{sourceRevision}','2'::jsonb) WHERE id=$1",
            [value.id],
          );
          const changed = { ...value, sourceRevision: 2 };
          assert.equal(
            (await localize(service(), changed)).value.translations.en.title,
            'Translated Лес',
          );
          await service().tick();
          assert.equal(calls.length, before + 1);
          await pool.query(
            "UPDATE adventures SET published_snapshot=jsonb_set(published_snapshot,'{title}',to_jsonb($2::text)) WHERE id=$1",
            [value.id, 'Новый лес'],
          );
          const edited = { ...changed, title: 'Новый лес' };
          await localize(a, edited);
          await a.tick();
          assert.equal(calls.at(-1).context.items.length, 1);
          assert.equal(calls.at(-1).context.items[0].text, 'Новый лес');
          const result = (await localize(b, edited)).value.translations.en;
          assert.equal(result.synopsis, 'Translated Описание Лес');
          assert.equal(result.title, 'Translated Новый лес');
        },
      );
      await t.test(
        'private metadata shares only authorized released views and rechecks revoked invitation',
        async () => {
          const value = await source('private', 'Приватный лес'),
            a = service();
          const before = calls.length;
          assert.equal((await localize(a, value, stranger)).pending, false);
          assert.equal((await localize(a, value, null)).pending, false);
          await a.tick();
          assert.equal(calls.length, before);
          await localize(a, value, reader);
          await a.tick();
          assert.equal(
            (await localize(a, value, owner)).value.translations.en.title,
            'Translated Приватный лес',
          );
          assert.equal(
            (await localize(a, { ...value, visibility: 'public' }, null)).value.translations.en,
            undefined,
          );
          await pool.query(
            "UPDATE adventure_invitations SET status='revoked' WHERE adventure_id=$1",
            [value.id],
          );
          assert.equal((await localize(a, value, reader)).value.translations.en, undefined);
          const other = await source('private', 'Отозвано до отправки');
          await localize(a, other, reader);
          await pool.query(
            "UPDATE adventure_invitations SET status='revoked' WHERE adventure_id=$1",
            [other.id],
          );
          await a.tick();
          assert.equal(calls.length, before + 1);
          const row = (
            await db.query(
              'SELECT r.status FROM platform_metadata_translation_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.adventure_id=$1',
              [other.id],
            )
          )[0];
          assert.equal(row.status, 'released');
        },
      );
      await t.test(
        'durable receipt completes after crash without a second model call',
        async () => {
          const value = await source('public', 'После сбоя'),
            a = service();
          await localize(a, value);
          const before = calls.length;
          a.finish = async () => {
            throw new Error('synthetic crash after receipt');
          };
          await assert.rejects(() => a.tick());
          assert.equal(
            (
              await db.query(
                'SELECT status FROM platform_metadata_translation_jobs WHERE adventure_id=$1',
                [value.id],
              )
            )[0].status,
            'result_received',
          );
          await service().tick();
          await service().tick();
          assert.equal(calls.length, before + 1);
          assert.equal(
            (await localize(service(), value)).value.translations.en.title,
            'Translated После сбоя',
          );
        },
      );
      await t.test(
        'unknown outcome retains exact exposure and is never retried after reads or restart',
        async () => {
          const value = await source('public', 'Неизвестный исход'),
            a = service();
          await localize(a, value);
          const before = calls.length;
          behavior = async () => {
            throw new ProviderFailure('SYNTHETIC_LOST_RESPONSE', true);
          };
          await a.tick();
          behavior = undefined;
          await localize(service(), value);
          await service().tick();
          assert.equal(calls.length, before + 1);
          const row = (
            await db.query(
              'SELECT j.status,r.status AS reserve_status,r.actual_micros FROM platform_metadata_translation_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.adventure_id=$1',
              [value.id],
            )
          )[0];
          assert.equal(row.status, 'unknown');
          assert.equal(row.reserve_status, 'held');
          assert.equal(row.actual_micros, null);
          assert.equal((await localize(a, value)).pending, false);
        },
      );
      await t.test(
        'edit during dispatch discards changed field but retains unchanged description once',
        async () => {
          const value = await source('public', 'Старый заголовок'),
            a = service();
          await localize(a, value);
          behavior = async () => {
            await pool.query(
              "UPDATE adventures SET published_snapshot=jsonb_set(published_snapshot,'{title}',to_jsonb($2::text)) WHERE id=$1",
              [value.id, 'Новый заголовок'],
            );
          };
          await a.tick();
          behavior = undefined;
          const result = await localize(a, { ...value, title: 'Новый заголовок' });
          assert.equal(result.value.translations.en.title, undefined);
          assert.equal(
            result.value.translations.en.synopsis,
            'Translated Описание Старый заголовок',
          );
          await a.tick();
          assert.equal(calls.at(-1).context.items.length, 1);
        },
      );
      await t.test(
        'cache-only, kill switch, expired pricing and obsolete deployment never dispatch',
        async () => {
          const value = await source('public', 'Policy gates'),
            before = calls.length;
          assert.equal(
            (await localize(new PlatformMetadataTranslations(db), value)).pending,
            false,
          );
          let enabled = false;
          const worker = new PlatformMetadataTranslations(db, provider, config, () => enabled);
          assert.equal((await localize(worker, value)).pending, false);
          const expired = {
            ...config,
            text: {
              ...config.text,
              pricing: {
                ...config.text.pricing,
                validUntil: new Date(Date.now() - 1000).toISOString(),
              },
            },
          };
          assert.equal(
            (await localize(new PlatformMetadataTranslations(db, provider, expired), value))
              .pending,
            false,
          );
          enabled = true;
          assert.equal((await localize(worker, value)).pending, true);
          enabled = false;
          await worker.tick();
          assert.equal(calls.length, before);
          enabled = true;
          const next = readGenerationConfig({
            GENERATION_MODE: 'release',
            GENERATION_CONFIG_JSON: JSON.stringify({
              allowance: 'unlimited',
              text: { ...profile.text, maxOutputTokens: profile.text.maxOutputTokens + 1 },
              image: profile.image,
            }),
          });
          await db.tx((c) => activateReleaseDeployment(c, next));
          await assert.rejects(() => worker.tick(), /GENERATION_RELEASE_PROFILE_NOT_ACTIVE/);
          await new PlatformMetadataTranslations(db, provider, next).tick();
          assert.equal(calls.length, before);
          const cancelled = (
            await db.query(
              'SELECT j.status,r.status AS reserve_status FROM platform_metadata_translation_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.adventure_id=$1',
              [value.id],
            )
          )[0];
          assert.equal(cancelled.status, 'cancelled');
          assert.equal(cancelled.reserve_status, 'released');
          await db.tx((c) => activateReleaseDeployment(c, config));
        },
      );
      await t.test(
        'invalid output settles known cost and cannot create text or a paid retry',
        async () => {
          const value = await source('public', 'Invalid output'),
            worker = service(),
            before = calls.length;
          await localize(worker, value);
          behavior = async () => ({
            requestId: 'invalid-fixture',
            usage: { inputTokens: 10, outputTokens: 10, costMicros: 30, costEvidence: 'reported' },
            proposal: { translations: [] },
          });
          await worker.tick();
          behavior = undefined;
          assert.equal((await localize(service(), value)).value.translations.en, undefined);
          await service().tick();
          const failed = (
            await db.query(
              'SELECT j.status,r.status AS reserve_status,r.actual_micros FROM platform_metadata_translation_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.adventure_id=$1',
              [value.id],
            )
          )[0];
          assert.equal(failed.status, 'failed');
          assert.equal(failed.reserve_status, 'settled');
          assert.equal(Number(failed.actual_micros), 30);
          assert.equal(calls.length, before + 1);
        },
      );
      function gate() {
        let resolve;
        const promise = new Promise((done) => {
          resolve = done;
        });
        return { promise, resolve };
      }
      async function waitBlocked(pid) {
        for (let i = 0; i < 100; i++) {
          const result = await pool.query('SELECT cardinality(pg_blocking_pids($1)) AS n', [pid]);
          if (result.rows[0].n > 0) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.fail('revoke was not blocked by the dispatch source fence');
      }
      await t.test(
        'dispatch validation is fenced against concurrent revoke through durable transition',
        async () => {
          const value = await source('private', 'Dispatch fence');
          await localize(service(), value, reader);
          const validated = gate(),
            resume = gate(),
            providerStarted = gate(),
            providerResume = gate();
          let paused = false;
          const hooked = {
            ...db,
            tx: (work) =>
              db.tx((c) =>
                work({
                  query: async (sql, args) => {
                    const result = await c.query(sql, args);
                    if (!paused && sql.startsWith('SELECT a.id,a.visibility')) {
                      paused = true;
                      validated.resolve();
                      await resume.promise;
                    }
                    return result;
                  },
                }),
              ),
          };
          const worker = new PlatformMetadataTranslations(hooked, provider, config);
          const before = calls.length;
          behavior = async () => {
            providerStarted.resolve();
            await providerResume.promise;
          };
          const dispatch = worker.tick();
          await validated.promise;
          const revoke = await pool.connect();
          try {
            await revoke.query('BEGIN');
            const pid = (await revoke.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            const lock = revoke.query('SELECT id FROM adventures WHERE id=$1 FOR UPDATE', [
              value.id,
            ]);
            await waitBlocked(pid);
            assert.equal(calls.length, before);
            assert.equal(
              (
                await db.query(
                  'SELECT status FROM platform_metadata_translation_jobs WHERE adventure_id=$1',
                  [value.id],
                )
              )[0].status,
              'queued',
            );
            resume.resolve();
            await providerStarted.promise;
            await lock;
            await revoke.query(
              "UPDATE adventure_invitations SET status='revoked' WHERE adventure_id=$1",
              [value.id],
            );
            await revoke.query('COMMIT');
            providerResume.resolve();
            await dispatch;
            assert.equal(calls.length, before + 1);
            assert.equal(
              (await localize(service(), value, reader)).value.translations.en,
              undefined,
            );
            assert.equal(
              (
                await db.query(
                  'SELECT status FROM platform_metadata_translation_jobs WHERE adventure_id=$1',
                  [value.id],
                )
              )[0].status,
              'failed',
            );
          } finally {
            resume.resolve();
            providerResume.resolve();
            behavior = undefined;
            await revoke.query('ROLLBACK');
            revoke.release();
          }
        },
      );
      await t.test(
        'revoke winning its source lock prevents dispatch without a job-user deadlock',
        async () => {
          const value = await source('private', 'Revoke first'),
            worker = service();
          await localize(worker, value, reader);
          const before = calls.length;
          const revoke = await pool.connect();
          try {
            await revoke.query('BEGIN');
            await revoke.query('SELECT id FROM adventures WHERE id=$1 FOR UPDATE', [value.id]);
            await revoke.query(
              "UPDATE adventure_invitations SET status='revoked' WHERE adventure_id=$1",
              [value.id],
            );
            await assert.rejects(
              () => worker.tick(),
              (error) => error.code === '55P03',
            );
            assert.equal(calls.length, before);
            await revoke.query('COMMIT');
            await worker.tick();
            assert.equal(calls.length, before);
            assert.equal(
              (
                await db.query(
                  'SELECT status FROM platform_metadata_translation_jobs WHERE adventure_id=$1',
                  [value.id],
                )
              )[0].status,
              'cancelled',
            );
          } finally {
            await revoke.query('ROLLBACK');
            revoke.release();
          }
        },
      );
      await t.test(
        'late receipt settles a timed-out held reservation exactly once without redispatch',
        async () => {
          const value = await source('public', 'Late receipt'),
            worker = service();
          await localize(worker, value);
          const started = gate(),
            release = gate(),
            before = calls.length;
          behavior = async () => {
            started.resolve();
            await release.promise;
          };
          const dispatch = worker.tick();
          await started.promise;
          await pool.query(
            "UPDATE platform_metadata_translation_jobs SET deadline_at=now()-interval '1 second' WHERE adventure_id=$1",
            [value.id],
          );
          await service().tick();
          const held = (
            await db.query(
              'SELECT j.status,r.status AS reserve_status,r.actual_micros FROM platform_metadata_translation_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.adventure_id=$1',
              [value.id],
            )
          )[0];
          assert.equal(held.status, 'unknown');
          assert.equal(held.reserve_status, 'held');
          assert.equal(held.actual_micros, null);
          assert.equal((await localize(service(), value)).pending, false);
          release.resolve();
          await dispatch;
          behavior = undefined;
          await service().tick();
          const settled = (
            await db.query(
              'SELECT j.status,r.status AS reserve_status,r.actual_micros FROM platform_metadata_translation_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.adventure_id=$1',
              [value.id],
            )
          )[0];
          assert.equal(settled.status, 'ready');
          assert.equal(settled.reserve_status, 'settled');
          assert.equal(Number(settled.actual_micros), 30);
          assert.equal(calls.length, before + 1);
          assert.equal(
            (await localize(service(), value)).value.translations.en.title,
            'Translated Late receipt',
          );
        },
      );
      await t.test(
        'erasure during dispatch cannot resurrect text, while exact provider cost survives',
        async () => {
          const value = await source('private', 'Erase canary'),
            a = service();
          await localize(a, value, reader);
          const { eraseTranslations } = await import('../../scripts/translation-data-requests.mjs');
          behavior = async () => {
            await db.tx((c) => eraseTranslations(c, owner));
          };
          await a.tick();
          behavior = undefined;
          const last = calls.at(-1).jobId;
          const row = (
            await db.query(
              'SELECT j.*,r.actual_micros,r.actor_id,r.spark_quote_id FROM platform_metadata_translation_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.id=$1',
              [last],
            )
          )[0];
          assert.equal(row.context, null);
          assert.equal(row.result, null);
          assert.equal(row.adventure_id, null);
          assert.equal(Number(row.actual_micros), 30);
          assert.equal(row.actor_id, null);
          assert.equal(row.spark_quote_id, null);
          assert.equal(
            (await db.query('SELECT count(*)::int n FROM content_translations'))[0].n,
            0,
          );
          assert.equal((await db.query('SELECT count(*)::int n FROM spark_ledger'))[0].n, 0);
          const exposure = await db.tx((c) => aggregateGenerationExposure(c));
          assert.ok(exposure.sharedMicros > 0n);
          assert.equal(
            (
              await db.query(
                "SELECT unlimited_allowance,total_cap_micros FROM generation_budget_scopes WHERE id='platform:story-metadata'",
              )
            )[0].total_cap_micros,
            null,
          );
        },
      );
    } finally {
      await pool.end();
      await Promise.all(ends);
      await cluster.stop();
      await rm('.local/' + process.env.LOCAL_POSTGRES_CLUSTER, { recursive: true, force: true });
    }
  },
);
