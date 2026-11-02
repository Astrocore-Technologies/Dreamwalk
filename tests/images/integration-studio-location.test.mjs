/** One focused Studio location image path. Synthetic image bytes, no real provider/key/preview. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client } from '../game/support-runtime.mjs';
import { storyInput, authoredDraft } from '../game/support-authored.mjs';
import { fixturePng, uploadFixture } from './support.mjs';
const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const { ImageGenerationEngine } = require('../../apps/api/dist/image-generation/service.js');
const { defaultImagePolicy } = require('../../apps/api/dist/image-generation/contracts.js');
const database = new Db();
const rights = {
  basis: 'generated',
  licenseLabel: 'Synthetic owned test only',
  attribution: 'Synthetic',
  allowAuthorReuse: false,
  attested: true,
};
await test(
  'Studio description → immutable library → location image → explicit existing map binding',
  { timeout: 90000 },
  async (t) => {
    try {
      await startApi();
      // The injected historical external adapter below intentionally has no priced
      // Sparks profile; model a pre-Sparks account, never disable a new starter wallet.
      const owner = await client().registerLegacyFixture(),
        other = await client().register();
      const input = storyInput();
      input.content.locations[0].name = 'Large house';
      input.content.locations[0].description =
        'A large drawn house with six rooms and warm wooden floors.';
      const story = await owner.request('/studio/adventures', input);
      const selection = { adventureId: story.id, locationId: 'courtyard' };
      let prepared = await owner.request('/image-generation/studio-locations/prepare', selection);
      await t.test(
        'saved source preparation needs no map, rejects outsiders and cannot bypass current real-image gate',
        async () => {
          assert.equal(prepared.request.mode, 'external');
          assert.equal(prepared.request.title, 'Large house');
          assert.match(prepared.request.prompt, /six rooms/);
          assert.equal(prepared.playable.revision, 0);
          assert.equal(prepared.binding, null);
          assert.deepEqual(prepared.playable.maps, []);
          await other.request('/image-generation/studio-locations/prepare', selection, 'POST', 404);
          await owner.request(
            '/image-generation/quotes',
            { ...prepared.request, rights, declineReuse: true },
            'POST',
            409,
          );
          assert.equal(
            Number(
              (
                await db.query(
                  'SELECT count(*) n FROM image_generation_attempts a JOIN image_generation_jobs j ON j.id=a.job_id WHERE j.actor_id=$1 AND j.adventure_id=$2',
                  [owner.user.id, story.id],
                )
              ).rows[0].n,
            ),
            0,
          );
        },
      );
      await stopApi();
      let calls = 0;
      const engine = new ImageGenerationEngine(
        database,
        new AssetReuseService(database),
        {
          id: 'synthetic-studio-location-NOT-OPENAI',
          generate: async (request) => {
            calls++;
            assert.match(request.prompt, /six rooms/);
            return {
              bytes: await fixturePng(),
              mime: 'image/png',
              actualMicros: 10,
              requestId: 'synthetic-location-receipt',
            };
          },
        },
        {
          ...defaultImagePolicy,
          scopeId: randomUUID(),
          externalEnabled: true,
          approved: true,
          verifiedUpperMicros: 10000,
        },
      );
      const q = await engine.quote(owner.user.id, {
        ...prepared.request,
        rights,
        declineReuse: true,
      });
      const queued = await engine.enqueue(owner.user.id, {
        quoteId: q.quote.id,
        operationId: randomUUID(),
        consent: true,
      });
      await engine.workOnce();
      const done = await engine.get(owner.user.id, queued.id);
      assert.equal(done.status, 'admitted');
      assert.equal(calls, 1);
      assert.equal(done.studioLocationId, 'courtyard');
      assert.equal(done.studioSourceHash, prepared.sourceHash);
      await startApi();
      const revision = await owner.request(`/asset-library/revisions/${done.revisionId}`);
      assert.equal(revision.metadata.provenance.provider, 'synthetic-studio-location-NOT-OPENAI');
      let bindingBody = {
        ...selection,
        revisionId: done.revisionId,
        operationId: randomUUID(),
        expectedSourceHash: prepared.sourceHash,
      };
      await t.test(
        'image persists before geometry with idempotent owner-only binding',
        async () => {
          const saved = await owner.request('/image-generation/studio-locations/bind', bindingBody);
          assert.deepEqual(
            await owner.request('/image-generation/studio-locations/bind', bindingBody),
            saved,
          );
          const state = await owner.request(
            '/image-generation/studio-locations/prepare',
            selection,
          );
          assert.equal(state.binding.revisionId, done.revisionId);
          assert.equal(state.binding.stale, false);
          assert.equal(
            Number(
              (
                await db.query(
                  'SELECT count(*) n FROM adventure_game_drafts WHERE adventure_id=$1',
                  [story.id],
                )
              ).rows[0].n,
            ),
            0,
          );
          await other.request(
            '/image-generation/studio-locations/bind',
            { ...bindingBody, operationId: randomUUID() },
            'POST',
            404,
          );
        },
      );
      await t.test(
        'changed author description invalidates prepared generation and binding, while library image remains immutable',
        async () => {
          await db.query(
            "UPDATE adventures SET edit_revision=edit_revision+1,data=jsonb_set(data,'{content,locations,0,description}',to_jsonb($2::text)) WHERE id=$1",
            [story.id, 'The same house after a confirmed source edit.'],
          );
          await owner.request(
            '/image-generation/studio-locations/bind',
            { ...bindingBody, operationId: randomUUID() },
            'POST',
            409,
          );
          await assert.rejects(
            () => engine.quote(owner.user.id, { ...prepared.request, rights, declineReuse: true }),
            (e) => e?.getResponse?.().code === 'MEDIA_CONTEXT_STALE',
          );
          const state = await owner.request(
            '/image-generation/studio-locations/prepare',
            selection,
          );
          assert.equal(state.binding.stale, true);
          prepared = state;
        },
      );
      await t.test(
        'explicit map binding validates sourceLocationId/revisions and leaves geometry untouched',
        async () => {
          const draft = authoredDraft();
          draft.maps[0].sourceLocationId = 'courtyard';
          const game = await owner.request(
            `/studio/adventures/${story.id}/playable-draft`,
            { expectedRevision: 0, draft },
            'PUT',
          );
          const before = (
            await db.query('SELECT draft FROM adventure_game_drafts WHERE adventure_id=$1', [
              story.id,
            ])
          ).rows[0].draft;
          prepared = await owner.request('/image-generation/studio-locations/prepare', selection);
          bindingBody = {
            ...selection,
            revisionId: done.revisionId,
            operationId: randomUUID(),
            expectedSourceHash: prepared.sourceHash,
            mapId: 'garden',
            expectedPlayableRevision: game.revision,
            expectedArtRevision: prepared.playable.artRevision,
          };
          await owner.request('/image-generation/studio-locations/bind', bindingBody, 'POST', 400);
          const bound = await owner.request('/image-generation/studio-locations/bind', {
            ...bindingBody,
            operationId: randomUUID(),
            mapId: 'courtyard',
          });
          assert.equal(bound.mapId, 'courtyard');
          const art = await owner.request(`/asset-library/stories/${story.id}/draft`);
          assert.deepEqual(art.bindings, [
            { slot: 'map:courtyard:background', revisionId: done.revisionId },
          ]);
          assert.deepEqual(
            (
              await db.query('SELECT draft FROM adventure_game_drafts WHERE adventure_id=$1', [
                story.id,
              ])
            ).rows[0].draft,
            before,
          );
          const foreign = await uploadFixture(other);
          await owner.request(
            '/image-generation/studio-locations/bind',
            {
              ...selection,
              revisionId: foreign.id,
              operationId: randomUUID(),
              expectedSourceHash: prepared.sourceHash,
            },
            'POST',
            404,
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
