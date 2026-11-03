/** Private story covers use the existing image jobs, admission and media ACLs. Mock only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client, until } from '../game/support-runtime.mjs';
import { storyInput } from '../game/support-authored.mjs';
const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const { ImageGenerationEngine } = require('../../apps/api/dist/image-generation/service.js');
const database = new Db();
const code = (expected) => (error) => error?.getResponse?.().code === expected;

test(
  'private story covers are explicit, recoverable and saved through the existing story ACL',
  { timeout: 120000 },
  async (t) => {
    try {
      await startApi();
      const owner = await client().register(),
        other = await client().register();
      const draftId = randomUUID();
      const input = {
        storyCoverContext: { draftId },
        prompt: 'PRIVATE_STORY_COVER_DESCRIPTION',
        title: 'Story cover',
        kind: 'background',
        camera: 'unrestricted',
        tags: ['story-cover'],
        background: 'opaque',
        mode: 'mock',
        declineReuse: true,
        rights: {
          basis: 'generated',
          licenseLabel: 'Private generated cover',
          attribution: '',
          allowAuthorReuse: false,
          attested: true,
        },
      };
      await t.test('strict context, authenticated quote and explicit confirmation', async () => {
        await client().request('/image-generation/story-covers', undefined, 'GET', 401);
        for (const patch of [
          { kind: 'portrait' },
          { camera: 'top-down' },
          { background: 'transparent' },
          { rights: { ...input.rights, allowAuthorReuse: true } },
          { storyCoverContext: { draftId, ownerId: other.user.id } },
          { heroPortraitContext: { draftId: randomUUID() } },
          { privateReferenceAssetIds: [randomUUID()] },
        ])
          await owner.request('/image-generation/quotes', { ...input, ...patch }, 'POST', 400);
      });
      const q = await owner.request('/image-generation/quotes', input);
      await other.request(
        '/image-generation/jobs',
        { quoteId: q.quote.id, operationId: randomUUID(), consent: true },
        'POST',
        404,
      );
      await owner.request(
        '/image-generation/jobs',
        { quoteId: q.quote.id, operationId: randomUUID(), consent: false },
        'POST',
        400,
      );
      const body = { quoteId: q.quote.id, operationId: randomUUID(), consent: true };
      const [first, repeated] = await Promise.all([
        owner.request('/image-generation/jobs', body),
        owner.request('/image-generation/jobs', body),
      ]);
      assert.equal(first.id, repeated.id);
      const done = await until(
        () => owner.request(`/image-generation/jobs/${first.id}`),
        (job) => job.status === 'admitted',
      );
      assert.ok(done.revisionId);
      await t.test(
        'generation creates no story and never exposes another actor artwork',
        async () => {
          assert.equal((await owner.request('/studio/adventures')).length, 0);
          assert.equal((await other.request('/image-generation/story-covers')).jobs.length, 0);
          assert.equal((await owner.request('/image-generation/hero-portraits')).jobs.length, 0);
          const guessedDraft = await other.request('/image-generation/quotes', {
            ...input,
            declineReuse: false,
          });
          assert.equal(guessedDraft.decision, 'quote');
          assert.equal(guessedDraft.matches.length, 0);
          await other.request(`/image-generation/jobs/${first.id}`, undefined, 'GET', 404);
          await other.request(
            `/image-generation/story-covers/${done.revisionId}/asset`,
            undefined,
            'GET',
            404,
          );
          await other.request(`/asset-library/revisions/${done.revisionId}`, undefined, 'GET', 404);
        },
      );
      const asset = await owner.request(`/image-generation/story-covers/${done.revisionId}/asset`);
      assert.deepEqual(
        await owner.request(`/image-generation/story-covers/${done.revisionId}/asset`),
        asset,
      );
      const story = await owner.request('/studio/adventures', storyInput());
      await t.test(
        'selection alone preserves the old cover; save and refresh pin owned media',
        async () => {
          assert.equal((await owner.request(`/studio/adventures/${story.id}`)).coverAssetId, null);
          const saved = await owner.request(
            `/studio/adventures/${story.id}`,
            { coverAssetId: asset.assetId, expectedEditRevision: story.editRevision },
            'PATCH',
          );
          assert.equal(saved.coverAssetId, asset.assetId);
          assert.equal(
            (await owner.request(`/studio/adventures/${story.id}`)).coverAssetId,
            asset.assetId,
          );
          await other.request(
            '/studio/adventures',
            { ...storyInput(), coverAssetId: asset.assetId },
            'POST',
            403,
          );
          await other.request(`/assets/${asset.assetId}/file`, undefined, 'GET', 404);
          await client().request(`/assets/${asset.assetId}/file`, undefined, 'GET', 404);
          await other.request(
            `/studio/adventures/${story.id}`,
            { coverAssetId: asset.assetId, expectedEditRevision: saved.editRevision },
            'PATCH',
            404,
          );
        },
      );
      await t.test(
        'existing story context requires owner and private reusable results are free',
        async () => {
          await other.request(
            '/image-generation/quotes',
            { ...input, adventureId: story.id },
            'POST',
            404,
          );
          await owner.request(
            '/image-generation/quotes',
            { ...input, adventureId: randomUUID() },
            'POST',
            404,
          );
          const ownQuote = await owner.request('/image-generation/quotes', {
            ...input,
            adventureId: story.id,
          });
          assert.equal(ownQuote.decision, 'quote');
          const archivedStory = await owner.request('/studio/adventures', storyInput());
          const archivedQuote = await owner.request('/image-generation/quotes', {
            ...input,
            adventureId: archivedStory.id,
          });
          await db.query("UPDATE adventures SET status='archived' WHERE id=$1", [archivedStory.id]);
          await owner.request(
            '/image-generation/jobs',
            { quoteId: archivedQuote.quote.id, operationId: randomUUID(), consent: true },
            'POST',
            404,
          );
          const reuse = await owner.request('/image-generation/quotes', {
            ...input,
            storyCoverContext: { draftId: randomUUID() },
            declineReuse: false,
          });
          assert.equal(reuse.decision, 'reuse');
          assert.equal(reuse.charge, 0);
          const list = await owner.request('/image-generation/story-covers');
          assert.equal(list.jobs[0].revisionId, done.revisionId);
          assert.ok(!JSON.stringify(list).includes('PRIVATE_STORY_COVER_DESCRIPTION'));
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM image_generation_attempts WHERE job_id=$1',
                [first.id],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await stopApi('SIGKILL');
      await startApi();
      assert.equal(
        (await owner.request('/image-generation/story-covers')).jobs[0].revisionId,
        done.revisionId,
      );
      await stopApi();
      await t.test(
        'queued cancellation and transport retry stay idempotent without provider calls',
        async () => {
          // No API worker runs while exercising the deterministic queued cancellation boundary.
          const engine = new ImageGenerationEngine(database, new AssetReuseService(database));
          const quote = await engine.quote(owner.user.id, input);
          const operation = { quoteId: quote.quote.id, operationId: randomUUID(), consent: true };
          const queued = await engine.enqueue(owner.user.id, operation);
          const cancel = { operationId: randomUUID() };
          await assert.rejects(
            () => engine.cancel(other.user.id, queued.id, cancel),
            code('NOT_FOUND'),
          );
          assert.equal((await engine.cancel(owner.user.id, queued.id, cancel)).status, 'cancelled');
          assert.equal((await engine.cancel(owner.user.id, queued.id, cancel)).status, 'cancelled');
          const replay = await engine.enqueue(owner.user.id, operation);
          assert.equal(replay.id, queued.id);
          assert.equal(replay.status, 'cancelled');
          await assert.rejects(
            () => engine.enqueue(owner.user.id, { ...operation, operationId: randomUUID() }),
            code('QUOTE_CONSUMED'),
          );
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM image_generation_attempts WHERE job_id=$1',
                [queued.id],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (await db.query('SELECT data FROM adventures WHERE id=$1', [story.id])).rows[0].data
              .coverAssetId,
            asset.assetId,
          );
        },
      );
      await t.test('taken-down generated covers cannot be selected again', async () => {
        const assets = new AssetReuseService(database);
        const engine = new ImageGenerationEngine(database, assets);
        await assets.takedown(owner.user.id, done.revisionId, randomUUID());
        await assert.rejects(
          () => engine.storyCoverAsset(owner.user.id, done.revisionId),
          code('NOT_FOUND'),
        );
      });
    } finally {
      await stopApi();
      await database.onApplicationShutdown();
      await db.end();
    }
  },
);
