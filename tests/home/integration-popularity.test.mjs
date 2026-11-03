import test from 'node:test';
import assert from 'node:assert/strict';
import { db, startApi, stopApi, client } from '../game/support-runtime.mjs';
import { storyInput } from '../game/support-authored.mjs';

await test('public popularity counts completed rounds and distinct authenticated likes, never favorites or private playtests', async (t) => {
  try {
    await startApi();
    const owner = await client().register(),
      reader = await client().register(),
      other = await client().register(),
      guest = client();
    await db.query("UPDATE users SET role='admin' WHERE id=$1", [owner.user.id]);
    const publish = async (title) => {
      const story = await owner.request('/studio/adventures', { ...storyInput('public'), title });
      await owner.request(`/studio/adventures/${story.id}/submit`, {});
      const review = await owner.request(`/admin/adventures/${story.id}/playable-review`);
      await owner.request(`/admin/adventures/${story.id}/moderate`, {
        decision: 'approve',
        reason: 'Isolated popularity acceptance',
        reviewedPlayableVersionId: review.versionId,
      });
      return { ...story, versionId: review.versionId };
    };
    const a = await publish('Popularity Alpha'),
      b = await publish('Popularity Beta');
    const catalog = async (actor = guest) =>
      (await actor.request('/adventures?sort=popular')).filter((x) => [a.id, b.id].includes(x.id));
    const detail = () => guest.request(`/adventures/${a.slug}?view=published`);
    await t.test(
      'empty stories have honest zero counters and stable newest-first ties',
      async () => {
        const rows = await catalog();
        assert.deepEqual(
          rows.map((x) => x.id),
          [b.id, a.id],
        );
        assert.ok(
          rows.every((x) => x.totalRounds === 0 && x.likeCount === 0 && x.likedByMe === false),
        );
      },
    );
    await t.test(
      'idempotent concurrent likes are independent of favorites and authenticate',
      async () => {
        await guest.request(`/likes/${a.id}`, {}, 'PUT', 401);
        await owner.request(`/favorites/${b.id}`, {}, 'PUT');
        await Promise.all(
          Array.from({ length: 5 }, () => reader.request(`/likes/${a.id}`, {}, 'PUT')),
        );
        await other.request(`/likes/${a.id}`, {}, 'PUT');
        assert.equal((await detail()).likeCount, 2);
        assert.equal((await catalog(reader))[0].likedByMe, true);
        assert.equal((await catalog(guest))[0].likedByMe, false);
        assert.equal((await catalog())[0].id, a.id);
        await reader.request(`/likes/${a.id}`, undefined, 'DELETE');
        await reader.request(`/likes/${a.id}`, undefined, 'DELETE');
        assert.equal((await detail()).likeCount, 1);
        assert.equal((await catalog(reader))[0].likedByMe, false);
      },
    );
    const campaign = async (versionId, kinds, playerId = owner.user.id) => {
      const c = (
        await db.query(
          "INSERT INTO game_campaigns(owner_id,playable_version,source_version_id,state) VALUES($1,'fixture',$2,'{}') RETURNING id",
          [playerId, versionId],
        )
      ).rows[0];
      for (const [i, kind] of kinds.entries())
        await db.query(
          'INSERT INTO game_events(campaign_id,sequence,kind,payload) VALUES($1,$2,$3,$4)',
          [c.id, i + 1, kind, JSON.stringify({ privateText: 'NEVER_EXPOSE_CAMPAIGN_CONTENT' })],
        );
      return c.id;
    };
    await t.test(
      'round totals span campaigns without multiplying by likes, excluding nonround events and unapproved versions',
      async () => {
        await campaign(a.versionId, [
          'turn.world.completed',
          'round.resolved',
          'npc.speech',
          'narrative.turn_committed',
        ]);
        await campaign(a.versionId, ['turn.world.completed']);
        const privateVersion = (
          await db.query(
            "INSERT INTO game_playable_versions(adventure_id,source_revision,audience,package,checksum) VALUES($1,1,'private','{}','fixture') RETURNING id",
            [a.id],
          )
        ).rows[0];
        await campaign(privateVersion.id, ['turn.world.completed']);
        const beforeApproval = await campaign(a.versionId, ['turn.world.completed']);
        await db.query("UPDATE game_events SET created_at='2000-01-01' WHERE campaign_id=$1", [
          beforeApproval,
        ]);
        const result = await detail();
        assert.equal(result.totalRounds, 3);
        assert.equal(result.likeCount, 1);
        assert.ok(!JSON.stringify(result).includes('NEVER_EXPOSE_CAMPAIGN_CONTENT'));
        await other.request(`/likes/${a.id}`, undefined, 'DELETE');
        assert.equal((await catalog())[0].id, a.id); // equal likes: real rounds break tie
      },
    );
    await t.test('soft-deleted participants contribute neither likes nor rounds', async () => {
      await other.request(`/likes/${a.id}`, {}, 'PUT');
      await campaign(a.versionId, ['turn.world.completed'], other.user.id);
      await db.query('UPDATE users SET deleted_at=now() WHERE id=$1', [other.user.id]);
      assert.equal((await detail()).likeCount, 0);
      assert.equal((await detail()).totalRounds, 3);
    });
    await t.test(
      'withdrawn, archived and unpublished stories cannot receive likes or leak public counters',
      async () => {
        await reader.request(`/likes/${a.id}`, {}, 'PUT');
        await db.query("UPDATE adventures SET visibility='private' WHERE id=$1", [a.id]);
        await reader.request(`/likes/${a.id}`, {}, 'PUT', 404);
        assert.ok(!(await catalog()).some((x) => x.id === a.id));
        assert.equal((await owner.request(`/adventures/${a.slug}`)).totalRounds, 0);
        assert.deepEqual(await reader.request(`/likes/${a.id}`, undefined, 'DELETE'), {
          likeCount: 0,
          likedByMe: false,
        });
        await db.query("UPDATE adventures SET visibility='public',status='archived' WHERE id=$1", [
          a.id,
        ]);
        await reader.request(`/likes/${a.id}`, {}, 'PUT', 404);
        const draft = await owner.request('/studio/adventures', {
          ...storyInput('public'),
          title: 'Never published',
        });
        await owner.request(`/likes/${draft.id}`, {}, 'PUT', 404);
        await db.query('UPDATE users SET deleted_at=now() WHERE id=$1', [owner.user.id]);
        assert.equal((await catalog()).length, 0);
      },
    );
  } finally {
    await stopApi();
    await db.end();
  }
});
