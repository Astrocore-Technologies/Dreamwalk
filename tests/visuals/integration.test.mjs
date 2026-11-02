import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, startApi, stopApi, client, snapshot } from '../game/support-runtime.mjs';
import { fixturePng } from '../images/support.mjs';
const root = '/visual-authoring';
const op = () => randomUUID();
const characterBrief = {
  name: 'Lyra',
  description: 'Adult explorer with copper hair and an emerald cloak',
  outfit: 'Cloak, boots and a satchel',
  appearance: 'Copper hair',
  style: 'drawn2D',
  source: 'text',
  allowOutputReuse: false,
};
await test(
  'visual authoring: private proposals, immutable reusable packs and actual engine pins',
  { timeout: 120000 },
  async (t) => {
    try {
      await startApi();
      const owner = await client().register(),
        outsider = await client().register();
      let project, pack, hero, location, locationPack, story;
      await t.test('config is honest and concept creation is idempotent/owner-only', async () => {
        const config = await owner.request(`${root}/config`);
        assert.equal(config.externalAvailable, false);
        const input = { kind: 'character', operationId: op(), brief: characterBrief };
        project = await owner.request(`${root}/projects`, input);
        assert.equal(project.status, 'concept');
        assert.equal(project.providerCalls, 0);
        assert.equal((await owner.request(`${root}/projects`, input)).id, project.id);
        await outsider.request(`${root}/projects/${project.id}`, undefined, 'GET', 404);
        assert.equal((await outsider.request(`${root}/projects`)).length, 0);
        await owner.request(
          `${root}/projects`,
          { ...input, brief: { ...characterBrief, name: 'Changed' } },
          'POST',
          409,
        );
        await owner.request(
          `${root}/projects/${project.id}/complete`,
          { operationId: op(), expectedRevision: project.revision, consent: true },
          'POST',
          409,
        );
      });
      await t.test(
        'photo permission is distinct from output reuse and photo never enters public output',
        async () => {
          const form = new FormData();
          form.append(
            'file',
            new Blob([await fixturePng()], { type: 'image/png' }),
            'private-photo.png',
          );
          const response = await fetch(process.env.TEST_GAME_API_URL + '/assets', {
            method: 'POST',
            headers: { cookie: owner.cookie, origin: process.env.WEB_ORIGIN },
            body: form,
          });
          assert.equal(response.status, 201);
          const photo = (await response.json()).id;
          await owner.request(
            `${root}/projects`,
            {
              kind: 'character',
              operationId: op(),
              brief: { ...characterBrief, source: 'photo', sourcePhotoAssetId: photo },
            },
            'POST',
            400,
          );
          await outsider.request(
            `${root}/projects`,
            {
              kind: 'character',
              operationId: op(),
              brief: {
                ...characterBrief,
                source: 'photo',
                sourcePhotoAssetId: photo,
                sourcePhotoPermission: true,
              },
            },
            'POST',
            404,
          );
          const p = await owner.request(`${root}/projects`, {
            kind: 'character',
            operationId: op(),
            brief: {
              ...characterBrief,
              source: 'photo',
              sourcePhotoAssetId: photo,
              sourcePhotoPermission: true,
            },
          });
          assert.equal(p.sourcePhotoPrivate, true);
          assert.ok(!JSON.stringify(p).includes(photo));
          const a = await owner.request(`${root}/projects/${p.id}/approve`, {
            operationId: op(),
            expectedRevision: p.revision,
            consent: true,
          });
          const output = await owner.request(`${root}/projects/${p.id}/complete`, {
            operationId: op(),
            expectedRevision: a.revision,
            consent: true,
          });
          assert.ok(!JSON.stringify(output).includes(photo));
          const foreign = await fetch(process.env.TEST_GAME_API_URL + `/assets/${photo}/file`, {
            headers: { cookie: outsider.cookie },
          });
          assert.equal(foreign.status, 404);
          for (const part of output.parts)
            assert.equal(
              (await owner.request(`/asset-library/revisions/${part.revisionId}`)).metadata.rights
                .allowAuthorReuse,
              false,
            );
        },
      );
      await t.test(
        'approval gates a complete transparent directional package and replay creates no duplicate assets',
        async () => {
          project = await owner.request(`${root}/projects/${project.id}/approve`, {
            operationId: op(),
            expectedRevision: project.revision,
            consent: true,
          });
          const input = { operationId: op(), expectedRevision: project.revision, consent: true };
          pack = await owner.request(`${root}/projects/${project.id}/complete`, input);
          assert.equal(
            (await owner.request(`${root}/projects/${project.id}/complete`, input)).id,
            pack.id,
          );
          assert.deepEqual(pack.animation.directions, ['south', 'west', 'east', 'north']);
          assert.equal(pack.parts.length, 3);
          assert.equal(pack.providerCalls, 0);
          assert.equal(pack.parts.find((p) => p.role === 'sheet').width, 768);
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int AS n FROM visual_package_versions WHERE project_id=$1',
                [project.id],
              )
            ).rows[0].n,
            1,
          );
          await assert.rejects(
            db.query("UPDATE visual_package_versions SET manifest='{}' WHERE id=$1", [pack.id]),
            /Immutable visual package/,
          );
        },
      );
      await t.test('cancel and withdrawn concept never become playable packages', async () => {
        let p = await owner.request(`${root}/projects`, {
          kind: 'character',
          operationId: op(),
          brief: characterBrief,
        });
        await owner.request(`${root}/projects/${p.id}/cancel`, {
          operationId: op(),
          expectedRevision: p.revision,
        });
        await owner.request(
          `${root}/projects/${p.id}/approve`,
          { operationId: op(), expectedRevision: p.revision + 1, consent: true },
          'POST',
          409,
        );
        p = await owner.request(`${root}/projects`, {
          kind: 'character',
          operationId: op(),
          brief: characterBrief,
        });
        const a = await owner.request(`${root}/projects/${p.id}/approve`, {
          operationId: op(),
          expectedRevision: p.revision,
          consent: true,
        });
        await owner.request(`/asset-library/revisions/${p.conceptRevisionId}/takedown`, {
          operationId: op(),
          confirm: true,
        });
        await owner.request(
          `${root}/projects/${p.id}/complete`,
          { operationId: op(), expectedRevision: a.revision, consent: true },
          'POST',
          409,
        );
      });
      await t.test(
        'owned hero equips package; campaign gets only safe animation metadata and immutable visible pins',
        async () => {
          hero = await owner.request('/heroes', { name: 'Lyra', notes: 'PRIVATE_HERO_CANARY' });
          await outsider.request(
            '/heroes',
            { name: 'Foreign', characterPackageVersionId: pack.id },
            'POST',
            404,
          );
          await owner.request(`${root}/packages/${pack.id}/equip`, {
            operationId: op(),
            heroId: hero.id,
          });
          const editedPortrait = await owner.request(
            `/heroes/${hero.id}`,
            { portraitAssetId: null },
            'PATCH',
          );
          assert.equal(
            editedPortrait.portraitAssetId,
            null,
            'explicit portrait edit must not be overwritten by the sprite package',
          );
          assert.equal(
            editedPortrait.characterPackageVersionId,
            pack.id,
            'changing portrait does not discard the in-world sprite',
          );
          const { campaignId } = await owner.request('/game/campaigns', {
            template: 'observatory-v1',
            heroId: hero.id,
          });
          const p = (await snapshot(owner, campaignId)).projection;
          assert.equal(p.entities.find((e) => e.id === p.actorId).characterAnimation.rows, 4);
          assert.ok(!JSON.stringify(p).includes('PRIVATE_HERO_CANARY'));
          const manifest = await owner.request(`/asset-library/campaigns/${campaignId}/manifest`);
          assert.ok(manifest.bindings.some((b) => b.slot === `entity:${p.actorId}:sprite`));
          const sheet = manifest.bindings.find((b) => b.slot === `entity:${p.actorId}:sprite`);
          assert.equal(
            (
              await fetch(process.env.TEST_GAME_API_URL.replace('/api/v1', '') + sheet.url, {
                headers: { cookie: owner.cookie },
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await fetch(process.env.TEST_GAME_API_URL.replace('/api/v1', '') + sheet.url, {
                headers: { cookie: outsider.cookie },
              })
            ).status,
            404,
          );
        },
      );
      await t.test(
        'author NPC package creation is idempotent and rejects a foreign package',
        async () => {
          const input = { operationId: op(), targetType: 'npc', createTarget: true };
          const equipped = await owner.request(`${root}/packages/${pack.id}/equip`, input);
          assert.equal(
            (await owner.request(`${root}/packages/${pack.id}/equip`, input)).targetId,
            equipped.targetId,
          );
          const npc = await owner.request(`/npcs/${equipped.targetId}`);
          assert.equal(npc.characterPackageVersionId, pack.id);
          const foreignNpc = await outsider.request('/npcs', { name: 'Foreign NPC' });
          await outsider.request(
            `/npcs/${foreignNpc.id}`,
            { characterPackageVersionId: pack.id },
            'PATCH',
            404,
          );
          assert.equal(
            (await db.query('SELECT count(*)::int AS n FROM npcs WHERE id=$1', [equipped.targetId]))
              .rows[0].n,
            1,
          );
        },
      );
      await t.test(
        'location plan validates footprints/reachability and permits safe reposition/replacement',
        async () => {
          story = await owner.request('/studio/adventures', {
            title: 'Rainlight QA',
            content: {
              world: 'A rainlit city',
              rules: 'No teleportation',
              boundaries: ['No private secrets in narration'],
              locations: [],
              scenes: [],
              npcIds: [],
              startSceneId: '',
            },
          });
          location = await owner.request(`${root}/projects`, {
            kind: 'location',
            operationId: op(),
            adventureId: story.id,
            brief: {
              name: 'Atelier',
              description: 'A night alchemist atelier, worktables, rain and glass door.',
              style: 'drawn2D',
            },
          });
          assert.equal(location.plan.maps[0].composition.layers.length, 5);
          await owner.request(
            `${root}/projects/${location.id}/layers`,
            {
              operationId: op(),
              expectedRevision: location.revision,
              layerId: 'worktable',
              mapId: 'atelier',
              point: { x: 7, y: 9 },
              visual: 'table',
            },
            'POST',
            400,
          );
          location = await owner.request(`${root}/projects/${location.id}/layers`, {
            operationId: op(),
            expectedRevision: location.revision,
            layerId: 'worktable',
            mapId: 'atelier',
            point: { x: 3, y: 5 },
            visual: 'counter',
          });
          assert.equal(location.plan.maps[0].composition.layers[0].y, 5);
          location = await owner.request(`${root}/projects/${location.id}/approve`, {
            operationId: op(),
            expectedRevision: location.revision,
            consent: true,
          });
          locationPack = await owner.request(`${root}/projects/${location.id}/complete`, {
            operationId: op(),
            expectedRevision: location.revision,
            consent: true,
          });
          location = await owner.request(`${root}/projects/${location.id}`);
          assert.ok(location.projection.artBindings.length > 5);
        },
      );
      await t.test(
        'actual core sandbox walks, opens door and transitions without altering shared canon',
        async () => {
          const preview = async (action) =>
            (location = await owner.request(`${root}/projects/${location.id}/preview`, {
              operationId: op(),
              expectedRevision: location.revision,
              action,
            }));
          await owner.request(
            `${root}/projects/${location.id}/preview`,
            {
              operationId: op(),
              expectedRevision: location.revision,
              action: { kind: 'open', targetId: 'atelier-door' },
            },
            'POST',
            409,
          );
          await preview({ kind: 'move_to', target: { x: 13, y: 5 } });
          assert.ok(location.frames.length > 1);
          await preview({ kind: 'open', targetId: 'atelier-door' });
          assert.equal(
            location.projection.entities.find((e) => e.id === 'atelier-door').open,
            true,
          );
          await preview({ kind: 'move_to', target: { x: 14, y: 4 } });
          await preview({ kind: 'transition', targetId: 'to-annex' });
          assert.equal(location.projection.map.id, 'annex');
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int AS n FROM adventure_game_drafts WHERE adventure_id=$1',
                [story.id],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        'explicit apply saves reusable immutable layers; frozen campaign receives authored rules',
        async () => {
          const source = await owner.request(`${root}/stories/${story.id}/source`);
          await owner.request(
            `${root}/packages/${locationPack.id}/apply`,
            { operationId: op(), adventureId: story.id, expectedSourceHash: source.sourceHash },
            'POST',
            400,
          );
          const input = {
            operationId: op(),
            adventureId: story.id,
            expectedSourceHash: source.sourceHash,
            replaceDraft: true,
          };
          await owner.request(`${root}/packages/${locationPack.id}/apply`, input);
          await owner.request(`${root}/packages/${locationPack.id}/apply`, input);
          const draft = await owner.request(`/studio/adventures/${story.id}/playable-draft`);
          assert.equal(draft.draft.turnRules.id, 'dreamwalk-base');
          const art = await owner.request(`/asset-library/stories/${story.id}/draft`);
          const version = await owner.request(`/studio/adventures/${story.id}/playable-versions`, {
            expectedRevision: draft.revision,
            expectedArtRevision: art.revision,
          });
          const { campaignId } = await owner.request('/game/campaigns', {
            playableVersionId: version.versionId,
            heroId: hero.id,
          });
          const p = (await snapshot(owner, campaignId)).projection;
          assert.ok(p.map.composition.layers.length > 0);
          assert.equal(p.turn.ruleset.id, 'dreamwalk-base');
          const manifest = await owner.request(`/asset-library/campaigns/${campaignId}/manifest`);
          assert.ok(manifest.bindings.some((b) => b.slot.includes(':layer:')));
          const state = (
            await db.query('SELECT state FROM game_campaigns WHERE id=$1', [campaignId])
          ).rows[0].state;
          assert.equal(state.narrativePremise.rules, 'No teleportation');
          assert.deepEqual(state.narrativePremise.boundaries, ['No private secrets in narration']);
          assert.equal(
            (await owner.request(`${root}/packages`)).find((p) => p.id === pack.id).parts.length,
            3,
          );
        },
      );
      await t.test(
        'changed source rejects old approval and withdrawn package rejects new equipment',
        async () => {
          const stale = await owner.request(`${root}/projects`, {
            kind: 'location',
            operationId: op(),
            adventureId: story.id,
            brief: {
              name: 'Old canon',
              description: 'A night alchemist atelier with a worktable.',
              style: 'drawn2D',
            },
          });
          await owner.request(
            `/studio/adventures/${story.id}`,
            { synopsis: 'A changed public opening' },
            'PATCH',
          );
          await owner.request(
            `${root}/projects/${stale.id}/approve`,
            { operationId: op(), expectedRevision: stale.revision, consent: true },
            'POST',
            409,
          );
          await owner.request(
            `/asset-library/revisions/${pack.parts.find((p) => p.role === 'sheet').revisionId}/takedown`,
            { operationId: op(), confirm: true },
          );
          await owner.request(
            `${root}/packages/${pack.id}/equip`,
            { operationId: op(), heroId: hero.id },
            'POST',
            409,
          );
          assert.equal(
            (await owner.request(`${root}/packages`)).find((p) => p.id === pack.id).unavailable,
            true,
          );
        },
      );
    } finally {
      await stopApi();
      await db.end();
    }
  },
);
