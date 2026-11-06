/** Released-content lifecycle on one owned disposable PostgreSQL cluster.
 * All provider responses are synthetic. No production database or network provider is used. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readdir, readFile, rm } = require('node:fs/promises');
const { once } = require('node:events');
const net = require('node:net');
const { Pool } = require('pg');

function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  'released-content outbox, dedup, lifetime fences, erasure and platform accounting',
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
    const clusterName = 'content-translation-' + randomUUID();
    process.env.LOCAL_POSTGRES_CLUSTER = clusterName;
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
        } catch (error) {
          await c.query('ROLLBACK');
          throw error;
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
        PlatformContentTranslations,
      } = require('../../apps/api/dist/translation/platform-content');
      const {
        studioContentTranslationAdapters,
      } = require('../../apps/api/dist/translation/studio-content-sources');
      const { canonical, digest } = require('../../apps/api/dist/ai/context');
      const {
        PlayableContentSource,
      } = require('../../apps/api/dist/translation/playable-content-source');
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
      async function user() {
        const id = randomUUID();
        await pool.query(
          "INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,'fixture','Fixture',$3)",
          [id, id + '@example.test', 'u_' + id.replaceAll('-', '').slice(0, 20)],
        );
        return id;
      }
      const owner = await user(),
        reader = await user(),
        stranger = await user();
      const calls = [];
      let behavior;
      const provider = {
        version: 'synthetic-released-content-v1',
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
                text: request.context.targetLocale + ':' + item.text,
              })),
            },
          };
        },
      };
      const service = () =>
        new PlatformContentTranslations(db, studioContentTranslationAdapters, provider, config);
      async function source(
        title,
        {
          visibility = 'public',
          locale = 'ru',
          released = true,
          ownerId = owner,
          synopsis = '',
          oneTarget = false,
          extra = {},
        } = {},
      ) {
        const id = randomUUID();
        const value = {
          id,
          visibility,
          status: released ? 'published' : 'draft',
          title,
          synopsis,
          sourceLanguage: locale,
          sourceRevision: 1,
          translations: oneTarget ? { uk: { sourceRevision: 1, title: 'Curated title' } } : {},
          content: { world: 'WITHHELD CANON MUST NEVER REACH PROVIDER' },
          ...extra,
        };
        await pool.query(
          "INSERT INTO adventures(id,owner_id,slug,title,synopsis,genre,status,visibility,data,published_snapshot) VALUES($1,$2,$3,$4,$5,'fixture',$6,$7,$8,$9)",
          [
            id,
            ownerId,
            id,
            title,
            synopsis,
            value.status,
            visibility,
            JSON.stringify(value),
            released && visibility === 'public' ? JSON.stringify(value) : null,
          ],
        );
        if (released && visibility === 'private') {
          const version = randomUUID(),
            release = randomUUID();
          await pool.query(
            "INSERT INTO game_playable_versions(id,adventure_id,source_revision,audience,package,checksum) VALUES($1,$2,1,'private','{}','fixture')",
            [version, id],
          );
          await pool.query(
            "INSERT INTO adventure_private_releases(id,adventure_id,playable_version_id,owner_id,operation_id,request_hash,source_edit_revision,snapshot) VALUES($1,$2,$3,$4,$5,'fixture',1,$6)",
            [release, id, version, ownerId, randomUUID(), JSON.stringify(value)],
          );
          await pool.query('UPDATE adventures SET private_release_id=$2 WHERE id=$1', [
            id,
            release,
          ]);
          await pool.query(
            "INSERT INTO adventure_invitations(adventure_id,owner_id,recipient_id,status) VALUES($1,$2,$3,'accepted')",
            [id, ownerId, reader],
          );
        }
        return value;
      }
      const localize = (value, viewer = null, locale = 'en', worker = service()) =>
        worker.localize('/adventures/' + value.id, value, locale, viewer);
      const count = async (sql, args) => Number((await db.query(sql, args))[0].n);
      const events = () =>
        count(
          "SELECT count(*)::int n FROM platform_content_translation_events WHERE source_kind IN ('adventure','taxonomy')",
        );
      const queued = () =>
        count(
          "SELECT count(*)::int n FROM platform_content_translation_jobs WHERE status='queued'",
        );
      async function reconcileAll(worker = service()) {
        while (await events()) {
          const result = await worker.reconcile();
          assert.ok(result, 'a live outbox event must be examined');
          assert.ok(!result.remaining || result.admitted > 0, 'admission must make progress');
        }
      }
      async function runQueued(workers = [service(), service()]) {
        let before;
        while ((before = await queued())) {
          await Promise.all(
            Array.from({ length: Math.min(4, before) }, (_, index) =>
              workers[index % workers.length].tick(),
            ),
          );
          assert.ok((await queued()) < before, 'dispatch or cancellation must consume queued work');
        }
      }
      async function drain() {
        do {
          await reconcileAll();
          await runQueued();
        } while (await events());
      }
      const jobs = (id) =>
        db.query(
          'SELECT j.*,r.status AS reserve_status,r.actual_micros,r.upper_micros,r.actor_id,r.spark_quote_id FROM platform_content_translation_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.source_id=$1 OR j.id=ANY($2::uuid[]) ORDER BY j.created_at,j.id',
          [Array.isArray(id) ? null : id, Array.isArray(id) ? id : []],
        );
      async function edit(value, change) {
        Object.assign(value, change);
        await pool.query('UPDATE adventures SET published_snapshot=$2 WHERE id=$1', [
          value.id,
          JSON.stringify(value),
        ]);
      }
      async function approvePlayableTitle(value) {
        const version = randomUUID(),
          publication = randomUUID();
        const pkg = {
          schemaVersion: 2,
          kind: 'launch-source',
          compiled: null,
          source: {
            title: value.title,
            sourceLanguage: value.sourceLanguage,
            content: { locations: [] },
          },
          plannerSource: { title: value.title, content: { locations: [], npcIds: [] }, npcs: [] },
          npcDefinitions: [],
        };
        await pool.query(
          "INSERT INTO game_playable_versions(id,adventure_id,source_revision,audience,package,checksum) VALUES($1,$2,1,'review',$3,$4)",
          [version, value.id, JSON.stringify(pkg), digest(pkg)],
        );
        await pool.query(
          'INSERT INTO adventure_versions(id,adventure_id,version,snapshot) VALUES($1,$2,1,$3)',
          [publication, value.id, JSON.stringify(value)],
        );
        await pool.query(
          'INSERT INTO game_playable_approvals(playable_version_id,adventure_version_id) VALUES($1,$2)',
          [version, publication],
        );
        return version;
      }
      async function insertPrivateRelease(release) {
        await pool.query(
          "INSERT INTO adventure_private_releases(id,adventure_id,playable_version_id,owner_id,operation_id,request_hash,source_edit_revision,snapshot) VALUES($1,$2,$3,$4,$5,'fixture',1,$6)",
          [
            release.id,
            release.adventureId,
            release.version,
            release.author,
            release.operationId,
            JSON.stringify(release.snapshot),
          ],
        );
      }
      async function createPrivatePlayable(value, author) {
        const version = randomUUID(),
          release = {
            id: randomUUID(),
            adventureId: value.id,
            version,
            author,
            operationId: randomUUID(),
            snapshot: structuredClone(value),
          };
        const pkg = {
          schemaVersion: 2,
          kind: 'launch-source',
          compiled: null,
          source: {
            title: value.title,
            sourceLanguage: value.sourceLanguage,
            content: { locations: [] },
          },
          plannerSource: { title: value.title, content: { locations: [], npcIds: [] }, npcs: [] },
          npcDefinitions: [],
        };
        await pool.query(
          "INSERT INTO game_playable_versions(id,adventure_id,source_revision,audience,package,checksum) VALUES($1,$2,1,'private',$3,$4)",
          [version, value.id, JSON.stringify(pkg), digest(pkg)],
        );
        await insertPrivateRelease(release);
        await pool.query('UPDATE adventures SET private_release_id=$2 WHERE id=$1', [
          value.id,
          release.id,
        ]);
        return release;
      }
      async function reconcileReleased(worker) {
        while (await count('SELECT count(*)::int n FROM platform_content_translation_events')) {
          const result = await worker.reconcile();
          assert.ok(result, 'the full adapter registry must examine every release event');
          assert.ok(
            !result.remaining || result.admitted > 0,
            'shared admission must make progress',
          );
        }
      }
      async function drainReleased(workers) {
        do {
          await reconcileReleased(workers[0]);
          await runQueued(workers);
        } while (await count('SELECT count(*)::int n FROM platform_content_translation_events'));
      }
      await reconcileAll();

      await t.test(
        'release creates all missing RU/UK/EN work without any read; concurrent replicas pay once',
        async () => {
          const values = [];
          for (const locale of ['ru', 'uk', 'en'])
            values.push(await source('Title ' + locale, { locale }));
          assert.equal(await events(), 3);
          const before = calls.length;
          const workers = [service(), service(), service()];
          await Promise.all(workers.map((worker) => worker.reconcile()));
          await reconcileAll();
          assert.equal(await queued(), 6);
          await runQueued(workers);
          assert.equal(calls.length, before + 6);
          assert.deepEqual(
            [...new Set(calls.slice(before).map((call) => call.context.targetLocale))].sort(),
            ['en', 'ru', 'uk'],
          );
          assert.ok(calls.slice(before).every((call) => call.context.items.length === 1));
          assert.ok(!JSON.stringify(calls.slice(before)).includes('WITHHELD CANON'));
          for (const value of values) {
            const rows = await jobs(value.id);
            assert.equal(rows.length, 2);
            assert.ok(
              rows.every((row) => row.status === 'ready' && row.reserve_status === 'settled'),
            );
            for (const locale of ['ru', 'uk', 'en']) {
              const localized = await localize(value, null, locale);
              assert.equal(localized.pending, false);
              if (locale !== value.sourceLanguage)
                assert.equal(
                  localized.value.translations[locale].title,
                  locale + ':' + value.title,
                );
              else assert.equal(localized.value.title, value.title);
            }
          }
          await Promise.all(workers.map((worker) => worker.reconcile()));
          await runQueued(workers);
          assert.equal(calls.length, before + 6);
        },
      );

      await t.test(
        'adventure and approved playable share one paid title artifact per locale and erase both bindings together',
        async () => {
          const author = await user(),
            otherAuthor = await user();
          const title = 'Shared immutable title ' + randomUUID().slice(0, 12);
          const value = await source(title, { ownerId: author });
          const version = await approvePlayableTitle(value);
          const adapters = [...studioContentTranslationAdapters, new PlayableContentSource()];
          const workers = [
            new PlatformContentTranslations(db, adapters, provider, config),
            new PlatformContentTranslations(db, adapters, provider, config),
          ];
          const before = calls.length;
          assert.equal(
            await count(
              'SELECT count(*)::int n FROM platform_content_translation_events WHERE source_id=ANY($1::text[])',
              [[value.id, version]],
            ),
            2,
          );
          await Promise.all(workers.map((worker) => worker.reconcile()));
          assert.equal(
            await count(
              'SELECT count(*)::int n FROM platform_content_translation_events WHERE source_id=ANY($1::text[])',
              [[value.id, version]],
            ),
            0,
          );
          const sharedJobs = [...(await jobs(value.id)), ...(await jobs(version))];
          assert.equal(
            sharedJobs.length,
            2,
            'two presentation sources must not create four paid attempts',
          );
          assert.deepEqual(sharedJobs.map((row) => row.locale).sort(), ['en', 'uk']);
          const bindings = await db.query(
            'SELECT * FROM platform_content_translation_bindings WHERE source_id=ANY($1::text[])',
            [[value.id, version]],
          );
          assert.equal(bindings.length, 4);
          assert.deepEqual([...new Set(bindings.map((row) => row.source_kind))].sort(), [
            'adventure',
            'playable',
          ]);
          for (const locale of ['en', 'uk']) {
            const pair = bindings.filter((row) => row.locale === locale);
            assert.equal(pair.length, 2);
            assert.equal(pair[0].cache_keys.length, 1);
            assert.deepEqual(pair[0].cache_keys, pair[1].cache_keys);
          }
          await runQueued(workers);
          assert.equal(calls.length, before + 2);
          assert.ok(
            calls
              .slice(before)
              .every(
                (request) =>
                  request.context.items.length === 1 && request.context.items[0].text === title,
              ),
          );
          assert.equal((await localize(value)).value.translations.en.title, 'en:' + title);
          const cacheKeys = sharedJobs.map((row) => row.cache_key),
            retainedIds = sharedJobs.map((row) => row.id);
          assert.equal(
            await count(
              "SELECT count(*)::int n FROM platform_content_translation_cache WHERE key=ANY($1::text[]) AND status='ready'",
              [cacheKeys],
            ),
            2,
          );
          // Equal text in another story/ownership compartment must still be independently paid and retained.
          const control = await source(title, { ownerId: otherAuthor });
          await drain();
          assert.equal(calls.length, before + 4);
          const controlJobs = await jobs(control.id);
          assert.equal(controlJobs.length, 2);
          assert.ok(controlJobs.every((row) => !cacheKeys.includes(row.cache_key)));
          await pool.query('UPDATE users SET deleted_at=now() WHERE id=$1', [author]);
          assert.equal(
            await count(
              'SELECT count(*)::int n FROM platform_content_translation_cache WHERE key=ANY($1::text[])',
              [cacheKeys],
            ),
            0,
          );
          assert.equal(
            await count(
              'SELECT count(*)::int n FROM platform_content_translation_bindings WHERE source_id=ANY($1::text[])',
              [[value.id, version]],
            ),
            0,
          );
          const retained = await jobs(retainedIds);
          assert.equal(retained.length, 2);
          assert.ok(
            retained.every(
              (row) =>
                row.context === null &&
                row.result === null &&
                row.field_path === '' &&
                row.source_id === '' &&
                row.partition === 'erased' &&
                row.authority === 'erased' &&
                row.erasure_user_ids.length === 0,
            ),
          );
          assert.ok(!JSON.stringify(retained).includes(title));
          assert.ok(!JSON.stringify(retained).includes(author));
          assert.ok(
            retained.every(
              (row) => row.reserve_status === 'settled' && Number(row.actual_micros) === 30,
            ),
          );
          assert.deepEqual(
            await db.tx((c) =>
              adapters.at(-1).load(c, { kind: 'playable', id: version }, { kind: 'system' }),
            ),
            [],
          );
          assert.equal((await localize(control)).value.translations.en.title, 'en:' + title);
          assert.equal(
            await count(
              "SELECT count(*)::int n FROM platform_content_translation_cache WHERE key=ANY($1::text[]) AND status='ready'",
              [controlJobs.map((row) => row.cache_key)],
            ),
            2,
          );
          await Promise.all(workers.map((worker) => worker.tick()));
          assert.equal(calls.length, before + 4);
        },
      );

      await t.test(
        'a prose-only source edit cannot poison an in-flight shared artifact still authorized by its playable binding',
        async () => {
          const originalTitle = 'In-flight shared A',
            replacementTitle = 'In-flight replacement B';
          const value = await source(originalTitle, { ownerId: await user() });
          await reconcileAll(); // Force the original paid claim to belong to the adventure adapter.
          const originalJobs = await jobs(value.id),
            originalKeys = originalJobs.map((row) => row.cache_key);
          assert.equal(originalJobs.length, 2);
          assert.ok(originalJobs.every((row) => row.source_kind === 'adventure'));
          const version = await approvePlayableTitle(value);
          const adapters = [...studioContentTranslationAdapters, new PlayableContentSource()];
          const workers = [
            new PlatformContentTranslations(db, adapters, provider, config),
            new PlatformContentTranslations(db, adapters, provider, config),
          ];
          await reconcileReleased(workers[0]);
          const before = calls.length,
            started = gate(),
            release = gate();
          const epoch = (
            await db.query('SELECT translation_epoch FROM adventures WHERE id=$1', [value.id])
          )[0].translation_epoch;
          behavior = async () => {
            started.resolve();
            await release.promise;
          };
          const dispatch = workers[0].tick();
          let dispatched;
          try {
            await started.promise;
            dispatched = calls.at(-1);
            assert.ok(originalJobs.some((row) => row.id === dispatched.jobId));
            await edit(value, { title: replacementTitle });
            assert.equal(
              (
                await db.query('SELECT translation_epoch FROM adventures WHERE id=$1', [value.id])
              )[0].translation_epoch,
              epoch,
            );
            await reconcileReleased(workers[1]);
            const surviving = await db.query(
              'SELECT * FROM platform_content_translation_bindings WHERE source_id=$1 AND locale=$2',
              [version, dispatched.context.targetLocale],
            );
            assert.equal(surviving.length, 1);
            assert.deepEqual(surviving[0].cache_keys, [dispatched.context.items[0].id]);
            release.resolve();
            await dispatch;
          } finally {
            release.resolve();
            behavior = undefined;
            await dispatch;
          }
          const paid = (await jobs([dispatched.jobId]))[0];
          assert.equal(
            paid.status,
            'ready',
            'a live exact playable binding must preserve the shared successful receipt',
          );
          assert.equal(paid.reserve_status, 'settled');
          assert.equal(Number(paid.actual_micros), 30);
          const saved = (
            await db.query('SELECT * FROM platform_content_translation_cache WHERE key=$1', [
              paid.cache_key,
            ])
          )[0];
          assert.equal(saved.status, 'ready');
          assert.equal(saved.translated_text, paid.locale + ':' + originalTitle);
          await drainReleased(workers);
          const requests = calls.slice(before);
          assert.equal(requests.length, 4);
          for (const title of [originalTitle, replacementTitle])
            for (const locale of ['uk', 'en'])
              assert.equal(
                requests.filter(
                  (request) =>
                    request.context.targetLocale === locale &&
                    request.context.items[0].text === title,
                ).length,
                1,
              );
          assert.equal(
            await count(
              "SELECT count(*)::int n FROM platform_content_translation_cache WHERE key=ANY($1::text[]) AND status='ready'",
              [originalKeys],
            ),
            2,
          );
          assert.equal(
            (await localize(value)).value.translations.en.title,
            'en:' + replacementTitle,
          );
          await edit(value, { title: originalTitle });
          await drainReleased(workers);
          assert.equal(
            calls.length,
            before + 4,
            'returning to A must reuse the shared receipt, never create a second paid A attempt',
          );
          assert.equal((await localize(value)).value.translations.en.title, 'en:' + originalTitle);
        },
      );

      await t.test(
        'a freshly live shared binding cannot bypass revocation of the original in-flight authority',
        async () => {
          const originalTitle = 'Revoked shared A',
            replacementTitle = 'Fresh replacement B';
          const value = await source(originalTitle, { ownerId: await user() });
          await reconcileAll();
          const originalJobs = await jobs(value.id);
          const version = await approvePlayableTitle(value);
          const adapter = new PlayableContentSource(),
            adapters = [...studioContentTranslationAdapters, adapter];
          const workers = [
            new PlatformContentTranslations(db, adapters, provider, config),
            new PlatformContentTranslations(db, adapters, provider, config),
          ];
          await reconcileReleased(workers[0]);
          const before = calls.length,
            started = gate(),
            release = gate();
          const epoch = (
            await db.query('SELECT translation_epoch FROM adventures WHERE id=$1', [value.id])
          )[0].translation_epoch;
          behavior = async () => {
            started.resolve();
            await release.promise;
          };
          const dispatch = workers[0].tick();
          let dispatched;
          try {
            await started.promise;
            dispatched = calls.at(-1);
            assert.ok(originalJobs.some((row) => row.id === dispatched.jobId));
            await pool.query("UPDATE adventures SET status='archived' WHERE id=$1", [value.id]);
            await pool.query("UPDATE adventures SET status='published' WHERE id=$1", [value.id]);
            await edit(value, { title: replacementTitle });
            assert.notEqual(
              (
                await db.query('SELECT translation_epoch FROM adventures WHERE id=$1', [value.id])
              )[0].translation_epoch,
              epoch,
            );
            await reconcileReleased(workers[1]);
            const live = await db.tx((c) =>
              adapter.load(c, { kind: 'playable', id: version }, { kind: 'system' }),
            );
            assert.ok(
              live[0].fields.some(
                (field) => field.path === 'title' && field.text === originalTitle,
              ),
              'the alternate binding is currently authorized, but the original dispatch lifetime is not',
            );
            release.resolve();
            await dispatch;
          } finally {
            release.resolve();
            behavior = undefined;
            await dispatch;
          }
          const rejected = (await jobs([dispatched.jobId]))[0];
          assert.equal(rejected.status, 'failed');
          assert.equal(rejected.reserve_status, 'settled');
          assert.equal(Number(rejected.actual_micros), 30);
          const saved = (
            await db.query('SELECT * FROM platform_content_translation_cache WHERE key=$1', [
              rejected.cache_key,
            ])
          )[0];
          assert.equal(saved.status, 'failed');
          assert.equal(saved.translated_text, null);
          await drainReleased(workers);
          assert.equal(
            await count(
              "SELECT count(*)::int n FROM platform_content_translation_jobs WHERE cache_key=$1 AND status<>'cancelled'",
              [rejected.cache_key],
            ),
            1,
          );
          assert.equal(
            calls
              .slice(before)
              .filter((request) => request.context.items[0].id === rejected.cache_key).length,
            1,
            'revocation cannot authorize a retry of an already dispatched artifact',
          );
          assert.equal(
            (
              await db.query('SELECT status FROM platform_content_translation_cache WHERE key=$1', [
                rejected.cache_key,
              ])
            )[0].status,
            'failed',
          );
          assert.equal(
            (await localize(value)).value.translations.en.title,
            'en:' + replacementTitle,
          );
        },
      );

      await t.test(
        'historical private-release delete and reinsert rotate authority, honor source locks and reject old queued/late work',
        async () => {
          const author = await user(),
            oldTitle = 'Historical private A';
          const value = await source(oldTitle, {
            ownerId: author,
            visibility: 'private',
            released: false,
          });
          value.status = 'published';
          await pool.query("UPDATE adventures SET status='published' WHERE id=$1", [value.id]);
          const oldRelease = await createPrivatePlayable(value, author);
          const adapter = new PlayableContentSource();
          const oldWorker = new PlatformContentTranslations(db, [adapter], provider, config);
          while (
            await count(
              "SELECT count(*)::int n FROM platform_content_translation_events WHERE source_kind='playable'",
            )
          )
            assert.ok(await oldWorker.reconcile());
          const originalJobs = await jobs(oldRelease.version);
          assert.equal(originalJobs.length, 2);
          const epoch = (
            await db.query('SELECT translation_epoch FROM adventures WHERE id=$1', [value.id])
          )[0].translation_epoch;
          const newer = await createPrivatePlayable(
            { ...value, title: 'Current private B' },
            author,
          );
          assert.equal(
            (await db.query('SELECT translation_epoch FROM adventures WHERE id=$1', [value.id]))[0]
              .translation_epoch,
            epoch,
            'adding a newer release does not revoke the old grant',
          );
          assert.equal(
            (await db.query('SELECT private_release_id FROM adventures WHERE id=$1', [value.id]))[0]
              .private_release_id,
            newer.id,
          );
          // These immutable operations must remain rejected under the complete migrations.
          const approval = (
            await db.query('SELECT playable_version_id FROM game_playable_approvals LIMIT 1')
          )[0];
          assert.ok(approval);
          await assert.rejects(
            () =>
              pool.query(
                'UPDATE game_playable_approvals SET approved_at=approved_at WHERE playable_version_id=$1',
                [approval.playable_version_id],
              ),
            /Append-only table/,
          );
          await assert.rejects(
            () =>
              pool.query('DELETE FROM game_playable_approvals WHERE playable_version_id=$1', [
                approval.playable_version_id,
              ]),
            /Append-only table/,
          );
          await assert.rejects(
            () =>
              pool.query('UPDATE adventure_private_releases SET snapshot=snapshot WHERE id=$1', [
                oldRelease.id,
              ]),
            /Private releases are immutable/,
          );
          const sourceRef = { kind: 'playable', id: oldRelease.version };
          const reader = await pool.connect(),
            writer = await pool.connect();
          try {
            await reader.query('BEGIN');
            assert.equal((await adapter.load(reader, sourceRef, { kind: 'system' })).length, 1);
            await writer.query('BEGIN');
            const pid = (await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
            const deletion = writer.query('DELETE FROM adventure_private_releases WHERE id=$1', [
              oldRelease.id,
            ]);
            await waitBlocked(pid);
            await reader.query('COMMIT');
            await deletion;
            await writer.query('ROLLBACK');
            assert.equal(
              (
                await db.query('SELECT translation_epoch FROM adventures WHERE id=$1', [value.id])
              )[0].translation_epoch,
              epoch,
            );
            // Reverse order: the uncommitted grant deletion owns the source fence.
            await writer.query('BEGIN');
            await writer.query('DELETE FROM adventure_private_releases WHERE id=$1', [
              oldRelease.id,
            ]);
            const before = calls.length;
            await assert.rejects(
              () => oldWorker.tick(),
              (error) => error.code === '55P03',
            );
            assert.equal(calls.length, before);
            assert.ok((await jobs(oldRelease.version)).every((row) => row.status === 'queued'));
            await writer.query('ROLLBACK');
          } finally {
            await reader.query('ROLLBACK');
            reader.release();
            await writer.query('ROLLBACK');
            writer.release();
          }
          const adapters = [...studioContentTranslationAdapters, adapter];
          const workers = [
            new PlatformContentTranslations(db, adapters, provider, config),
            new PlatformContentTranslations(db, adapters, provider, config),
          ];
          const started = gate(),
            release = gate(),
            before = calls.length;
          behavior = async () => {
            started.resolve();
            await release.promise;
          };
          const dispatch = oldWorker.tick();
          let dispatched;
          try {
            await started.promise;
            dispatched = calls.at(-1);
            assert.ok(originalJobs.some((row) => row.id === dispatched.jobId));
            await pool.query('DELETE FROM adventure_private_releases WHERE id=$1', [oldRelease.id]);
            const revokedEpoch = (
              await db.query('SELECT translation_epoch FROM adventures WHERE id=$1', [value.id])
            )[0].translation_epoch;
            assert.notEqual(revokedEpoch, epoch);
            assert.equal(
              (
                await db.query('SELECT private_release_id FROM adventures WHERE id=$1', [value.id])
              )[0].private_release_id,
              newer.id,
            );
            assert.deepEqual(
              await db.tx((c) => adapter.load(c, sourceRef, { kind: 'system' })),
              [],
            );
            await insertPrivateRelease(oldRelease);
            assert.equal(
              (
                await db.query('SELECT translation_epoch FROM adventures WHERE id=$1', [value.id])
              )[0].translation_epoch,
              revokedEpoch,
            );
            const restored = await db.tx((c) => adapter.load(c, sourceRef, { kind: 'system' }));
            assert.ok(
              restored[0].fields.some((field) => field.path === 'title' && field.text === oldTitle),
            );
            assert.notEqual(restored[0].authority, originalJobs[0].authority);
            release.resolve();
            await dispatch;
          } finally {
            release.resolve();
            behavior = undefined;
            await dispatch;
          }
          const late = (await jobs([dispatched.jobId]))[0];
          assert.equal(late.status, 'failed');
          assert.equal(late.reserve_status, 'settled');
          assert.equal(Number(late.actual_micros), 30);
          assert.equal(
            (
              await db.query('SELECT status FROM platform_content_translation_cache WHERE key=$1', [
                late.cache_key,
              ])
            )[0].status,
            'failed',
          );
          const undispatched = originalJobs.find((row) => row.id !== dispatched.jobId);
          await oldWorker.tick();
          const cancelled = (await jobs([undispatched.id]))[0];
          assert.equal(cancelled.status, 'cancelled');
          assert.equal(cancelled.reserve_status, 'released');
          await drainReleased(workers);
          assert.equal(
            calls.slice(before).filter((request) => request.context.items[0].id === late.cache_key)
              .length,
            1,
          );
          assert.equal(
            (
              await db.query('SELECT status FROM platform_content_translation_cache WHERE key=$1', [
                late.cache_key,
              ])
            )[0].status,
            'failed',
          );
        },
      );

      await t.test(
        'outbox remains durable beyond one admission window until every eligible field is covered',
        async () => {
          const tags = Array.from({ length: 9 }, (_, index) => 'Custom tag ' + index);
          const value = await source('Many fields', { extra: { tags } });
          const before = calls.length,
            worker = service();
          const first = await worker.reconcile();
          assert.deepEqual(first, { admitted: 16, remaining: true });
          assert.equal(await events(), 1);
          assert.equal((await jobs(value.id)).length, 16);
          const second = await service().reconcile();
          assert.deepEqual(second, { admitted: 4, remaining: false });
          assert.equal(await events(), 0);
          assert.equal((await jobs(value.id)).length, 20);
          await runQueued();
          assert.equal(calls.length, before + 20);
          assert.equal(new Set((await jobs(value.id)).map((row) => row.cache_key)).size, 20);
          const localized = await localize(value);
          assert.ok(tags.every((tag) => localized.value.translations.en.tags[tag] === 'en:' + tag));
        },
      );

      await t.test(
        'draft insert/edit and draft data edits beside a release create no paid event',
        async () => {
          const value = await source('Unreleased draft', { released: false });
          const before = calls.length;
          await pool.query(
            "UPDATE adventures SET title='Edited draft',data=jsonb_set(data,'{title}','\"Edited draft\"') WHERE id=$1",
            [value.id],
          );
          assert.equal(await events(), 0);
          await localize({ ...value, status: 'published', visibility: 'public' }, owner);
          await service().reconcile();
          await service().tick();
          assert.equal(calls.length, before);
          assert.equal((await jobs(value.id)).length, 0);
          const released = await source('Released title');
          await drain();
          const after = calls.length;
          await pool.query(
            "UPDATE adventures SET data=jsonb_set(data,'{title}','\"Draft-only edit\"') WHERE id=$1",
            [released.id],
          );
          assert.equal(await events(), 0);
          assert.equal((await localize(released)).value.translations.en.title, 'en:Released title');
          await service().tick();
          assert.equal(calls.length, after);
          // Moving the draft to a release, not GET, is the admission trigger.
          await edit(value, { status: 'published', title: 'New release' });
          await pool.query("UPDATE adventures SET status='published' WHERE id=$1", [value.id]);
          assert.equal(await events(), 1);
          await drain();
          assert.equal((await jobs(value.id)).length, 2);
        },
      );

      await t.test(
        'revision-only changes reuse fields, field edits invalidate only themselves, A-B-A reuses ready text',
        async () => {
          const value = await source('Original title', { synopsis: 'Stable synopsis' });
          await drain();
          const before = calls.length,
            keys = (await jobs(value.id)).map((row) => row.cache_key).sort();
          await edit(value, { sourceRevision: 2, unrelated: 'changed' });
          await drain();
          assert.equal(calls.length, before);
          assert.deepEqual((await jobs(value.id)).map((row) => row.cache_key).sort(), keys);
          await edit(value, { title: 'Replacement title' });
          await drain();
          assert.equal(calls.length, before + 2);
          assert.ok(
            calls.slice(before).every((call) => call.context.items[0].text === 'Replacement title'),
          );
          assert.equal(
            (await localize(value)).value.translations.en.synopsis,
            'en:Stable synopsis',
          );
          await edit(value, { title: 'Original title', sourceRevision: 3 });
          await drain();
          assert.equal(calls.length, before + 2);
          assert.equal((await localize(value)).value.translations.en.title, 'en:Original title');
        },
      );

      await t.test(
        'private release shares authorized cache but forged DTOs, strangers and revoked viewers get none',
        async () => {
          const value = await source('Private canary', { visibility: 'private' });
          await drain();
          const before = calls.length;
          assert.equal(
            (await localize(value, owner)).value.translations.en.title,
            'en:Private canary',
          );
          assert.equal(
            (await localize(value, reader)).value.translations.en.title,
            'en:Private canary',
          );
          for (const viewer of [null, stranger]) {
            const denied = await localize(value, viewer);
            assert.equal(denied.value.translations.en, undefined);
            assert.equal(denied.pending, false);
          }
          assert.equal(
            (await localize({ ...value, visibility: 'public' }, null)).value.translations.en,
            undefined,
          );
          assert.equal(
            (await localize({ ...value, title: 'Forged source' }, owner)).value.translations.en,
            undefined,
          );
          const oldEpoch = (
            await db.query(
              'SELECT translation_epoch FROM adventure_invitations WHERE adventure_id=$1',
              [value.id],
            )
          )[0].translation_epoch;
          await pool.query(
            "UPDATE adventure_invitations SET status='revoked' WHERE adventure_id=$1",
            [value.id],
          );
          assert.equal((await localize(value, reader)).value.translations.en, undefined);
          await pool.query(
            "UPDATE adventure_invitations SET status='accepted' WHERE adventure_id=$1",
            [value.id],
          );
          const newEpoch = (
            await db.query(
              'SELECT translation_epoch FROM adventure_invitations WHERE adventure_id=$1',
              [value.id],
            )
          )[0].translation_epoch;
          assert.notEqual(newEpoch, oldEpoch);
          assert.equal(
            (await localize(value, reader)).value.translations.en.title,
            'en:Private canary',
          );
          await drain();
          assert.equal(calls.length, before);
        },
      );

      await t.test(
        'source revoke and regrant invalidate old queued authority before any external dispatch',
        async () => {
          const value = await source('Epoch canary');
          await reconcileAll();
          const original = await jobs(value.id),
            before = calls.length;
          await pool.query("UPDATE adventures SET status='archived' WHERE id=$1", [value.id]);
          await pool.query("UPDATE adventures SET status='published' WHERE id=$1", [value.id]);
          await runQueued();
          assert.equal(calls.length, before);
          const cancelled = await jobs(value.id);
          assert.ok(
            cancelled.every(
              (row) => row.status === 'cancelled' && row.reserve_status === 'released',
            ),
          );
          await drain();
          const replaced = (await jobs(value.id)).filter((row) => row.status === 'ready');
          assert.equal(replaced.length, 2);
          assert.ok(
            replaced.every(
              (row) =>
                !original.some((old) => old.id === row.id || old.authority === row.authority),
            ),
          );
          assert.equal(calls.length, before + 2);
        },
      );

      await t.test(
        'delayed cancellation of an old queued claim cannot delete its new A-B-A successor',
        async () => {
          const value = await source('Queued A', { oneTarget: true });
          await reconcileAll();
          const old = (await jobs(value.id))[0],
            before = calls.length;
          await edit(value, { title: 'Queued B' });
          await reconcileAll();
          await service().tick(); // Cancel A, whose source changed before dispatch.
          assert.equal((await jobs(value.id)).find((row) => row.id === old.id).status, 'cancelled');
          await edit(value, { title: 'Queued A' });
          await reconcileAll();
          const successor = (await jobs(value.id)).find(
            (row) => row.cache_key === old.cache_key && row.id !== old.id,
          );
          assert.ok(successor && successor.status === 'queued');
          // Replay a delayed old-claim cancellation transaction after the successor exists.
          await db.tx((c) => service().cancelQueued(c, old));
          const cache = (
            await db.query('SELECT * FROM platform_content_translation_cache WHERE key=$1', [
              old.cache_key,
            ])
          )[0];
          assert.equal(cache.claim_job_id, successor.id);
          assert.equal(cache.status, 'pending');
          await drain();
          assert.equal(calls.length, before + 1);
          assert.equal((await localize(value)).value.translations.en.title, 'en:Queued A');
          assert.equal(
            (await jobs(value.id)).filter(
              (row) => row.cache_key === old.cache_key && row.status !== 'cancelled',
            ).length,
            1,
          );
        },
      );

      await t.test(
        'unknown provider outcome retains held exposure and A-B-A never pays a second time',
        async () => {
          const value = await source('Unknown A', { oneTarget: true });
          await reconcileAll();
          const before = calls.length;
          behavior = async () => {
            throw new ProviderFailure('SYNTHETIC_LOST_RESPONSE', true);
          };
          try {
            await runQueued();
          } finally {
            behavior = undefined;
          }
          const unknown = (await jobs(value.id))[0];
          assert.equal(unknown.status, 'unknown');
          assert.equal(unknown.reserve_status, 'held');
          assert.equal(unknown.actual_micros, null);
          assert.equal((await localize(value)).pending, false);
          await edit(value, { title: 'Known B' });
          await drain();
          await edit(value, { title: 'Unknown A' });
          await drain();
          await Promise.all([service().tick(), service().reconcile()]);
          assert.equal(calls.length, before + 2);
          assert.equal(
            (await jobs(value.id)).filter((row) => row.cache_key === unknown.cache_key).length,
            1,
          );
          assert.equal((await localize(value)).value.translations.en, undefined);
          // Even loss of prose cache cannot remove the durable paid-attempt barrier.
          await pool.query('DELETE FROM platform_content_translation_cache WHERE key=$1', [
            unknown.cache_key,
          ]);
          await edit(value, { unrelatedRevision: 2 });
          await drain();
          assert.equal(calls.length, before + 2);
          assert.equal(
            (await jobs(value.id)).find((row) => row.id === unknown.id).reserve_status,
            'held',
          );
        },
      );

      await t.test(
        'a persisted receipt survives a worker crash and settles once without redispatch',
        async () => {
          const value = await source('Receipt recovery', { oneTarget: true });
          await reconcileAll();
          const before = calls.length,
            worker = service();
          worker.finish = async () => {
            throw new Error('synthetic crash after durable receipt');
          };
          await assert.rejects(() => worker.tick(), /synthetic crash after durable receipt/);
          assert.equal((await jobs(value.id))[0].status, 'result_received');
          await service().tick();
          await service().tick();
          const recovered = (await jobs(value.id))[0];
          assert.equal(recovered.status, 'ready');
          assert.equal(recovered.reserve_status, 'settled');
          assert.equal(Number(recovered.actual_micros), 30);
          assert.equal(calls.length, before + 1);
        },
      );

      await t.test(
        'late receipt settles a timed-out hold exactly once without a second provider request',
        async () => {
          const value = await source('Late receipt', { oneTarget: true });
          await reconcileAll();
          const started = gate(),
            release = gate(),
            before = calls.length;
          behavior = async () => {
            started.resolve();
            await release.promise;
          };
          const dispatch = service().tick();
          try {
            await started.promise;
            await pool.query(
              "UPDATE platform_content_translation_jobs SET deadline_at=now()-interval '1 second' WHERE source_id=$1",
              [value.id],
            );
            await service().tick();
            const timedOut = (await jobs(value.id))[0];
            assert.equal(timedOut.status, 'unknown');
            assert.equal(timedOut.reserve_status, 'held');
            assert.equal((await localize(value)).pending, false);
            release.resolve();
            await dispatch;
          } finally {
            release.resolve();
            behavior = undefined;
            await dispatch;
          }
          await service().tick();
          const settled = (await jobs(value.id))[0];
          assert.equal(settled.status, 'ready');
          assert.equal(settled.reserve_status, 'settled');
          assert.equal(Number(settled.actual_micros), 30);
          assert.equal(calls.length, before + 1);
        },
      );

      await t.test(
        'cache-only provider, kill switch, expired pricing and stale deployment cannot dispatch',
        async () => {
          const value = await source('Admission gates', { oneTarget: true }),
            before = calls.length;
          const disabled = new PlatformContentTranslations(db, studioContentTranslationAdapters);
          await disabled.reconcile();
          await disabled.tick();
          assert.equal((await localize(value, null, 'en', disabled)).pending, false);
          assert.equal((await jobs(value.id)).length, 0);
          let enabled = false;
          const worker = new PlatformContentTranslations(
            db,
            studioContentTranslationAdapters,
            provider,
            config,
            () => enabled,
          );
          await worker.reconcile();
          assert.equal((await jobs(value.id)).length, 0);
          enabled = true;
          await worker.reconcile();
          enabled = false;
          await worker.tick();
          assert.equal(calls.length, before);
          assert.equal((await jobs(value.id))[0].status, 'queued');
          const expired = {
            ...config,
            text: {
              ...config.text,
              pricing: { ...config.text.pricing, validUntil: '2000-01-01T00:00:00.000Z' },
            },
          };
          const stalePrice = new PlatformContentTranslations(
            db,
            studioContentTranslationAdapters,
            provider,
            expired,
          );
          await stalePrice.reconcile();
          await stalePrice.tick();
          assert.equal(calls.length, before);
          const next = readGenerationConfig({
            GENERATION_MODE: 'release',
            GENERATION_CONFIG_JSON: JSON.stringify({
              allowance: 'unlimited',
              text: { ...profile.text, maxOutputTokens: profile.text.maxOutputTokens + 1 },
              image: profile.image,
            }),
          });
          await db.tx((c) => activateReleaseDeployment(c, next));
          enabled = true;
          await assert.rejects(() => worker.tick(), /GENERATION_RELEASE_PROFILE_NOT_ACTIVE/);
          await new PlatformContentTranslations(
            db,
            studioContentTranslationAdapters,
            provider,
            next,
          ).tick();
          const cancelled = (await jobs(value.id))[0];
          assert.equal(cancelled.status, 'cancelled');
          assert.equal(cancelled.reserve_status, 'released');
          assert.equal(calls.length, before);
          await db.tx((c) => activateReleaseDeployment(c, config));
          await drain();
          assert.equal(calls.length, before + 1);
        },
      );

      await t.test(
        'invalid output settles known cost, exposes no partial text and cannot retry',
        async () => {
          const value = await source('Invalid output', { oneTarget: true });
          await reconcileAll();
          const before = calls.length;
          behavior = async () => ({
            requestId: 'invalid',
            usage: { inputTokens: 10, outputTokens: 10, costMicros: 30, costEvidence: 'reported' },
            proposal: { translations: [] },
          });
          try {
            await runQueued();
          } finally {
            behavior = undefined;
          }
          await edit(value, { unrelatedRevision: 2 });
          await drain();
          const failed = (await jobs(value.id))[0];
          assert.equal(failed.status, 'failed');
          assert.equal(failed.reserve_status, 'settled');
          assert.equal(Number(failed.actual_micros), 30);
          assert.equal(calls.length, before + 1);
          assert.equal((await localize(value)).value.translations.en, undefined);
        },
      );

      await t.test(
        'in-flight source revocation blocks publication but preserves exact provider settlement',
        async () => {
          const value = await source('Revoked in flight', { oneTarget: true });
          await reconcileAll();
          const before = calls.length;
          behavior = async () => {
            await pool.query("UPDATE adventures SET status='archived' WHERE id=$1", [value.id]);
          };
          try {
            await service().tick();
          } finally {
            behavior = undefined;
          }
          const row = (await jobs(value.id))[0];
          assert.equal(row.status, 'failed');
          assert.equal(row.reserve_status, 'settled');
          assert.equal(Number(row.actual_micros), 30);
          assert.equal(calls.length, before + 1);
          assert.equal((await localize(value)).value.translations.en, undefined);
          await drain();
        },
      );

      async function waitBlocked(pid) {
        const deadline = Date.now() + 3000;
        do {
          if ((await db.query('SELECT cardinality(pg_blocking_pids($1)) n', [pid]))[0].n > 0)
            return;
          await new Promise((resolve) => setTimeout(resolve, 5));
        } while (Date.now() < deadline);
        assert.fail('the competing erasure must wait on the source/user dispatch fence');
      }
      await t.test(
        'dispatch holds user/source authorization through the durable transition while concurrent erasure waits',
        async () => {
          const erasedOwner = await user(),
            value = await source('Fenced erasure', { ownerId: erasedOwner, oneTarget: true });
          await reconcileAll();
          const retainedIds = (await jobs(value.id)).map((row) => row.id);
          const validated = gate(),
            resume = gate(),
            started = gate(),
            release = gate();
          let paused = false;
          const hooked = {
            ...db,
            tx: (work) =>
              db.tx((c) =>
                work({
                  query: async (sql, args) => {
                    const result = await c.query(sql, args);
                    if (!paused && sql.includes('SELECT a.id,a.owner_id,a.visibility')) {
                      paused = true;
                      validated.resolve();
                      await resume.promise;
                    }
                    return result;
                  },
                }),
              ),
          };
          const worker = new PlatformContentTranslations(
            hooked,
            studioContentTranslationAdapters,
            provider,
            config,
          );
          const before = calls.length;
          behavior = async () => {
            started.resolve();
            await release.promise;
          };
          const dispatch = worker.tick();
          const erasure = await pool.connect();
          try {
            await validated.promise;
            await erasure.query('BEGIN');
            const pid = (await erasure.query('SELECT pg_backend_pid() pid')).rows[0].pid;
            const erase = erasure.query('UPDATE users SET deleted_at=now() WHERE id=$1', [
              erasedOwner,
            ]);
            await waitBlocked(pid);
            assert.equal(calls.length, before);
            assert.equal((await jobs(retainedIds))[0].status, 'queued');
            resume.resolve();
            await started.promise;
            await erase;
            await erasure.query('COMMIT');
            assert.equal((await jobs(retainedIds))[0].context, null);
            release.resolve();
            await dispatch;
            const row = (await jobs(retainedIds))[0];
            assert.equal(row.status, 'failed');
            assert.equal(row.reserve_status, 'settled');
            assert.equal(Number(row.actual_micros), 30);
            assert.equal(calls.length, before + 1);
            assert.equal((await localize(value)).value.translations.en, undefined);
          } finally {
            resume.resolve();
            release.resolve();
            behavior = undefined;
            await erasure.query('ROLLBACK');
            erasure.release();
            await dispatch;
          }
          await drain();
        },
      );

      await t.test(
        'erasure winning its user lock aborts dispatch without a job/user deadlock',
        async () => {
          const erasedOwner = await user(),
            value = await source('Erasure wins', { ownerId: erasedOwner, oneTarget: true });
          await reconcileAll();
          const retainedIds = (await jobs(value.id)).map((row) => row.id);
          const before = calls.length;
          const erasure = await pool.connect();
          try {
            await erasure.query('BEGIN');
            await erasure.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [erasedOwner]);
            await assert.rejects(
              () => service().tick(),
              (error) => error.code === '55P03',
            );
            assert.equal(calls.length, before);
            assert.equal((await jobs(retainedIds))[0].status, 'queued');
            await erasure.query('UPDATE users SET deleted_at=now() WHERE id=$1', [erasedOwner]);
            await erasure.query('COMMIT');
            await runQueued();
            const row = (await jobs(retainedIds))[0];
            assert.equal(row.status, 'cancelled');
            assert.equal(row.reserve_status, 'released');
            assert.equal(row.context, null);
            assert.equal(calls.length, before);
          } finally {
            await erasure.query('ROLLBACK');
            erasure.release();
          }
          await drain();
        },
      );

      await t.test(
        'user erasure synchronously scrubs ready/pending prose before a late receipt and retains only accounting',
        async () => {
          const erasedOwner = await user();
          const sensitiveTag = 'PRIVATE-TAG-' + randomUUID().slice(0, 20);
          const value = await source('Erasure canary', {
            ownerId: erasedOwner,
            synopsis: 'Erasure synopsis',
            extra: { tags: [sensitiveTag] },
          });
          await reconcileAll();
          const retainedIds = (await jobs(value.id)).map((row) => row.id);
          await service().tick(); // A ready cache exists before deletion.
          const started = gate(),
            release = gate(),
            before = calls.length;
          behavior = async () => {
            started.resolve();
            await release.promise;
          };
          const dispatch = service().tick();
          let dispatchedId;
          try {
            await started.promise;
            dispatchedId = calls.at(-1).jobId;
            await pool.query('UPDATE users SET deleted_at=now() WHERE id=$1', [erasedOwner]);
            const scrubbed = await jobs(retainedIds);
            assert.equal(scrubbed.length, retainedIds.length);
            assert.ok(!JSON.stringify(scrubbed).includes(sensitiveTag));
            assert.ok(!JSON.stringify(scrubbed).includes(value.id));
            assert.ok(
              scrubbed.every(
                (row) =>
                  row.field_path === '' &&
                  row.source_id === '' &&
                  row.partition === 'erased' &&
                  row.authority === 'erased',
              ),
            );
            assert.ok(
              scrubbed.every(
                (row) =>
                  row.context === null && row.result === null && row.erasure_user_ids.length === 0,
              ),
            );
            assert.equal(
              await count(
                'SELECT count(*)::int n FROM platform_content_translation_cache WHERE key=ANY($1::text[])',
                [scrubbed.map((row) => row.cache_key)],
              ),
              0,
            );
            assert.equal(
              await count(
                'SELECT count(*)::int n FROM platform_content_translation_bindings WHERE source_id=$1',
                [value.id],
              ),
              0,
            );
            assert.equal((await localize(value, erasedOwner)).value.translations.en, undefined);
            release.resolve();
            await dispatch;
          } finally {
            release.resolve();
            behavior = undefined;
            await dispatch;
          }
          await drain();
          const row = (await jobs(retainedIds)).find((job) => job.id === dispatchedId);
          assert.equal(row.status, 'failed');
          assert.equal(row.context, null);
          assert.equal(row.result, null);
          assert.equal(row.reserve_status, 'settled');
          assert.equal(Number(row.actual_micros), 30);
          assert.equal(row.actor_id, null);
          assert.equal(row.spark_quote_id, null);
          assert.equal(calls.length, before + 1);
          assert.equal(
            await count(
              'SELECT count(*)::int n FROM platform_content_translation_cache WHERE key=ANY($1::text[])',
              [(await jobs(retainedIds)).map((job) => job.cache_key)],
            ),
            0,
          );
          assert.equal(
            await count(
              'SELECT count(*)::int n FROM platform_content_translation_bindings WHERE source_id=$1',
              [value.id],
            ),
            0,
          );
        },
      );

      await t.test(
        'explicit erasure helper removes new caches/bindings synchronously without erasing spend',
        async () => {
          const erasedOwner = await user(),
            sensitiveTag = 'OPERATOR-TAG-' + randomUUID().slice(0, 20),
            value = await source('Operator erasure', {
              ownerId: erasedOwner,
              oneTarget: true,
              extra: { tags: [sensitiveTag] },
            });
          await drain();
          const retainedIds = (await jobs(value.id)).map((row) => row.id);
          const { eraseTranslations } = await import('../../scripts/translation-data-requests.mjs');
          await db.tx((c) => eraseTranslations(c, erasedOwner));
          const retained = await jobs(retainedIds),
            row = retained[0];
          assert.ok(!JSON.stringify(retained).includes(sensitiveTag));
          assert.ok(!JSON.stringify(retained).includes(value.id));
          assert.ok(
            retained.every(
              (job) =>
                job.field_path === '' &&
                job.source_id === '' &&
                job.partition === 'erased' &&
                job.authority === 'erased',
            ),
          );
          assert.equal(row.context, null);
          assert.equal(row.result, null);
          assert.deepEqual(row.erasure_user_ids, []);
          assert.equal(row.reserve_status, 'settled');
          assert.equal(Number(row.actual_micros), 30);
          assert.equal(
            await count(
              'SELECT count(*)::int n FROM platform_content_translation_cache WHERE key=$1',
              [row.cache_key],
            ),
            0,
          );
          assert.equal(
            await count(
              'SELECT count(*)::int n FROM platform_content_translation_bindings WHERE source_id=$1',
              [value.id],
            ),
            0,
          );
          const before = calls.length;
          await edit(value, { unrelatedRevision: 2 });
          await drain();
          assert.equal(calls.length, before, 'erasure cannot erase the paid-attempt barrier');
        },
      );

      await t.test(
        'finite policy commits an affordable first unit even when two simultaneous holds exceed its allowance',
        async () => {
          const value = await source('Finite allowance');
          const existing = await db.tx((c) => aggregateGenerationExposure(c));
          const spent = Number(
            (
              await db.query(
                "SELECT COALESCE(sum(CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END),0) AS n FROM generation_budget_reservations WHERE scope_id='platform:story-metadata'",
              )
            )[0].n,
          );
          const estimate = provider.prepareTextRequest({
            targetLocale: 'uk',
            items: [{ id: '0'.repeat(64), text: value.title, maxLength: 120 }],
          }).snapshot.reserveMicros;
          const textCap = spent + estimate + 30;
          const totalCap = Math.max(1000000, textCap);
          const finite = readGenerationConfig({
            GENERATION_MODE: 'release',
            GENERATION_CONFIG_JSON: JSON.stringify({
              totalCapMicros: totalCap,
              textCapMicros: textCap,
              imageCapMicros: 700000,
              aggregateCapMicros: totalCap + Number(existing.totalMicros),
              text: profile.text,
              image: profile.image,
            }),
          });
          const worker = new PlatformContentTranslations(
            db,
            studioContentTranslationAdapters,
            provider,
            finite,
          );
          const before = calls.length;
          try {
            await db.tx(async (c) => {
              await activateReleaseDeployment(c, finite);
              await c.query(
                "UPDATE generation_budget_scopes SET unlimited_allowance=false,total_cap_micros=$1,text_cap_micros=$2,image_cap_micros=$3 WHERE id='platform:story-metadata'",
                [finite.totalCapMicros, finite.textCapMicros, finite.imageCapMicros],
              );
            });
            assert.deepEqual(await worker.reconcile(), { admitted: 1, remaining: true });
            assert.equal((await jobs(value.id)).length, 1);
            await assert.rejects(() => worker.reconcile(), /GENERATION_BUDGET_EXCEEDED/);
            assert.equal(
              (await jobs(value.id)).length,
              1,
              'later budget refusal cannot roll back the committed affordable unit',
            );
            await worker.tick();
            assert.deepEqual(await worker.reconcile(), { admitted: 1, remaining: false });
            await worker.tick();
            assert.equal(calls.length, before + 2);
            assert.ok(
              (await jobs(value.id)).every(
                (row) => row.status === 'ready' && row.reserve_status === 'settled',
              ),
            );
            assert.equal(await events(), 0);
          } finally {
            await db.tx(async (c) => {
              await activateReleaseDeployment(c, config);
              await c.query(
                "UPDATE generation_budget_scopes SET unlimited_allowance=true,total_cap_micros=NULL,text_cap_micros=NULL,image_cap_micros=NULL WHERE id='platform:story-metadata'",
              );
            });
          }
        },
      );

      await t.test(
        'all settled/held translation exposure is platform-funded with no player wallet entries',
        async () => {
          assert.equal(await count('SELECT count(*)::int n FROM spark_ledger'), 0);
          assert.equal(
            await count(
              'SELECT count(*)::int n FROM platform_content_translation_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE r.actor_id IS NOT NULL OR r.spark_quote_id IS NOT NULL',
            ),
            0,
          );
          const exposure = await db.tx((c) => aggregateGenerationExposure(c));
          const rows = await db.query(
            "SELECT COALESCE(sum(CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END),0)::text AS expected FROM generation_budget_reservations",
          );
          assert.ok(exposure.sharedMicros > 0n);
          assert.equal(exposure.sharedMicros, BigInt(rows[0].expected));
          const scope = (
            await db.query(
              "SELECT unlimited_allowance,total_cap_micros FROM generation_budget_scopes WHERE id='platform:story-metadata'",
            )
          )[0];
          assert.equal(scope.unlimited_allowance, true);
          assert.equal(scope.total_cap_micros, null);
        },
      );
    } finally {
      await pool.end();
      await Promise.all(ends);
      await cluster.stop();
      await rm('.local/' + clusterName, { recursive: true, force: true });
    }
  },
);
