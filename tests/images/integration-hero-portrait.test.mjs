import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, startApi, stopApi, client, until } from '../game/support-runtime.mjs';

test(
  'private unsaved hero portraits reuse durable generation without creating heroes',
  { timeout: 120000 },
  async () => {
    try {
      await startApi();
      const owner = await client().register(),
        other = await client().register();
      const draftId = randomUUID();
      const input = {
        heroPortraitContext: { draftId },
        prompt: 'PRIVATE_HERO_APPEARANCE',
        title: 'Hero portrait',
        kind: 'portrait',
        camera: 'portrait',
        tags: ['hero-portrait'],
        background: 'opaque',
        mode: 'mock',
        declineReuse: true,
        rights: {
          basis: 'generated',
          licenseLabel: 'Private generated portrait',
          attribution: '',
          allowAuthorReuse: false,
          attested: true,
        },
      };
      await client().request('/image-generation/hero-portraits', undefined, 'GET', 401);
      for (const patch of [
        { kind: 'background' },
        { camera: 'top-down' },
        { adventureId: randomUUID() },
        { rights: { ...input.rights, allowAuthorReuse: true } },
        { heroPortraitContext: { draftId, ownerId: other.user.id } },
      ])
        await owner.request('/image-generation/quotes', { ...input, ...patch }, 'POST', 400);
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
      const [a, b] = await Promise.all([
        owner.request('/image-generation/jobs', body),
        owner.request('/image-generation/jobs', body),
      ]);
      assert.equal(a.id, b.id);
      const done = await until(
        () => owner.request(`/image-generation/jobs/${a.id}`),
        (v) => v.status === 'admitted',
      );
      assert.ok(done.revisionId);
      assert.equal(
        (await owner.request('/heroes')).length,
        0,
        'generation must not silently save a hero',
      );
      assert.equal((await other.request('/image-generation/hero-portraits')).jobs.length, 0);
      const guessedDraft = await other.request('/image-generation/quotes', {
        ...input,
        declineReuse: false,
      });
      assert.equal(
        guessedDraft.decision,
        'quote',
        'guessing another actor draft UUID does not expose their artwork',
      );
      assert.equal(guessedDraft.matches.length, 0);
      await other.request(
        `/image-generation/hero-portraits/${done.revisionId}/asset`,
        undefined,
        'GET',
        404,
      );
      await other.request(`/asset-library/revisions/${done.revisionId}`, undefined, 'GET', 404);
      const asset = await owner.request(
        `/image-generation/hero-portraits/${done.revisionId}/asset`,
      );
      assert.deepEqual(
        await owner.request(`/image-generation/hero-portraits/${done.revisionId}/asset`),
        asset,
      );
      const h = await owner.request('/heroes', {
        name: 'Hero',
        backstory: 'Private backstory',
        notes: 'PRIVATE_NOTES',
        traits: [],
        portraitAssetId: asset.assetId,
      });
      assert.equal(h.portraitAssetId, asset.assetId);
      await other.request(
        '/heroes',
        { name: 'Thief', backstory: '', notes: '', traits: [], portraitAssetId: asset.assetId },
        'POST',
        403,
      );
      const reuse = await owner.request('/image-generation/quotes', {
        ...input,
        heroPortraitContext: { draftId: randomUUID() },
        declineReuse: false,
      });
      assert.equal(reuse.decision, 'reuse');
      assert.equal(reuse.charge, 0);
      const list = await owner.request('/image-generation/hero-portraits');
      assert.equal(list.jobs[0].revisionId, done.revisionId);
      assert.ok(!JSON.stringify(list).includes('PRIVATE_HERO_APPEARANCE'));
      assert.equal(
        (
          await db.query('SELECT count(*)::int n FROM image_generation_attempts WHERE job_id=$1', [
            a.id,
          ])
        ).rows[0].n,
        1,
      );
      await stopApi('SIGKILL');
      await startApi();
      assert.equal(
        (await owner.request('/image-generation/hero-portraits')).jobs[0].revisionId,
        done.revisionId,
      );
    } finally {
      await stopApi();
      await db.end();
    }
  },
);
