import test from 'node:test';
import assert from 'node:assert/strict';
import { db, startApi, stopApi, client } from '../game/support-runtime.mjs';
import { fixturePng } from '../images/support.mjs';
import { storyInput } from '../game/support-authored.mjs';

await test('homepage discovery always uses immutable approved snapshots, including for their author', async (t) => {
  try {
    await startApi();
    const owner = await client().register(),
      admin = await client().register(),
      reader = await client().register(),
      guest = client();
    // Synthetic disposable database fixture only; no application privilege-grant endpoint.
    await db.query("UPDATE users SET role='admin' WHERE id=$1", [admin.user.id]);
    const portrait = async () => {
      const form = new FormData();
      form.append('file', new Blob([await fixturePng()], { type: 'image/png' }), 'portrait.png');
      const response = await fetch(process.env.TEST_GAME_API_URL + '/assets', {
        method: 'POST',
        headers: { cookie: owner.cookie, origin: process.env.WEB_ORIGIN },
        body: form,
      });
      assert.equal(response.status, 201);
      return (await response.json()).id;
    };
    const approvedPortrait = await portrait(),
      draftPortrait = await portrait();
    const npc = await owner.request('/npcs', {
      portraitAssetId: approvedPortrait,
      name: 'Approved Keeper',
      description: 'Approved public description',
      role: 'Guide',
      secrets: 'PRIVATE_NPC_SECRET',
      biography: 'PRIVATE_NPC_BIOGRAPHY',
    });
    const data = {
      ...storyInput('public'),
      title: 'Approved public adventure',
      content: { ...storyInput().content, npcIds: [npc.id] },
    };
    const story = await owner.request('/studio/adventures', data);
    await owner.request(`/studio/adventures/${story.id}/submit`, {});
    await admin.request(`/admin/adventures/${story.id}/moderate`, {
      decision: 'approve',
      reason: 'Isolated homepage acceptance',
    });
    await t.test(
      'published view returns public read-only approved NPCs and rejects private fields',
      async () => {
        for (const actor of [owner, reader, guest]) {
          const result = await actor.request(`/adventures/${story.slug}?view=published`);
          assert.equal(result.access, 'public');
          assert.equal(result.readOnly, true);
          assert.equal(result.title, data.title);
          assert.equal(result.npcs[0].name, 'Approved Keeper');
          assert.equal(result.npcs[0].portraitAssetId, approvedPortrait);
          for (const secret of ['PRIVATE_NPC_SECRET', 'PRIVATE_NPC_BIOGRAPHY', 'editRevision'])
            assert.ok(!JSON.stringify(result).includes(secret));
        }
      },
    );
    await owner.request(
      `/npcs/${npc.id}`,
      {
        name: 'UNAPPROVED_DRAFT_NPC',
        description: 'UNAPPROVED_DRAFT_DESCRIPTION',
        secrets: 'NEW_PRIVATE_SECRET',
        portraitAssetId: draftPortrait,
      },
      'PATCH',
    );
    await owner.request(
      `/studio/adventures/${story.id}`,
      { ...data, title: 'UNAPPROVED_DRAFT_TITLE' },
      'PATCH',
    );
    await t.test('author changes cannot leak into homepage catalog or published cast', async () => {
      for (const actor of [owner, reader, guest]) {
        const result = await actor.request(`/adventures/${story.slug}?view=published`);
        assert.equal(result.title, data.title);
        assert.equal(result.npcs[0].name, 'Approved Keeper');
        assert.equal(result.npcs[0].portraitAssetId, approvedPortrait);
        assert.equal(result.npcs[0].description, 'Approved public description');
        assert.ok(!JSON.stringify(result).includes('UNAPPROVED'));
        const catalog = await actor.request('/adventures?sort=popular');
        assert.equal(catalog.find((item) => item.id === story.id).title, data.title);
      }
      const editable = await owner.request(`/adventures/${story.slug}`);
      assert.equal(editable.title, 'UNAPPROVED_DRAFT_TITLE');
      assert.equal(editable.npcs[0].name, 'UNAPPROVED_DRAFT_NPC');
      assert.equal(editable.npcs[0].portraitAssetId, draftPortrait);
      const approvedFile = await fetch(
        `${process.env.TEST_GAME_API_URL}/assets/${approvedPortrait}/file`,
      );
      assert.equal(approvedFile.status, 200);
      assert.equal(approvedFile.headers.get('content-type'), 'image/webp');
      assert.ok((await approvedFile.arrayBuffer()).byteLength > 0);
      const draftFile = await fetch(
        `${process.env.TEST_GAME_API_URL}/assets/${draftPortrait}/file`,
      );
      assert.equal(draftFile.status, 404);
      assert.equal(editable.access, 'owner');
      assert.equal(editable.readOnly, false);
    });
    await t.test(
      'private, pending and archived stories cannot opt into public view; unknown view fails closed',
      async () => {
        const privateStory = await owner.request('/studio/adventures', storyInput('private'));
        const pending = await owner.request('/studio/adventures', storyInput('public'));
        await owner.request(`/studio/adventures/${pending.id}/submit`, {});
        for (const actor of [owner, reader, guest])
          for (const hidden of [privateStory, pending])
            await actor.request(`/adventures/${hidden.slug}?view=published`, undefined, 'GET', 404);
        await owner.request(`/adventures/${story.slug}?view=unrestricted`, undefined, 'GET', 400);
        await db.query("UPDATE adventures SET status='archived' WHERE id=$1", [story.id]);
        for (const actor of [owner, reader, guest])
          await actor.request(`/adventures/${story.slug}?view=published`, undefined, 'GET', 404);
      },
    );
  } finally {
    await stopApi();
    await db.end();
  }
});
