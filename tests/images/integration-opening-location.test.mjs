/** A story written as a description plus a first message has one generic opening location for art. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, startApi, stopApi, client } from '../game/support-runtime.mjs';
import { storyInput } from '../game/support-authored.mjs';

await test(
  'opening location picture brief comes from the first message; real locations are unaffected',
  { timeout: 90000 },
  async (t) => {
    try {
      await startApi();
      const owner = await client().registerLegacyFixture(),
        other = await client().register();
      const written = storyInput();
      written.content = {
        world: 'Старый порт, где туман не рассеивается.',
        firstMessage: 'Вы стоите на мокром причале, и фонарь над трапом дрожит на ветру.',
        npcIds: [],
        locations: [],
        scenes: [],
        startSceneId: '',
      };
      const story = await owner.request('/studio/adventures', written);
      const selection = { adventureId: story.id, locationId: 'opening' };
      await t.test('the brief uses the opening text and is owner-only', async () => {
        const prepared = await owner.request(
          '/image-generation/studio-locations/prepare',
          selection,
        );
        assert.equal(prepared.request.mode, 'external');
        assert.equal(prepared.location.id, 'opening');
        assert.match(prepared.request.prompt, /мокром причале/);
        assert.equal(prepared.binding, null);
        await other.request('/image-generation/studio-locations/prepare', selection, 'POST', 404);
        // Preparing a brief never creates a quote, job or attempt.
        assert.equal(
          Number(
            (
              await db.query(
                'SELECT count(*) n FROM image_generation_jobs WHERE actor_id=$1 AND adventure_id=$2',
                [owner.user.id, story.id],
              )
            ).rows[0].n,
          ),
          0,
        );
      });
      await t.test(
        'the first message changes the source hash so an old picture reads as stale',
        async () => {
          const before = await owner.request(
            '/image-generation/studio-locations/prepare',
            selection,
          );
          const current = await owner.request(`/studio/adventures/${story.id}`);
          await owner.request(
            `/studio/adventures/${story.id}`,
            {
              expectedEditRevision: current.editRevision,
              content: { ...current.content, firstMessage: 'Вы входите в тёмный склад.' },
            },
            'PATCH',
          );
          const after = await owner.request(
            '/image-generation/studio-locations/prepare',
            selection,
          );
          assert.notEqual(after.sourceHash, before.sourceHash);
          assert.match(after.request.prompt, /тёмный склад/);
        },
      );
      await t.test('a story with its own locations has no generic opening location', async () => {
        const plain = await owner.request('/studio/adventures', storyInput());
        await owner.request(
          '/image-generation/studio-locations/prepare',
          { adventureId: plain.id, locationId: 'opening' },
          'POST',
          404,
        );
      });
      await t.test('a story with no text at all has nothing to picture', async () => {
        const empty = storyInput();
        empty.content = { world: '', npcIds: [], locations: [], scenes: [], startSceneId: '' };
        const blank = await owner.request('/studio/adventures', empty);
        await owner.request(
          '/image-generation/studio-locations/prepare',
          { adventureId: blank.id, locationId: 'opening' },
          'POST',
          404,
        );
      });
    } finally {
      await stopApi();
    }
  },
);
