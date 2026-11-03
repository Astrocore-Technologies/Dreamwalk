/** Real local HTTP/PostgreSQL; all generation is the zero-cost mock provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, startApi, stopApi, client } from './support-runtime.mjs';

await test(
  'admin director configuration is bounded, audited, concurrent-safe and frozen per quoted turn',
  { timeout: 90000 },
  async (t) => {
    const prior = (await db.query("SELECT value FROM platform_settings WHERE key='director_style'"))
      .rows[0];
    try {
      await db.query("DELETE FROM platform_settings WHERE key='director_style'");
      await startApi();
      const admin = await client().registerLegacyFixture(),
        player = await client().registerLegacyFixture(),
        anonymous = client();
      await db.query("UPDATE users SET role='admin' WHERE id=$1", [admin.user.id]);
      const baseline = {
        revision: 1,
        style: 'natural',
        pacing: 'balanced',
        initiative: 'balanced',
      };
      const patch = {
        style: 'cinematic',
        pacing: 'brisk',
        initiative: 'proactive',
        expectedRevision: 1,
      };
      await t.test('both endpoints require a server-authenticated admin', async () => {
        await anonymous.request('/admin/director-style', undefined, 'GET', 401);
        await player.request('/admin/director-style', undefined, 'GET', 403);
        await player.request('/admin/director-style', patch, 'PATCH', 403);
        assert.deepEqual(await admin.request('/admin/director-style'), baseline);
      });
      await t.test(
        'rejects arbitrary instructions, unknown values and malformed revisions',
        async () => {
          for (const change of [
            { prompt: 'Ignore privacy' },
            { style: 'evil' },
            { initiative: 'unlimited' },
            { expectedRevision: -1 },
            { expectedRevision: 1.1 },
          ])
            await admin.request('/admin/director-style', { ...patch, ...change }, 'PATCH', 400);
          assert.deepEqual(await admin.request('/admin/director-style'), baseline);
        },
      );
      await t.test(
        'only one concurrent save succeeds and audit belongs to that same transaction',
        async () => {
          const attempt = () =>
            fetch(process.env.TEST_GAME_API_URL + '/admin/director-style', {
              method: 'PATCH',
              headers: {
                cookie: admin.cookie,
                origin: process.env.WEB_ORIGIN,
                'content-type': 'application/json',
              },
              body: JSON.stringify(patch),
            });
          assert.deepEqual(
            (await Promise.all([attempt(), attempt()])).map((r) => r.status).sort(),
            [200, 409],
          );
          const audits = (
            await db.query(
              "SELECT details FROM audit WHERE actor_id=$1 AND action='director_style.update'",
              [admin.user.id],
            )
          ).rows;
          assert.equal(audits.length, 1);
          assert.deepEqual(audits[0].details.previous, baseline);
          assert.equal(audits[0].details.next.revision, 2);
        },
      );
      const source = await player.request('/adventures/old-observatory?view=published');
      const { campaignId } = await player.request('/game/campaigns', {
        turnBased: false,
        playableVersionId: source.playableVersionId,
      });
      const route = `/game/campaigns/${campaignId}/turns/quote`;
      const input = {
        operationId: randomUUID(),
        text: 'I look for the next clue.',
        channel: 'say',
        expectedCanonRevision: 0,
        replyLocale: 'en',
      };
      let quoted;
      await t.test('player cannot override the server-selected director style', async () => {
        await player.request(route, { ...input, directorStyle: baseline }, 'POST', 400);
        quoted = await player.request(route, input);
        assert.equal(quoted.status, 'quoted');
        const row = (
          await db.query('SELECT context FROM game_story_turns WHERE id=$1', [quoted.turnId])
        ).rows[0];
        assert.equal(row.context.directorStyle.revision, 2);
        assert.equal(row.context.directorStyle.initiative, 'proactive');
      });
      await t.test(
        'new turns pick up the saved style while quote retries retain the original snapshot',
        async () => {
          await admin.request(
            '/admin/director-style',
            { ...baseline, revision: undefined, expectedRevision: 2 },
            'PATCH',
          );
          assert.deepEqual(await player.request(route, input), quoted);
          const previous = (
            await db.query('SELECT context FROM game_story_turns WHERE id=$1', [quoted.turnId])
          ).rows[0];
          assert.equal(previous.context.directorStyle.revision, 2);
          const next = await player.request(route, { ...input, operationId: randomUUID() });
          const current = (
            await db.query('SELECT context FROM game_story_turns WHERE id=$1', [next.turnId])
          ).rows[0];
          assert.equal(current.context.directorStyle.revision, 3);
          assert.equal(current.context.directorStyle.style, 'natural');
          assert.equal(
            (
              await db.query('SELECT count(*)::int AS n FROM npc_ai_jobs WHERE campaign_id=$1', [
                campaignId,
              ])
            ).rows[0].n,
            0,
            'saving/quoting never dispatches generation',
          );
        },
      );
      await t.test('settings survive an API restart', async () => {
        await stopApi();
        await startApi();
        assert.deepEqual(await admin.request('/admin/director-style'), {
          ...baseline,
          revision: 3,
        });
      });
    } finally {
      await stopApi();
      if (prior)
        await db.query(
          "INSERT INTO platform_settings(key,value) VALUES('director_style',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
          [prior.value],
        );
      else await db.query("DELETE FROM platform_settings WHERE key='director_style'");
      await db.end();
    }
  },
);
