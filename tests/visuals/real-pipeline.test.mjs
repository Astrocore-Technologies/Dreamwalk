/** Real authoring stages and durable admission with an injected synthetic transport, NEVER OpenAI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { db, startApi, stopApi, client } from '../game/support-runtime.mjs';
import { createStory, fixturePng } from '../images/support.mjs';
const require = createRequire(import.meta.url);
require('reflect-metadata');
const sharp = require('sharp');
const { Db } = require('../../apps/api/dist/db.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const { ImageGenerationEngine } = require('../../apps/api/dist/image-generation/service.js');
const { defaultImagePolicy } = require('../../apps/api/dist/image-generation/contracts.js');
const { VisualAuthoringService } = require('../../apps/api/dist/visual-authoring/service.js');
const {
  exportVisualAuthoring,
  eraseVisualAuthoring,
} = require('../../apps/api/dist/visual-authoring/data-requests.js');
const { fixtureRaster } = require('../../apps/api/dist/visual-authoring/fixture-art.js');
const {
  checkArtRaster,
  normalizeArtAtlas,
} = require('../../apps/api/dist/visual-authoring/real-art.js');
const failure = (code) => (e) => e?.getResponse?.().code === code;
const op = () => randomUUID();
const brief = {
  name: 'Mira',
  description: 'Adult astronomer in a blue cloak, golden clasp, auburn braided hair',
  outfit: 'Blue cloak, leather boots, golden clasp',
  appearance: 'Auburn braid',
  style: 'drawn2D',
  source: 'text',
  allowOutputReuse: false,
};
const mutation = (p) => ({ operationId: op(), expectedRevision: p.revision });
const makeProject = (visuals, owner, extra = {}) =>
  visuals.create(owner, {
    kind: 'character',
    operationId: op(),
    brief,
    generationMode: 'external',
    ...extra,
  });
await test(
  'manual real authoring pipeline, synthetic transport only',
  { timeout: 180000 },
  async (t) => {
    const database = new Db(),
      assets = new AssetReuseService(database);
    let calls = 0,
      behavior = 'normal',
      packForReuse;
    const seen = [];
    const provider = {
      id: 'synthetic-authoring-transport',
      async generate(input, dispatchId, refs) {
        calls++;
        seen.push({ input, refs });
        if (behavior === 'uncertain') throw new Error('SYNTHETIC_UNCERTAIN');
        const role = input.authoringContext.role;
        const raster =
          behavior === 'bad-sheet' && role === 'sheet'
            ? await fixtureRaster('concept')
            : await fixtureRaster(role === 'sample-sheet' ? 'sheet' : role);
        return {
          bytes: raster.bytes,
          mime: 'image/webp',
          actualMicros: 10,
          requestId: `synthetic:${dispatchId}`,
        };
      },
    };
    const engine = new ImageGenerationEngine(database, assets, provider, {
      ...defaultImagePolicy,
      scopeId: op(),
      version: 'synthetic-authoring-policy',
      externalEnabled: true,
      approved: true,
      verifiedUpperMicros: 10,
      totalCapMicros: 10000,
      imageCapMicros: 10000,
      textCapMicros: 0,
    });
    let visuals = new VisualAuthoringService(database, assets, engine);
    try {
      await startApi();
      const people = [];
      // Historical synthetic adapters have no priced model snapshot; exercise their legacy path.
      // Funded-account pricing rejection is covered by the image integration suite.
      for (let i = 0; i < 5; i++) people.push(await client().registerLegacyFixture());
      const story = await createStory(people[2]),
        otherStory = await createStory(people[4]);
      const form = new FormData();
      form.append(
        'file',
        new Blob([await fixturePng(true)], { type: 'image/png' }),
        'private-reference.png',
      );
      const upload = await fetch(process.env.TEST_GAME_API_URL + '/assets', {
        method: 'POST',
        headers: { cookie: people[1].cookie, origin: process.env.WEB_ORIGIN },
        body: form,
      });
      assert.equal(upload.status, 201);
      const photo = (await upload.json()).id;
      // Stop ONLY this disposable test API, so no automatic fixture worker races injected work.
      await stopApi();
      const owners = people.map((p) => p.user.id);
      const generate = async (owner, p, role) => {
        const qBody = { ...mutation(p), role, declineReuse: true };
        const quote = await visuals.quoteGeneration(owner, p.id, qBody);
        assert.equal(quote.decision, 'quote');
        assert.equal((await visuals.quoteGeneration(owner, p.id, qBody)).quote.id, quote.quote.id);
        const body = { ...mutation(p), role, quoteId: quote.quote.id, consent: true };
        const job = await visuals.dispatchGeneration(owner, p.id, body);
        assert.equal((await visuals.dispatchGeneration(owner, p.id, body)).id, job.id);
        await engine.workOnce();
        return { job: await engine.get(owner, job.id), body, quote };
      };
      await t.test(
        'no fake concept, manual requests, human approval, durable full walking pack',
        async () => {
          const owner = owners[0];
          let p = await makeProject(visuals, owner);
          assert.equal(p.provider, 'external');
          assert.equal(p.conceptRevisionId, null);
          assert.equal(calls, 0);
          await assert.rejects(
            visuals.approve(owner, p.id, { ...mutation(p), consent: true }),
            failure('GENERATION_INCOMPLETE'),
          );
          await assert.rejects(visuals.generation(owners[4], p.id), failure('NOT_FOUND'));
          const concept = await generate(owner, p, 'concept');
          assert.equal(concept.job.status, 'admitted');
          assert.equal(calls, 1);
          let stages = await visuals.generation(owner, p.id);
          assert.equal(stages.items[0].validation.valid, true);
          assert.equal(stages.readyForReview, true);
          assert.ok(stages.items[0].url);
          assert.equal(stages.items[0].job.actualMicros, 10);
          await assert.rejects(
            visuals.dispatchGeneration(owner, p.id, {
              ...mutation(p),
              role: 'concept',
              quoteId: concept.quote.quote.id,
              consent: false,
            }),
          );
          p = await visuals.approve(owner, p.id, { ...mutation(p), consent: true });
          assert.equal(p.status, 'approved');
          assert.ok(p.conceptRevisionId);
          assert.equal(calls, 1);
          await assert.rejects(
            visuals.complete(owner, p.id, { ...mutation(p), consent: true, visualReview: true }),
            failure('GENERATION_INCOMPLETE'),
          );
          await generate(owner, p, 'portrait');
          assert.equal(calls, 2);
          await assert.rejects(
            visuals.complete(owner, p.id, { ...mutation(p), consent: true, visualReview: true }),
            failure('GENERATION_INCOMPLETE'),
          );
          await generate(owner, p, 'sheet');
          assert.equal(calls, 3);
          // Reconstruct the service as after reconnect: all stages and quotes are in PostgreSQL.
          visuals = new VisualAuthoringService(database, assets, engine);
          stages = await visuals.generation(owner, p.id);
          assert.equal(stages.readyForReview, true);
          assert.equal(stages.items.length, 3);
          await assert.rejects(
            visuals.complete(owner, p.id, { ...mutation(p), consent: true }),
            failure('VISUAL_REVIEW_REQUIRED'),
          );
          const complete = { ...mutation(p), consent: true, visualReview: true };
          const pack = await visuals.complete(owner, p.id, complete);
          packForReuse = pack;
          assert.equal(pack.provider, 'external');
          assert.equal(pack.providerCalls, 3);
          assert.equal(pack.chargeMicros, 30);
          assert.equal(pack.visualReview.consistency, 'human-reviewed');
          assert.equal(pack.parts.find((x) => x.role === 'sheet').width, 768);
          assert.equal(pack.parts.find((x) => x.role === 'sheet').height, 768);
          assert.equal(pack.sourceJobIds.length, 3);
          assert.equal((await visuals.complete(owner, p.id, complete)).id, pack.id);
          assert.equal(calls, 3);
          const equipped = await visuals.equip(owner, pack.id, {
            operationId: op(),
            targetType: 'hero',
            createTarget: true,
          });
          assert.equal(equipped.equipped, true);
          const result = await db.query('SELECT data FROM heroes WHERE id=$1', [equipped.targetId]);
          assert.equal(result.rows[0].data.characterPackageVersionId, pack.id);
          await assert.rejects(
            visuals.equip(owners[4], pack.id, {
              operationId: op(),
              targetType: 'hero',
              createTarget: true,
            }),
            failure('ASSET_NOT_FOUND'),
          );
          const portraitRef = seen.find(
            (s) =>
              s.input.authoringContext.projectId === p.id &&
              s.input.authoringContext.role === 'portrait',
          );
          assert.equal(portraitRef.refs[0].revisionId, p.conceptRevisionId);
          assert.equal((await visuals.get(owner, p.id)).generationReady, true);
        },
      );
      await t.test(
        'photo stays private, unknown charge persists, cancel never regenerates',
        async () => {
          const owner = owners[1];
          const p = await makeProject(visuals, owner, {
            brief: {
              ...brief,
              source: 'photo',
              sourcePhotoAssetId: photo,
              sourcePhotoPermission: true,
            },
          });
          assert.equal(p.sourcePhotoPrivate, true);
          assert.equal(JSON.stringify(p).includes(photo), false);
          behavior = 'uncertain';
          const previous = calls;
          const { job } = await generate(owner, p, 'concept');
          behavior = 'normal';
          assert.equal(job.status, 'unknown');
          assert.equal(job.heldMicros, 10);
          assert.equal(calls, previous + 1);
          const request = seen.at(-1);
          assert.deepEqual(request.input.privateReferenceAssetIds, [photo]);
          assert.equal(request.refs.length, 1);
          assert.equal(
            (
              await db.query('SELECT count(*)::int n FROM art_asset_revisions WHERE upload_id=$1', [
                photo,
              ])
            ).rows[0].n,
            0,
          );
          await engine.workOnce();
          assert.equal(calls, previous + 1);
          await assert.rejects(
            visuals.quoteGeneration(owner, p.id, {
              ...mutation(p),
              role: 'concept',
              declineReuse: true,
            }),
            failure('GENERATION_ALREADY_STARTED'),
          );
          const cancelled = await visuals.cancel(owner, p.id, mutation(p));
          assert.equal(cancelled.billingMayRemainHeld, true);
          assert.equal((await engine.get(owner, job.id)).heldMicros, 10);
          await assert.rejects(
            visuals.approve(owner, p.id, { ...mutation(p), consent: true }),
            failure('STALE_STATE'),
          );
          await assert.rejects(
            makeProject(visuals, owners[4], {
              brief: {
                ...brief,
                source: 'photo',
                sourcePhotoAssetId: photo,
                sourcePhotoPermission: true,
              },
            }),
            failure('ASSET_NOT_FOUND'),
          );
        },
      );
      await t.test(
        'spatial art requests are public-only; stale canon cannot dispatch',
        async () => {
          const owner = owners[2];
          await db.query(`UPDATE adventures SET data=data||$2::jsonb WHERE id=$1`, [
            story.id,
            JSON.stringify({
              npcSecrets: 'NEVER_RENDER_SECRET',
              privateInstructions: 'NEVER_RENDER_PRIVATE',
            }),
          ]);
          let p = await visuals.create(owner, {
            kind: 'location',
            spatialMode: 'manual',
            adventureId: story.id,
            operationId: op(),
            brief: {
              name: 'Observatory hall',
              description:
                'A quiet astronomical workshop with room to walk and a reachable doorway',
              style: 'drawn2D',
            },
            generationMode: 'external',
          });
          assert.equal(p.planProvenance, 'manual');
          p = await visuals.approve(owner, p.id, { ...mutation(p), consent: true });
          const q = await visuals.quoteGeneration(owner, p.id, {
            ...mutation(p),
            role: 'background',
            declineReuse: true,
          });
          const request = (
            await db.query('SELECT input FROM image_generation_quotes WHERE id=$1', [q.quote.id])
          ).rows[0].input;
          assert.equal(JSON.stringify(request).includes('NEVER_RENDER'), false);
          assert.match(request.prompt, /Locked spatial plan/);
          const job = await visuals.dispatchGeneration(owner, p.id, {
            ...mutation(p),
            role: 'background',
            quoteId: q.quote.id,
            consent: true,
          });
          await db.query("UPDATE adventures SET title=title||' revised' WHERE id=$1", [story.id]);
          const previous = calls;
          await engine.workOnce();
          assert.equal(calls, previous);
          assert.equal((await engine.get(owner, job.id)).status, 'rejected');
          assert.equal((await engine.get(owner, job.id)).heldMicros, 0);
          await assert.rejects(
            visuals.complete(owner, p.id, { ...mutation(p), consent: true, visualReview: true }),
            failure('STALE_STATE'),
          );
        },
      );
      await t.test(
        'portrait and invalid atlas never pass walking validation or silently retry',
        async () => {
          const owner = owners[3];
          let p = await makeProject(visuals, owner);
          await generate(owner, p, 'concept');
          p = await visuals.approve(owner, p.id, { ...mutation(p), consent: true });
          await generate(owner, p, 'portrait');
          behavior = 'bad-sheet';
          await generate(owner, p, 'sheet');
          behavior = 'normal';
          const stage = await visuals.generation(owner, p.id);
          assert.equal(stage.readyForReview, false);
          assert.equal(stage.items.find((i) => i.role === 'sheet').validation.valid, false);
          await assert.rejects(
            visuals.complete(owner, p.id, { ...mutation(p), consent: true, visualReview: true }),
            failure('ART_VALIDATION_FAILED'),
          );
          const previous = calls;
          await engine.workOnce();
          assert.equal(calls, previous);
          await assert.rejects(
            visuals.quoteGeneration(owner, p.id, {
              ...mutation(p),
              role: 'sheet',
              declineReuse: true,
            }),
            failure('GENERATION_ALREADY_STARTED'),
          );
        },
      );
      await t.test(
        'layered location completes only after all individually consented parts; no art changes geometry',
        async () => {
          const owner = owners[4];
          let p = await visuals.create(owner, {
            kind: 'location',
            spatialMode: 'manual',
            adventureId: otherStory.id,
            operationId: op(),
            brief: {
              name: 'Rain atelier',
              description:
                'A hand drawn atelier with a reachable doorway and separately layered furniture',
              style: 'drawn2D',
            },
            generationMode: 'external',
          });
          const originalPlan = structuredClone(p.plan);
          p = await visuals.approve(owner, p.id, { ...mutation(p), consent: true });
          const roles = (await visuals.generation(owner, p.id)).requiredRoles;
          assert.equal(roles.length, 11);
          const before = calls;
          for (const role of roles) await generate(owner, p, role);
          assert.equal(calls, before + 11);
          const pack = await visuals.complete(owner, p.id, {
            ...mutation(p),
            consent: true,
            visualReview: true,
          });
          assert.equal(pack.parts.length, 11);
          assert.equal(pack.providerCalls, 11);
          assert.equal(pack.chargeMicros, 110);
          const state = await visuals.get(owner, p.id);
          assert.deepEqual(state.plan, originalPlan);
          assert.ok(state.projection.artBindings.length > 5);
          await engine.workOnce();
          assert.equal(calls, before + 11);
        },
      );
      await t.test(
        'owned immutable library reuse costs nothing and requires human semantic review',
        async () => {
          const owner = owners[0];
          let p = await makeProject(visuals, owner);
          const before = calls;
          await assert.rejects(
            visuals.reuseGeneration(owner, p.id, {
              ...mutation(p),
              role: 'concept',
              revisionId: packForReuse.parts[0].revisionId,
              semanticReview: false,
            }),
          );
          const reuse = async (role) =>
            visuals.reuseGeneration(owner, p.id, {
              ...mutation(p),
              role,
              revisionId: packForReuse.parts.find((part) => part.role === role).revisionId,
              semanticReview: true,
            });
          await reuse('concept');
          p = await visuals.approve(owner, p.id, { ...mutation(p), consent: true });
          await reuse('portrait');
          await reuse('sheet');
          const pack = await visuals.complete(owner, p.id, {
            ...mutation(p),
            consent: true,
            visualReview: true,
          });
          assert.equal(pack.providerCalls, 0);
          assert.equal(pack.chargeMicros, 0);
          assert.equal(calls, before);
          assert.equal(
            pack.parts.find((x) => x.role === 'portrait').revisionId,
            packForReuse.parts.find((x) => x.role === 'portrait').revisionId,
          );
        },
      );
      await t.test(
        'lost enqueue response resumes the same durable receipt without a second charge',
        async () => {
          const owner = owners[3],
            p = await makeProject(visuals, owner);
          const quote = await visuals.quoteGeneration(owner, p.id, {
            ...mutation(p),
            role: 'concept',
            declineReuse: true,
          });
          const body = { ...mutation(p), role: 'concept', quoteId: quote.quote.id, consent: true };
          const original = engine.enqueue.bind(engine);
          let queuedId;
          engine.enqueue = async (actor, input) => {
            const job = await original(actor, input);
            queuedId = job.id;
            throw new Error('SYNTHETIC_RESPONSE_LOST');
          };
          try {
            await assert.rejects(
              visuals.dispatchGeneration(owner, p.id, body),
              /SYNTHETIC_RESPONSE_LOST/,
            );
          } finally {
            engine.enqueue = original;
          }
          const stage = await visuals.generation(owner, p.id);
          assert.equal(stage.items[0].status, 'dispatch-prepared');
          assert.equal(stage.items[0].dispatchOperationId, body.operationId);
          await assert.rejects(
            visuals.quoteGeneration(owner, p.id, {
              ...mutation(p),
              role: 'concept',
              declineReuse: true,
            }),
            failure('GENERATION_ALREADY_STARTED'),
          );
          const before = calls,
            resumed = await visuals.dispatchGeneration(owner, p.id, body);
          assert.equal(resumed.id, queuedId);
          assert.equal(calls, before);
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM image_generation_jobs WHERE actor_id=$1 AND operation_id=$2',
                [owner, body.operationId],
              )
            ).rows[0].n,
            1,
          );
          await engine.workOnce();
          assert.equal(calls, before + 1);
          assert.equal((await engine.get(owner, queuedId)).actualMicros, 10);
        },
      );
      await t.test(
        'private stage requests are owner-exported and erased before their project',
        async () => {
          const owner = owners[1];
          const exported = await database.tx((c) => exportVisualAuthoring(c, owner));
          assert.equal(exported.generationStages.length, 1);
          assert.ok(JSON.stringify(exported).includes(photo));
          await assert.rejects(
            database.tx((c) => eraseVisualAuthoring(c, owner)),
            /CONFIRMED_ERASURE_REQUIRED/,
          );
          await database.tx(async (c) => {
            await c.query("SELECT set_config('dreamwalk.erasure','confirmed',true)");
            await c.query('UPDATE users SET deleted_at=now() WHERE id=$1', [owner]);
            await eraseVisualAuthoring(c, owner);
          });
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM visual_authoring_projects WHERE owner_id=$1',
                [owner],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        'native square atlas normalization validates each directional frame without inventing art',
        async () => {
          const good = (await fixtureRaster('sheet')).bytes;
          assert.equal((await checkArtRaster(good, 'sheet')).nonemptyFrames, 24);
          const native = await sharp(good).resize(1024, 1024).png().toBuffer();
          assert.equal((await checkArtRaster(native, 'sheet')).nonemptyFrames, 24);
          const normalized = await normalizeArtAtlas(native);
          assert.equal(normalized.width, 768);
          assert.equal(normalized.height, 768);
          assert.equal((await checkArtRaster(normalized.bytes, 'sheet')).valid, true);
          const missingFrame = await sharp(good)
            .composite([
              {
                input: Buffer.alloc(128 * 192 * 4, 255),
                raw: { width: 128, height: 192, channels: 4 },
                left: 0,
                top: 0,
                blend: 'dest-out',
              },
            ])
            .png()
            .toBuffer();
          assert.equal((await checkArtRaster(missingFrame, 'sheet')).valid, false);
          const empty = await fixturePng(true);
          assert.equal((await checkArtRaster(empty, 'sheet')).valid, false);
          assert.equal(
            (await checkArtRaster((await fixtureRaster('portrait')).bytes, 'sheet')).valid,
            false,
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
