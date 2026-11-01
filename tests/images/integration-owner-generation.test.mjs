/** Owner API adapter → durable image job → private raster/library/map. Fake key and transport only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client } from '../game/support-runtime.mjs';
import { storyInput, authoredDraft } from '../game/support-authored.mjs';
import { fixturePng, failureCode } from './support.mjs';
import { ownerProfile, ownerEnvironment } from './owner-config-fixture.mjs';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const { ImageGenerationEngine } = require('../../apps/api/dist/image-generation/service.js');
const { createOwnerImageRuntime } = require('../../apps/api/dist/image-generation/config.js');
const { VisualAuthoringService } = require('../../apps/api/dist/visual-authoring/service.js');
const { fixtureRaster } = require('../../apps/api/dist/visual-authoring/fixture-art.js');
const { normalizeRaster, storeRasterTx } = require('../../apps/api/dist/assets/raster.js');
const { readOwnerGenerationConfig } = require('../../apps/api/dist/generation/config.js');
const {
  GenerationAuthority,
  GENERATION_SCOPE_ID,
} = require('../../apps/api/dist/generation/service.js');
const rights = {
  basis: 'generated',
  licenseLabel: 'Synthetic transport fixture only',
  attribution: 'Synthetic',
  allowAuthorReuse: false,
  attested: true,
};
await test(
  'owner images require persisted claim and distinct risk consent; retain unknown/overrun liabilities',
  { timeout: 90000 },
  async (t) => {
    let sql;
    try {
      await startApi();
      const owner = await client().register(),
        other = await client().register();
      const story = await owner.request('/studio/adventures', storyInput('private'));
      const otherStory = await other.request('/studio/adventures', storyInput('private'));
      const draft = authoredDraft();
      draft.maps[0].sourceLocationId = 'courtyard';
      const playable = await owner.request(
        `/studio/adventures/${story.id}/playable-draft`,
        { expectedRevision: 0, draft },
        'PUT',
      );
      await stopApi();
      // Every financial fixture lives in one disposable transaction, rolled back only by this test harness.
      // This never supplies a production reconciliation/reset path or touches another test's grant.
      assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^images-test-/);
      sql = await db.connect();
      await sql.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      let savepoint = 0;
      const database = {
        query: async (query, values = []) => (await sql.query(query, values)).rows,
        tx: async (work) => {
          const name = `owner_fixture_${++savepoint}`;
          await sql.query(`SAVEPOINT ${name}`);
          try {
            // Status opens a fresh read-only snapshot in production. This fixture already
            // owns one repeatable-read write transaction, so model that nested read-only
            // scope without issuing an illegal SET TRANSACTION after earlier fixture writes.
            let readOnly = false;
            const nested = {
              query: async (query, values = []) => {
                if (query === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY') {
                  assert.equal(
                    (await sql.query('SHOW transaction_isolation')).rows[0].transaction_isolation,
                    'repeatable read',
                  );
                  readOnly = true;
                  return { rows: [], rowCount: 0 };
                }
                if (readOnly)
                  assert.doesNotMatch(
                    query,
                    /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|CALL)\b/i,
                    'Status scope must remain read-only',
                  );
                return sql.query(query, values);
              },
            };
            const result = await work(nested);
            await sql.query(`RELEASE SAVEPOINT ${name}`);
            return result;
          } catch (error) {
            await sql.query(`ROLLBACK TO SAVEPOINT ${name}`);
            await sql.query(`RELEASE SAVEPOINT ${name}`);
            throw error;
          }
        },
      };
      const assets = new AssetReuseService(database);
      const ownerSettings = ownerProfile();
      ownerSettings.image.maxReferenceImages = 2;
      ownerSettings.image.size = '1024x1024';
      const configured = readOwnerGenerationConfig(ownerEnvironment(ownerSettings, owner.handle));
      const authority = new GenerationAuthority(database, configured);
      let reads = 0,
        calls = 0;
      const smallPng = await fixturePng();
      const png = await sharp(smallPng).resize(1024, 1024).png().toBuffer();
      const runtime = createOwnerImageRuntime(configured, {
        resolveApiKey: () => {
          reads++;
          return 'fake-owner-image-key';
        },
        fetchImpl: async (url, init) => {
          calls++;
          assert.equal(url, 'https://api.openai.com/v1/images/generations');
          const body = JSON.parse(init.body);
          assert.equal(body.model, configured.image.model);
          assert.equal(body.n, 1);
          return new Response(
            JSON.stringify({
              data: [{ b64_json: png.toString('base64') }],
              usage: {
                input_tokens_details: { text_tokens: 100, image_tokens: 0 },
                output_tokens: 100,
              },
            }),
            { headers: { 'x-request-id': `synthetic-owner-${calls}` } },
          );
        },
      });
      const engine = new ImageGenerationEngine(
        database,
        assets,
        runtime.provider,
        runtime.policy,
        runtime.capabilities,
      );
      engine.setLiveAuthorizer((c, user, id) => authority.authorizeImage(c, user, id));
      const selection = { adventureId: story.id, locationId: 'courtyard' };
      const prepared = await engine.prepareStudioLocation(owner.user.id, selection);
      const request = { ...prepared.request, rights, declineReuse: true };
      await t.test(
        'configured adapter cannot claim or dispatch itself, wrong owner and missing risk fail before reservation',
        async () => {
          assert.equal(reads, 0);
          assert.equal(calls, 0);
          await assert.rejects(
            engine.quote(owner.user.id, request),
            failureCode('GENERATION_CONSENT_REQUIRED'),
          );
          await assert.rejects(
            authority.claim(other.user.id, {
              consent: true,
              candidateFingerprint: configured.configFingerprint,
            }),
            failureCode('FORBIDDEN'),
          );
          await authority.claim(owner.user.id, {
            consent: true,
            candidateFingerprint: configured.configFingerprint,
          });
          const quote = await engine.quote(owner.user.id, request);
          assert.equal(quote.quote.generationMode, 'owner');
          assert.equal(quote.quote.estimateRiskConsentRequired, true);
          assert.equal(quote.quote.verifiedUpperMicros, null);
          assert.equal(quote.quote.upperMicros, null);
          assert.equal(quote.quote.providerEnforcesQuotedCap, false);
          const stored = (
            await sql.query('SELECT input FROM image_generation_quotes WHERE id=$1', [
              quote.quote.id,
            ])
          ).rows[0];
          assert.equal(
            stored.input.generationAuthorizationId,
            await authority.authorizationId(owner.user.id),
          );
          const body = { quoteId: quote.quote.id, operationId: randomUUID(), consent: true };
          await assert.rejects(
            engine.enqueue(owner.user.id, body),
            failureCode('IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED'),
          );
          assert.equal(
            (
              await sql.query('SELECT 1 FROM image_generation_jobs WHERE actor_id=$1', [
                owner.user.id,
              ])
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await sql.query('SELECT 1 FROM generation_budget_reservations WHERE scope_id=$1', [
                GENERATION_SCOPE_ID,
              ])
            ).rowCount,
            0,
          );
          const queued = await engine.enqueue(owner.user.id, {
            ...body,
            estimateRiskConsent: true,
          });
          assert.equal(
            (await engine.enqueue(owner.user.id, { ...body, estimateRiskConsent: true })).id,
            queued.id,
          );
          await assert.rejects(
            engine.enqueue(owner.user.id, body),
            failureCode('IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED'),
          );
          const second = await engine.quote(owner.user.id, request);
          await assert.rejects(
            engine.enqueue(owner.user.id, {
              quoteId: second.quote.id,
              operationId: randomUUID(),
              consent: true,
              estimateRiskConsent: true,
            }),
            failureCode('GENERATION_OUTSTANDING_REQUEST'),
          );
          await engine.workOnce();
          const done = await engine.get(owner.user.id, queued.id);
          assert.equal(done.status, 'admitted', done.errorCode);
          assert.equal(calls, 1);
          assert.equal(reads, 1);
          assert.equal(done.actualMicros, 400);
          const library = await assets.revision(owner.user.id, done.revisionId);
          assert.equal(library.metadata.provenance.provider, runtime.provider.id);
          await assert.rejects(assets.revision(other.user.id, done.revisionId));
          assert.equal(
            (await engine.prepareStudioLocation(owner.user.id, selection)).binding,
            null,
          );
          const before = (
            await sql.query('SELECT draft FROM adventure_game_drafts WHERE adventure_id=$1', [
              story.id,
            ])
          ).rows[0].draft;
          const binding = await engine.bindStudioLocation(owner.user.id, {
            ...selection,
            revisionId: done.revisionId,
            operationId: randomUUID(),
            expectedSourceHash: prepared.sourceHash,
            mapId: 'courtyard',
            expectedPlayableRevision: playable.revision,
            expectedArtRevision: prepared.playable.artRevision,
          });
          assert.equal(binding.mapId, 'courtyard');
          assert.deepEqual((await assets.draft(owner.user.id, story.id)).bindings, [
            { slot: 'map:courtyard:background', revisionId: done.revisionId },
          ]);
          assert.deepEqual(
            (
              await sql.query('SELECT draft FROM adventure_game_drafts WHERE adventure_id=$1', [
                story.id,
              ])
            ).rows[0].draft,
            before,
          );
        },
      );
      await t.test(
        'adapter cannot use a different DB configuration or unauthenticated manual policy',
        async () => {
          const otherRuntime = createOwnerImageRuntime(
            readOwnerGenerationConfig(
              ownerEnvironment(
                {
                  ...ownerProfile(),
                  image: { ...ownerProfile().image, model: 'synthetic-other-profile' },
                },
                owner.handle,
              ),
            ),
            {
              resolveApiKey: () => {
                throw new Error('MUST_NOT_RESOLVE');
              },
              fetchImpl: async () => {
                throw new Error('MUST_NOT_CALL');
              },
            },
          );
          const mismatch = new ImageGenerationEngine(
            database,
            assets,
            otherRuntime.provider,
            otherRuntime.policy,
            otherRuntime.capabilities,
          );
          mismatch.setLiveAuthorizer((c, user, id) => authority.authorizeImage(c, user, id));
          await assert.rejects(
            mismatch.quote(owner.user.id, request),
            failureCode('GENERATION_AUTHORIZATION_MISMATCH'),
          );
          await assert.rejects(
            engine.quote(owner.user.id, { ...request, generationAuthorizationId: randomUUID() }),
            failureCode('GENERATION_AUTHORIZATION_FORBIDDEN'),
          );
          assert.equal(calls, 1);
          assert.equal(reads, 1);
        },
      );
      await t.test(
        'other-user mock images never enter or contaminate the owner financial scope',
        async () => {
          const quote = await engine.quote(other.user.id, {
            adventureId: otherStory.id,
            prompt: 'Obvious local fixture',
            title: 'Synthetic mock',
            kind: 'background',
            camera: 'top-down',
            tags: [],
            background: 'opaque',
            referenceRevisionIds: [],
            mode: 'mock',
            declineReuse: true,
            rights,
          });
          const job = await engine.enqueue(other.user.id, {
            quoteId: quote.quote.id,
            operationId: randomUUID(),
            consent: true,
          });
          await engine.workOnce();
          const foreignImage = await engine.get(other.user.id, job.id);
          assert.equal(foreignImage.status, 'admitted');
          const directRequest = { ...request };
          delete directRequest.studioLocationContext;
          await assert.rejects(
            engine.quote(owner.user.id, {
              ...directRequest,
              referenceRevisionIds: [foreignImage.revisionId],
            }),
            failureCode('DERIVATIVE_REFERENCE_FORBIDDEN'),
          );
          const reserved = (
            await sql.query(
              'SELECT r.* FROM generation_budget_reservations r JOIN image_generation_jobs j ON j.reservation_id=r.id WHERE j.id=$1',
              [job.id],
            )
          ).rows[0];
          assert.equal(reserved.scope_id, 'image-fixtures-nonfinancial-v1');
          assert.equal(Number(reserved.upper_micros), 0);
          assert.equal(Number(reserved.actual_micros), 0);
          assert.equal(
            (
              await sql.query(
                'SELECT 1 FROM generation_budget_reservations WHERE scope_id=$1 AND actor_id=$2',
                [GENERATION_SCOPE_ID, other.user.id],
              )
            ).rowCount,
            0,
          );
          await engine.quote(owner.user.id, request);
          assert.equal(calls, 1);
          assert.equal(reads, 1);
        },
      );
      await t.test(
        'private owner photo becomes explicit concept then approved portrait/sheet via bounded multipart, never public photo reuse',
        async () => {
          const photoId = randomUUID();
          await storeRasterTx(
            sql,
            owner.user.id,
            photoId,
            await normalizeRaster(smallPng, 'image/png'),
          );
          const photoRow = (await sql.query('SELECT sha256 FROM assets WHERE id=$1', [photoId]))
            .rows[0];
          let edits = 0;
          const photoRuntime = createOwnerImageRuntime(configured, {
            resolveApiKey: () => 'fake-private-photo-key',
            fetchImpl: async (url, init) => {
              edits++;
              assert.equal(url, 'https://api.openai.com/v1/images/edits');
              assert.ok(init.body instanceof FormData);
              assert.equal(init.body.get('model'), configured.image.model);
              assert.equal(init.body.get('size'), '1024x1024');
              const files = init.body.getAll('image[]');
              assert.equal(files.length, 1);
              assert.ok(!files[0].name.includes(photoId));
              const bytes = Buffer.from(await files[0].arrayBuffer());
              if (edits === 1)
                assert.equal(createHash('sha256').update(bytes).digest('hex'), photoRow.sha256);
              const prompt = String(init.body.get('prompt'));
              const role = prompt.includes('Transparent square sprite atlas')
                ? 'sheet'
                : prompt.includes('head and shoulders portrait')
                  ? 'portrait'
                  : 'concept';
              const raster = await fixtureRaster(role);
              const generated = await sharp(raster.bytes).resize(1024, 1024).png().toBuffer();
              return new Response(
                JSON.stringify({
                  data: [{ b64_json: generated.toString('base64') }],
                  usage: {
                    input_tokens_details: { text_tokens: 100, image_tokens: 200 },
                    output_tokens: 100,
                  },
                }),
                { headers: { 'x-request-id': `req_synthetic_photo_${edits}` } },
              );
            },
          });
          const photoEngine = new ImageGenerationEngine(
            database,
            assets,
            photoRuntime.provider,
            photoRuntime.policy,
            photoRuntime.capabilities,
          );
          photoEngine.setLiveAuthorizer((c, user, id) => authority.authorizeImage(c, user, id));
          const visuals = new VisualAuthoringService(database, assets, photoEngine);
          const brief = {
            name: 'Synthetic astronomer',
            description: 'Synthetic adult astronomer in a blue cloak for transport testing',
            outfit: 'Blue cloak',
            style: 'drawn2D',
            source: 'photo',
            sourcePhotoAssetId: photoId,
            sourcePhotoPermission: true,
            allowOutputReuse: false,
          };
          await assert.rejects(
            visuals.create(other.user.id, {
              kind: 'character',
              operationId: randomUUID(),
              generationMode: 'external',
              brief,
            }),
            failureCode('ASSET_NOT_FOUND'),
          );
          let project = await visuals.create(owner.user.id, {
            kind: 'character',
            operationId: randomUUID(),
            generationMode: 'external',
            brief,
          });
          assert.equal(project.sourcePhotoPrivate, true);
          assert.ok(!JSON.stringify(project).includes(photoId));
          for (const role of ['concept', 'portrait', 'sheet']) {
            const quote = await visuals.quoteGeneration(owner.user.id, project.id, {
              operationId: randomUUID(),
              expectedRevision: project.revision,
              role,
              declineReuse: true,
            });
            if (role === 'concept') {
              const staged = (
                await sql.query(
                  'SELECT request FROM visual_authoring_stage_items WHERE project_id=$1 AND role=$2',
                  [project.id, role],
                )
              ).rows[0].request;
              await assert.rejects(
                photoEngine.quote(owner.user.id, {
                  ...staged,
                  generationAuthorizationId: randomUUID(),
                }),
                failureCode('GENERATION_AUTHORIZATION_FORBIDDEN'),
              );
              await assert.rejects(
                photoEngine.quote(owner.user.id, { ...staged, prompt: 'Tampered author content' }),
                failureCode('MEDIA_CONTEXT_STALE'),
              );
              assert.equal(edits, 0);
            }
            const consent = {
              operationId: randomUUID(),
              expectedRevision: project.revision,
              role,
              quoteId: quote.quote.id,
              consent: true,
              estimateRiskConsent: true,
            };
            const job = await visuals.dispatchGeneration(owner.user.id, project.id, consent);
            assert.equal(
              (await visuals.dispatchGeneration(owner.user.id, project.id, consent)).id,
              job.id,
            );
            await photoEngine.workOnce();
            const done = await photoEngine.get(owner.user.id, job.id);
            assert.equal(done.status, 'admitted', done.errorCode);
            assert.equal(done.actualMicros, 800);
            if (role === 'concept')
              project = await visuals.approve(owner.user.id, project.id, {
                operationId: randomUUID(),
                expectedRevision: project.revision,
                consent: true,
              });
          }
          const stages = await visuals.generation(owner.user.id, project.id);
          assert.equal(stages.readyForReview, true);
          const completed = await visuals.complete(owner.user.id, project.id, {
            operationId: randomUUID(),
            expectedRevision: project.revision,
            consent: true,
            visualReview: true,
          });
          assert.equal(edits, 3);
          assert.ok(!JSON.stringify(completed).includes(photoId));
          assert.equal(
            (await sql.query('SELECT 1 FROM art_asset_revisions WHERE upload_id=$1', [photoId]))
              .rowCount,
            0,
          );
        },
      );
      for (const outcome of [
        'timeout',
        '403',
        'missing-usage',
        'crash-deadline',
        'late-known-before-maintenance',
        'overrun',
        'wrong-dimensions',
        'revoked-before-dispatch',
        'revoked-at-admission',
      ]) {
        await t.test(
          `owner ${outcome} preserves its accounting boundary and never auto-resumes`,
          async () => {
            await sql.query('SAVEPOINT independent_outcome');
            try {
              let keyReads = 0,
                transports = 0;
              const scopedRuntime = createOwnerImageRuntime(configured, {
                resolveApiKey: () => {
                  keyReads++;
                  return 'fake-owner-key';
                },
                fetchImpl: async () => {
                  transports++;
                  if (outcome === 'timeout') throw new Error('Synthetic timeout');
                  if (outcome === '403')
                    return new Response(
                      JSON.stringify({ error: { code: 'model_access_denied' } }),
                      { status: 403, headers: { 'x-request-id': 'req_synthetic_owner' } },
                    );
                  if (outcome === 'revoked-at-admission')
                    await sql.query(
                      "UPDATE live_test_sessions SET state='stopped' WHERE scope_id=$1",
                      [GENERATION_SCOPE_ID],
                    );
                  return new Response(
                    JSON.stringify({
                      data: [
                        {
                          b64_json: (outcome === 'wrong-dimensions' ? smallPng : png).toString(
                            'base64',
                          ),
                        },
                      ],
                      ...(outcome === 'missing-usage'
                        ? {}
                        : {
                            usage: {
                              input_tokens_details: { text_tokens: 100, image_tokens: 0 },
                              output_tokens: outcome === 'overrun' ? 40000 : 100,
                            },
                          }),
                    }),
                    { headers: { 'x-request-id': 'req_synthetic_owner' } },
                  );
                },
              });
              const scoped = new ImageGenerationEngine(
                database,
                assets,
                scopedRuntime.provider,
                scopedRuntime.policy,
                scopedRuntime.capabilities,
              );
              scoped.setLiveAuthorizer((c, user, id) => authority.authorizeImage(c, user, id));
              const quote = await scoped.quote(owner.user.id, request);
              const queued = await scoped.enqueue(owner.user.id, {
                quoteId: quote.quote.id,
                operationId: randomUUID(),
                consent: true,
                estimateRiskConsent: true,
              });
              if (outcome === 'revoked-before-dispatch')
                await sql.query("UPDATE live_test_sessions SET state='stopped' WHERE scope_id=$1", [
                  GENERATION_SCOPE_ID,
                ]);
              if (['crash-deadline', 'late-known-before-maintenance'].includes(outcome)) {
                await sql.query(
                  'INSERT INTO image_generation_attempts(job_id,dispatch_id,provider,request_hash) SELECT id,$2,$3,request_hash FROM image_generation_jobs WHERE id=$1',
                  [queued.id, randomUUID(), scopedRuntime.provider.id],
                );
                await sql.query(
                  "UPDATE image_generation_jobs SET status='dispatched',dispatch_deadline=now()-interval '1 second' WHERE id=$1",
                  [queued.id],
                );
              }
              if (outcome === 'late-known-before-maintenance')
                await scoped.recordResult(queued.id, {
                  bytes: png,
                  mime: 'image/png',
                  actualMicros: 10,
                  requestId: 'req_synthetic_owner',
                });
              await scoped.workOnce();
              await scoped.workOnce();
              const row = (
                await sql.query('SELECT * FROM image_generation_jobs WHERE id=$1', [queued.id])
              ).rows[0];
              const held = (
                await sql.query('SELECT * FROM generation_budget_reservations WHERE id=$1', [
                  row.reservation_id,
                ])
              ).rows[0];
              const scope = (
                await sql.query('SELECT * FROM generation_budget_scopes WHERE id=$1', [
                  GENERATION_SCOPE_ID,
                ])
              ).rows[0];
              if (outcome.startsWith('revoked-')) {
                assert.equal(row.status, 'rejected');
                assert.equal(
                  held.status,
                  outcome === 'revoked-before-dispatch' ? 'released' : 'settled',
                );
                assert.equal(transports, outcome === 'revoked-before-dispatch' ? 0 : 1);
              } else if (outcome === 'late-known-before-maintenance') {
                assert.equal(row.status, 'rejected');
                assert.equal(held.status, 'settled');
                assert.equal(Number(held.actual_micros), 10);
                assert.equal(scope.blocked, true);
                assert.equal(
                  (
                    await sql.query('SELECT state FROM live_test_sessions WHERE scope_id=$1', [
                      GENERATION_SCOPE_ID,
                    ])
                  ).rows[0].state,
                  'stopped',
                );
                await assert.rejects(scoped.quote(owner.user.id, request));
                await assert.rejects(
                  authority.claim(owner.user.id, {
                    consent: true,
                    candidateFingerprint: configured.configFingerprint,
                  }),
                );
              } else if (outcome === 'wrong-dimensions') {
                assert.equal(row.status, 'rejected');
                assert.equal(row.error_code, 'IMAGE_PROFILE_DIMENSIONS_MISMATCH');
                assert.equal(held.status, 'settled');
                assert.equal(Number(held.actual_micros), 400);
                assert.equal(scope.blocked, false);
              } else if (outcome === 'overrun') {
                assert.equal(row.status, 'rejected');
                assert.equal(held.status, 'settled');
                assert.equal(Number(held.actual_micros), 120100);
                assert.equal(scope.blocked, true);
                await assert.rejects(scoped.quote(owner.user.id, request));
              } else {
                assert.equal(row.status, 'unknown');
                assert.equal(held.status, 'held');
                assert.equal(held.actual_micros, null);
                assert.equal(scope.blocked, true);
                const session = (
                  await sql.query(
                    'SELECT state,stop_code FROM live_test_sessions WHERE scope_id=$1',
                    [GENERATION_SCOPE_ID],
                  )
                ).rows[0];
                assert.equal(session.state, 'stopped');
                assert.equal(session.stop_code, 'IMAGE_RESULT_UNKNOWN');
                await assert.rejects(scoped.quote(owner.user.id, request));
                await scoped.recordResult(queued.id, {
                  bytes: png,
                  mime: 'image/png',
                  actualMicros: 10,
                  requestId: 'req_synthetic_owner',
                });
                assert.equal(
                  (
                    await sql.query('SELECT blocked FROM generation_budget_scopes WHERE id=$1', [
                      GENERATION_SCOPE_ID,
                    ])
                  ).rows[0].blocked,
                  true,
                );
                assert.equal(
                  (
                    await sql.query(
                      'SELECT status FROM generation_budget_reservations WHERE id=$1',
                      [row.reservation_id],
                    )
                  ).rows[0].status,
                  'settled',
                );
                await assert.rejects(scoped.quote(owner.user.id, request));
                await assert.rejects(
                  new GenerationAuthority(database, configured).claim(owner.user.id, {
                    consent: true,
                    candidateFingerprint: configured.configFingerprint,
                  }),
                );
                await scoped.workOnce();
                assert.equal((await scoped.get(owner.user.id, queued.id)).status, 'rejected');
              }
              assert.equal(keyReads, transports);
              assert.equal(
                transports,
                [
                  'crash-deadline',
                  'late-known-before-maintenance',
                  'revoked-before-dispatch',
                ].includes(outcome)
                  ? 0
                  : 1,
              );
            } finally {
              await sql.query('ROLLBACK TO SAVEPOINT independent_outcome');
              await sql.query('RELEASE SAVEPOINT independent_outcome');
            }
          },
        );
      }
    } finally {
      await stopApi();
      if (sql) {
        await sql.query('ROLLBACK');
        sql.release();
      }
      await db.end();
    }
  },
);
