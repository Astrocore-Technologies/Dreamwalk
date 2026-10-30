/** Real optimistic concurrency for debounced Studio writes; stale tabs cannot overwrite. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, startApi, stopApi, client } from './support-runtime.mjs';
import { authoredDraft, storyInput } from './support-authored.mjs';

async function patch(c, path, body) {
  const response = await fetch(process.env.TEST_GAME_API_URL + path, {
    method: 'PATCH',
    signal: AbortSignal.timeout(15000),
    headers: {
      'content-type': 'application/json',
      origin: process.env.WEB_ORIGIN,
      cookie: c.cookie,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
await test(
  'Studio autosave CAS persists valid drafts and rejects stale or invalid writes without overwriting',
  { timeout: 30000 },
  async (t) => {
    try {
      await startApi();
      const author = await client().register(),
        outsider = await client().register();
      await t.test(
        'narrative competing tabs have exactly one winner and fresh revision can resume',
        async () => {
          const story = await author.request('/studio/adventures', storyInput());
          assert.equal(story.editRevision, 1);
          const route = `/studio/adventures/${story.id}`;
          const [tabA, tabB] = await Promise.all([author.request(route), author.request(route)]);
          const results = await Promise.all([
            patch(author, route, {
              title: 'First autosave title',
              expectedEditRevision: tabA.editRevision,
            }),
            patch(author, route, {
              title: 'Other tab title',
              expectedEditRevision: tabB.editRevision,
            }),
          ]);
          assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
          const winner = results.find((r) => r.status === 200).body;
          assert.equal(results.find((r) => r.status === 409).body.code, 'STALE_STATE');
          const reloaded = await author.request(route);
          assert.equal(reloaded.title, winner.title);
          assert.equal(reloaded.editRevision, 2);
          assert.equal(reloaded.synopsis, story.synopsis);
          await author.request(route, { title: '', expectedEditRevision: 2 }, 'PATCH', 400);
          await author.request(
            route,
            { title: 'Invalid revision', expectedEditRevision: -1 },
            'PATCH',
            400,
          );
          await outsider.request(
            route,
            { title: 'Forbidden overwrite', expectedEditRevision: 2 },
            'PATCH',
            404,
          );
          assert.equal((await author.request(route)).editRevision, 2);
          const resumed = await author.request(
            route,
            { synopsis: 'A valid resumed autosave.', expectedEditRevision: 2 },
            'PATCH',
          );
          assert.equal(resumed.editRevision, 3);
          assert.equal(resumed.title, winner.title);
          assert.equal((await author.request(route)).synopsis, 'A valid resumed autosave.');
          const data = (await db.query('SELECT data FROM adventures WHERE id=$1', [story.id]))
            .rows[0].data;
          assert.equal(data.expectedEditRevision, undefined);
          await author.request(
            `/studio/adventures/${story.id}/playable-draft`,
            { expectedRevision: 0, draft: authoredDraft() },
            'PUT',
          );
          assert.equal(
            (await author.request(route)).editRevision,
            3,
            'independent map save must not invalidate narrative CAS',
          );
          const translated = await author.request(
            `${route}/translations/en`,
            {
              title: 'Reviewed English title',
              expectedSourceRevision: resumed.sourceRevision,
              expectedEditRevision: 3,
            },
            'PATCH',
          );
          assert.equal(
            translated.editRevision,
            4,
            'translation edit participates in narrative CAS',
          );
          await author.request(
            route,
            { synopsis: 'Stale overwrite after translation', expectedEditRevision: 3 },
            'PATCH',
            409,
          );
          assert.equal(
            (await author.request(route)).translations.en.title,
            'Reviewed English title',
          );
        },
      );
      await t.test(
        'NPC text autosave keeps originals and secrets when stale tabs or invalid names fail',
        async () => {
          const npc = await author.request('/npcs', {
            name: 'Initial NPC',
            secrets: 'PRIVATE_AUTOSAVE_SECRET',
            description: 'Initial description',
          });
          assert.equal(npc.editRevision, 1);
          const route = `/npcs/${npc.id}`;
          const first = await author.request(route),
            second = await author.request(route);
          const saved = await author.request(
            route,
            { name: 'Saved NPC name', expectedEditRevision: first.editRevision },
            'PATCH',
          );
          assert.equal(saved.editRevision, 2);
          const stale = await author.request(
            route,
            { name: 'Stale NPC name', expectedEditRevision: second.editRevision },
            'PATCH',
            409,
          );
          assert.equal(stale.code, 'STALE_STATE');
          await author.request(route, { name: '', expectedEditRevision: 2 }, 'PATCH', 400);
          const reloaded = await author.request(route);
          assert.equal(reloaded.name, 'Saved NPC name');
          assert.equal(reloaded.secrets, 'PRIVATE_AUTOSAVE_SECRET');
          assert.equal(reloaded.description, 'Initial description');
          assert.equal(reloaded.editRevision, 2);
          const resumed = await author.request(
            route,
            { description: 'New persisted description', expectedEditRevision: 2 },
            'PATCH',
          );
          assert.equal(resumed.editRevision, 3);
          assert.equal(resumed.name, 'Saved NPC name');
          await outsider.request(
            route,
            { name: 'Foreign write', expectedEditRevision: 3 },
            'PATCH',
            404,
          );
          assert.equal((await author.request(route)).description, 'New persisted description');
          const data = (await db.query('SELECT data FROM npcs WHERE id=$1', [npc.id])).rows[0].data;
          assert.equal(data.expectedEditRevision, undefined);
          const translated = await author.request(
            `${route}/translations/en`,
            {
              name: 'English NPC name',
              expectedSourceRevision: resumed.sourceRevision,
              expectedEditRevision: 3,
            },
            'PATCH',
          );
          assert.equal(translated.editRevision, 4);
          await author.request(
            route,
            { name: 'Stale name after translation', expectedEditRevision: 3 },
            'PATCH',
            409,
          );
          assert.equal((await author.request(route)).translations.en.name, 'English NPC name');
        },
      );
    } finally {
      await stopApi();
      await db.end();
    }
  },
);
