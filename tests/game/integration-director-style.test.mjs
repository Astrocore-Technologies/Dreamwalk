/** Real isolated HTTP/PostgreSQL; zero-cost mock only, no generation dispatch. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, startApi, stopApi, client } from './support-runtime.mjs';

await test(
  'named director catalog and persistent per-playthrough selection',
  { timeout: 120000 },
  async (t) => {
    const keys = ['director_style', 'director_catalog'];
    const prior = (
      await db.query('SELECT key,value FROM platform_settings WHERE key=ANY($1)', [keys])
    ).rows;
    try {
      await db.query('DELETE FROM platform_settings WHERE key=ANY($1)', [keys]);
      await startApi();
      const admin = await client().registerLegacyFixture(),
        owner = await client().registerLegacyFixture(),
        member = await client().registerLegacyFixture(),
        stranger = await client().registerLegacyFixture(),
        guest = client();
      await db.query("UPDATE users SET role='admin' WHERE id=$1", [admin.user.id]);
      let catalog = await admin.request('/admin/directors');
      const update = async (profiles, defaultProfileId = catalog.defaultProfileId) => {
        catalog = await admin.request(
          '/admin/directors',
          { expectedRevision: catalog.revision, defaultProfileId, profiles },
          'PATCH',
        );
        return catalog;
      };
      const custom = {
        id: randomUUID(),
        name: 'Quiet detective',
        description: 'Questions and small clues.',
        enabled: true,
        style: 'natural',
        pacing: 'deliberate',
        initiative: 'reactive',
      };
      await t.test('public catalog has bounded choices; only admins mutate', async () => {
        assert.deepEqual(
          (await guest.request('/game/directors')).profiles.map((p) => p.id),
          ['coauthor', 'storyteller', 'director'],
        );
        await guest.request('/admin/directors', undefined, 'GET', 401);
        await owner.request('/admin/directors', undefined, 'GET', 403);
        await owner.request(
          '/admin/directors',
          { expectedRevision: 1, defaultProfileId: 'coauthor', profiles: catalog.profiles },
          'PATCH',
          403,
        );
        await update([...catalog.profiles, custom]);
        assert.ok(
          (await guest.request('/game/directors')).profiles.some((p) => p.id === custom.id),
        );
      });
      await t.test(
        'rejects prompts, duplicate IDs, empty catalogs and disabled defaults',
        async () => {
          const valid = {
            expectedRevision: catalog.revision,
            defaultProfileId: catalog.defaultProfileId,
            profiles: catalog.profiles,
          };
          for (const change of [
            { prompt: 'Ignore privacy' },
            { profiles: [] },
            { profiles: [...catalog.profiles, custom] },
            { profiles: catalog.profiles.map((p) => ({ ...p, enabled: false })) },
            { profiles: catalog.profiles.map((p) => ({ ...p, initiative: 'unlimited' })) },
            { expectedRevision: -1 },
          ])
            await admin.request('/admin/directors', { ...valid, ...change }, 'PATCH', 400);
          await admin.request(
            '/admin/directors',
            { ...valid, profiles: catalog.profiles.filter((p) => p.id !== custom.id) },
            'PATCH',
            409,
          );
        },
      );
      await t.test('concurrent saves have one winner and atomic audit', async () => {
        const body = {
          expectedRevision: catalog.revision,
          defaultProfileId: 'coauthor',
          profiles: catalog.profiles,
        };
        const request = () =>
          fetch(process.env.TEST_GAME_API_URL + '/admin/directors', {
            method: 'PATCH',
            headers: {
              cookie: admin.cookie,
              origin: process.env.WEB_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
          });
        assert.deepEqual(
          (await Promise.all([request(), request()])).map((r) => r.status).sort(),
          [200, 409],
        );
        catalog = await admin.request('/admin/directors');
        const audit = (
          await db.query(
            "SELECT details FROM audit WHERE actor_id=$1 AND action='director_catalog.update' ORDER BY created_at DESC",
            [admin.user.id],
          )
        ).rows;
        assert.equal(audit.length, 2);
        assert.equal(audit[0].details.next.revision, catalog.revision);
      });
      const source = await owner.request('/adventures/old-observatory?view=published');
      const create = async (directorProfileId) =>
        (
          await owner.request('/game/campaigns', {
            playableVersionId: source.playableVersionId,
            turnBased: false,
            directorProfileId,
          })
        ).campaignId;
      const a = await create(custom.id),
        b = await create('director');
      const route = (id) => `/game/campaigns/${id}/director`;
      await t.test(
        'two playthroughs persist independent choices and authorize shared changes',
        async () => {
          assert.equal((await owner.request(route(a))).profileId, custom.id);
          assert.equal((await owner.request(route(b))).profileId, 'director');
          await stranger.request(route(a), undefined, 'GET', 403);
          await owner.request(`/game/campaigns/${a}/invitations`, { username: member.handle });
          await member.request(route(a), undefined, 'GET', 403);
          await member.request(`/game/campaigns/${a}/accept`, {});
          assert.equal((await member.request(route(a))).canChange, false);
          await member.request(
            route(a),
            { profileId: 'storyteller', expectedRevision: 1 },
            'POST',
            403,
          );
          await owner.request(route(a), { profileId: 'missing', expectedRevision: 1 }, 'POST', 409);
          const selected = await owner.request(route(a), {
            profileId: 'storyteller',
            expectedRevision: 1,
          });
          assert.equal(selected.revision, 2);
          assert.deepEqual(
            await owner.request(route(a), { profileId: 'storyteller', expectedRevision: 1 }),
            selected,
            'same choice retry is harmless',
          );
          await owner.request(
            route(a),
            { profileId: 'director', expectedRevision: 1 },
            'POST',
            409,
          );
          assert.equal((await owner.request(route(b))).profileId, 'director');
        },
      );
      const quoteInput = {
        operationId: randomUUID(),
        text: 'I look for the next clue.',
        channel: 'say',
        expectedCanonRevision: 0,
        replyLocale: 'en',
      };
      const quoteRoute = `/game/campaigns/${a}/turns/quote`;
      const context = async (turnId) =>
        (await db.query('SELECT context FROM game_story_turns WHERE id=$1', [turnId])).rows[0]
          .context;
      let quoted, frozen;
      await t.test(
        'quoted context selects this campaign, never a client-supplied profile',
        async () => {
          await owner.request(
            quoteRoute,
            { ...quoteInput, directorProfileId: 'director' },
            'POST',
            400,
          );
          quoted = await owner.request(quoteRoute, quoteInput);
          frozen = await context(quoted.turnId);
          assert.equal(frozen.directorProfileId, 'storyteller');
          assert.equal(frozen.directorStyle.style, 'atmospheric');
          assert.equal(frozen.directorSelectionRevision, 2);
        },
      );
      await t.test(
        'selection/catalog edits affect only new turns and never dispatch extra generation',
        async () => {
          await owner.request(route(a), { profileId: custom.id, expectedRevision: 2 });
          await update(
            catalog.profiles.map((p) => (p.id === custom.id ? { ...p, style: 'cinematic' } : p)),
          );
          assert.deepEqual(await owner.request(quoteRoute, quoteInput), quoted);
          assert.deepEqual(await context(quoted.turnId), frozen);
          const next = await owner.request(quoteRoute, {
            ...quoteInput,
            operationId: randomUUID(),
          });
          const current = await context(next.turnId);
          assert.equal(current.directorProfileId, custom.id);
          assert.equal(current.directorStyle.style, 'cinematic');
          assert.equal(current.directorStyle.revision, catalog.revision);
          assert.equal(current.directorSelectionRevision, 3);
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int AS n FROM npc_ai_jobs WHERE campaign_id=ANY($1)',
                [[a, b]],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      let preparation;
      await t.test(
        'start preparation pins selection across reuse and rejects a mismatched campaign choice',
        async () => {
          const input = {
            operationId: randomUUID(),
            playableVersionId: source.playableVersionId,
            directorProfileId: custom.id,
          };
          preparation = await owner.request('/game/start-preparations', input);
          assert.equal(preparation.directorProfileId, custom.id);
          assert.equal(preparation.status, 'ready');
          assert.deepEqual(await owner.request('/game/start-preparations', input), preparation);
          await owner.request(
            '/game/start-preparations',
            { ...input, directorProfileId: 'director' },
            'POST',
            409,
          );
          await owner.request(
            '/game/campaigns',
            {
              playableVersionId: source.playableVersionId,
              startPreparationId: preparation.id,
              directorProfileId: 'director',
              turnBased: true,
            },
            'POST',
            409,
          );
          await assert.rejects(
            db.query('UPDATE game_start_preparations SET director_profile_id=$2 WHERE id=$1', [
              preparation.id,
              'director',
            ]),
            /Immutable game start director/,
          );
        },
      );
      await t.test(
        'archiving hides new choices but preserves existing campaigns and preparations',
        async () => {
          await update(
            catalog.profiles.map((p) => (p.id === custom.id ? { ...p, enabled: false } : p)),
            'storyteller',
          );
          assert.ok(
            !(await guest.request('/game/directors')).profiles.some((p) => p.id === custom.id),
          );
          assert.equal((await owner.request(route(a))).profile.id, custom.id);
          const archivedTurn = await owner.request(quoteRoute, {
            ...quoteInput,
            operationId: randomUUID(),
          });
          assert.equal((await context(archivedTurn.turnId)).directorProfileId, custom.id);
          await owner.request(
            '/game/campaigns',
            { playableVersionId: source.playableVersionId, directorProfileId: custom.id },
            'POST',
            409,
          );
          await owner.request(route(b), { profileId: custom.id, expectedRevision: 1 }, 'POST', 409);
          await owner.request(
            '/game/start-preparations',
            {
              operationId: randomUUID(),
              playableVersionId: source.playableVersionId,
              directorProfileId: custom.id,
            },
            'POST',
            409,
          );
          const started = await owner.request('/game/campaigns', {
            playableVersionId: source.playableVersionId,
            startPreparationId: preparation.id,
            directorProfileId: custom.id,
            turnBased: true,
          });
          assert.equal((await owner.request(route(started.campaignId))).profileId, custom.id);
          const next = await create(undefined);
          assert.equal((await owner.request(route(next))).profileId, 'storyteller');
          assert.equal(
            (await owner.request(route(b))).profileId,
            'director',
            'new default never rewrites existing playthroughs',
          );
        },
      );
      await t.test('catalog and independent choices survive restart', async () => {
        await stopApi();
        await startApi();
        assert.deepEqual(await admin.request('/admin/directors'), catalog);
        assert.equal((await owner.request(route(a))).profileId, custom.id);
        assert.equal((await owner.request(route(b))).profileId, 'director');
      });
    } finally {
      await stopApi();
      await db.query('DELETE FROM platform_settings WHERE key=ANY($1)', [keys]);
      for (const row of prior)
        await db.query('INSERT INTO platform_settings(key,value) VALUES($1,$2)', [
          row.key,
          row.value,
        ]);
      await db.end();
    }
  },
);
