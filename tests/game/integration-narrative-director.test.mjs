/** Evolving shared narrative crosses actual auth, durable provider queue and world transaction. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  db,
  startApi,
  stopApi,
  client,
  snapshot,
  moveTo,
  command,
  operation,
  path,
  until,
} from './support-runtime.mjs';
import { createCompleteObservatoryDraft } from '@dreamwalk/game-core';
import { storyInput } from './support-authored.mjs';
import { exportGameData, purgeGameData } from '../../scripts/game-data-requests.mjs';
const state = async (id) =>
  (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id])).rows[0].state;
const narrative = (u, id) => u.request(path(id, 'narrative'));
async function submit(u, id, text, revision) {
  const quote = await u.request(path(id, 'narrative/quote'), {
    text,
    expectedCanonRevision: revision,
  });
  const body = {
    text,
    expectedCanonRevision: revision,
    operationId: randomUUID(),
    quoteId: quote.id,
    consent: true,
  };
  return { body, turn: await u.request(path(id, 'narrative'), body) };
}
async function settled(u, id, turnId) {
  return until(
    () => narrative(u, id),
    (v) => v.turns.some((t) => t.id === turnId && t.status !== 'pending'),
    15000,
  );
}
await test(
  'shared director extends committed canon without rewriting authored source or disclosing private knowledge',
  { timeout: 180000 },
  async (t) => {
    let game, database;
    try {
      await startApi();
      const owner = await client().register(),
        guest = await client().register(),
        outsider = await client().register();
      const story = await owner.request('/studio/adventures', storyInput());
      const draft = createCompleteObservatoryDraft();
      draft.narrativeConstraints = {
        allowNewScenes: true,
        allowNewNpcs: true,
        maxScenes: 8,
        maxSupportingNpcs: 8,
        maxTurns: 16,
        protectedFacts: [{ id: 'clock-rule', text: 'The observatory clock shows a countdown.' }],
        forbiddenRoles: ['canonical ruler'],
      };
      await owner.request(
        `/studio/adventures/${story.id}/playable-draft`,
        { expectedRevision: 0, draft },
        'PUT',
      );
      const version = await owner.request(`/studio/adventures/${story.id}/playable-versions`, {
        expectedRevision: 1,
      });
      const sourceBefore = (
        await db.query('SELECT checksum,package FROM game_playable_versions WHERE id=$1', [
          version.versionId,
        ])
      ).rows[0];
      const { campaignId: id } = await owner.request('/game/campaigns', {
        playableVersionId: version.versionId,
      });
      const invitation = await owner.request(`/studio/adventures/${story.id}/invitations`, {
        handle: guest.handle,
      });
      await guest.request(`/invitations/${invitation.id}/respond`, { decision: 'accept' });
      await owner.request(path(id, 'invitations'), { username: guest.handle });
      await guest.request(path(id, 'accept'), {});
      let first, firstTurn, second;
      await t.test(
        'accepted player input enters existing consent and durable queue; outsiders cannot observe or submit',
        async () => {
          await outsider.request(path(id, 'narrative'), undefined, 'GET', 403);
          await outsider.request(
            path(id, 'narrative/quote'),
            { text: 'Explore', expectedCanonRevision: 0 },
            'POST',
            403,
          );
          await owner.request(
            path(id, 'narrative'),
            {
              text: 'Explore',
              expectedCanonRevision: 0,
              operationId: randomUUID(),
              consent: false,
            },
            'POST',
            403,
          );
          first = await submit(owner, id, 'We search for a new reachable room and a witness.', 0);
          const result = await settled(owner, id, first.turn.id);
          firstTurn = result.turns.find((v) => v.id === first.turn.id);
          assert.equal(firstTurn.status, 'committed', JSON.stringify(firstTurn));
          assert.equal(result.canonRevision, 1);
          assert.ok(firstTurn.sceneId);
          assert.ok(firstTurn.npcId);
          assert.equal(
            (await narrative(guest, id)).turns.find((v) => v.id === firstTurn.id).narration,
            firstTurn.narration,
          );
          const w = await state(id);
          assert.ok(w.maps[firstTurn.sceneId]);
          assert.ok(w.entities[firstTurn.npcId]);
          assert.equal(w.narrativeCanon.turns.length, 1);
          assert.deepEqual(
            (
              await db.query('SELECT checksum,package FROM game_playable_versions WHERE id=$1', [
                version.versionId,
              ])
            ).rows[0],
            sourceBefore,
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM npc_ai_jobs WHERE campaign_id=$1 AND purpose='narrative'",
                [id],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        'new room is reachable both ways; generated NPC has a fresh minimal brain rather than inherited secrets',
        async () => {
          const w = await state(id),
            link = w.maps.observatory.exits.find((e) => e.destinationMapId === firstTurn.sceneId);
          await moveTo(owner, id, { x: link.x, y: link.y });
          assert.equal(
            (await command(owner, id, operation({ kind: 'transition', targetId: link.id }))).status,
            'committed',
          );
          assert.equal((await snapshot(owner, id)).projection.map.id, firstTurn.sceneId);
          const brain = (await state(id)).npcBrains[firstTurn.npcId];
          assert.deepEqual((await state(id)).entities[firstTurn.npcId].inventory, []);
          assert.ok(!JSON.stringify(brain).includes('PRIVATE_WHISPER'));
          const back = (await state(id)).maps[firstTurn.sceneId].exits[0];
          await moveTo(owner, id, { x: back.x, y: back.y });
          assert.equal(
            (await command(owner, id, operation({ kind: 'transition', targetId: back.id }))).status,
            'committed',
          );
          await moveTo(owner, id, { x: link.x, y: link.y });
          assert.equal(
            (await command(owner, id, operation({ kind: 'transition', targetId: link.id }))).status,
            'committed',
          );
          assert.equal((await snapshot(owner, id)).projection.map.id, firstTurn.sceneId);
        },
      );
      await t.test(
        'second participant extends current confirmed canon; source role catalog is not a ceiling',
        async () => {
          await owner.request(
            `/studio/adventures/${story.id}`,
            {
              title: 'UNPUBLISHED_NEW_TITLE',
              content: { ...storyInput().content, world: 'UNPUBLISHED_NEW_WORLD' },
            },
            'PATCH',
          );
          second = await submit(
            guest,
            id,
            'Following the confirmed discovery, find another useful place and person.',
            1,
          );
          const v = await settled(guest, id, second.turn.id),
            turn = v.turns.find((x) => x.id === second.turn.id);
          assert.equal(turn.status, 'committed', JSON.stringify(turn));
          assert.equal(v.canonRevision, 2);
          assert.notEqual(turn.sceneId, firstTurn.sceneId);
          assert.notEqual(turn.npcId, firstTurn.npcId);
          const job = (
            await db.query(
              "SELECT context FROM npc_ai_jobs WHERE campaign_id=$1 AND purpose='narrative' ORDER BY created_at DESC LIMIT 1",
              [id],
            )
          ).rows[0];
          assert.equal(job.context.canonRevision, 1);
          assert.deepEqual(job.context.premise, sourceBefore.package.compiled.narrativePremise);
          assert.equal(job.context.premise.title, storyInput().title);
          assert.equal(job.context.premise.summary, storyInput().synopsis);
          assert.equal(job.context.premise.world, storyInput().content.world);
          assert.deepEqual(job.context.sourceVersion, {
            versionId: version.versionId,
            checksum: sourceBefore.checksum,
          });
          assert.ok(!JSON.stringify(job.context).includes('UNPUBLISHED_NEW'));
          assert.ok(job.context.confirmedTurns.some((v) => v.id === firstTurn.id));
          assert.ok(!('npcBrains' in job.context));
          assert.ok(!('observations' in job.context));
        },
      );
      await t.test(
        'same operation replays one world commit and crash recovery retains both confirmed turns',
        async () => {
          const before = await state(id);
          const replay = await owner.request(path(id, 'narrative'), first.body);
          assert.equal(replay.id, firstTurn.id);
          assert.equal(replay.status, 'committed');
          await owner.request(
            path(id, 'narrative'),
            { ...first.body, text: 'Different intent' },
            'POST',
            409,
          );
          await owner.request(
            path(id, 'narrative/quote'),
            { text: 'Old revision', expectedCanonRevision: 0 },
            'POST',
            409,
          );
          await stopApi('SIGKILL');
          await startApi();
          assert.equal((await narrative(owner, id)).canonRevision, 2);
          assert.equal(
            (await narrative(guest, id)).turns.filter((v) => v.status === 'committed').length,
            2,
          );
          const after = await state(id);
          assert.deepEqual(after.narrativeCanon, before.narrativeCanon);
          assert.deepEqual(
            (
              await db.query('SELECT checksum,package FROM game_playable_versions WHERE id=$1', [
                version.versionId,
              ])
            ).rows[0],
            sourceBefore,
          );
        },
      );
      await t.test(
        'media preparation derives only current confirmed map and visible NPC, without generation or charges',
        async () => {
          const count = async () =>
            (await db.query('SELECT count(*)::int n FROM image_generation_jobs')).rows[0].n;
          const before = await count();
          const prepared = await owner.request(path(id, 'media-preparation'), {
            kind: 'background',
          });
          assert.equal(prepared.grounding.mapId, firstTurn.sceneId);
          assert.equal(prepared.grounding.sourceVersionId, version.versionId);
          assert.equal(prepared.canonRevision, 2);
          assert.equal(prepared.automaticDispatch, false);
          assert.equal(prepared.createsGameEntities, false);
          assert.equal(prepared.providerCalls, 0);
          assert.equal(prepared.charge, 0);
          assert.match(prepared.prompt, /Never invent an interactable/);
          assert.equal(await count(), before);
          const portrait = await owner.request(path(id, 'media-preparation'), {
            kind: 'portrait',
            entityId: firstTurn.npcId,
          });
          assert.equal(portrait.grounding.subject.id, firstTurn.npcId);
          await guest.request(
            path(id, 'media-preparation'),
            { kind: 'portrait', entityId: firstTurn.npcId },
            'POST',
            404,
          );
          await outsider.request(
            path(id, 'media-preparation'),
            { kind: 'background' },
            'POST',
            403,
          );
        },
      );
      await t.test(
        'confirmed member erasure removes derived narrative prose/replays but preserves shared topology and another inventory',
        async () => {
          const exportedOwner = (await exportGameData(db, owner.user.id)).find((v) => v.id === id);
          const exportedGuest = (await exportGameData(db, guest.user.id)).find((v) => v.id === id);
          assert.deepEqual(
            exportedOwner.ownNarrativeTurns.map((v) => v.id),
            [firstTurn.id],
          );
          assert.deepEqual(
            exportedGuest.ownNarrativeTurns.map((v) => v.id),
            [second.turn.id],
          );
          const back = (await state(id)).maps[firstTurn.sceneId].exits[0];
          await moveTo(owner, id, { x: back.x, y: back.y });
          assert.equal(
            (await command(owner, id, operation({ kind: 'transition', targetId: back.id }))).status,
            'committed',
          );
          await moveTo(owner, id, { x: 4, y: 6 });
          assert.equal(
            (await command(owner, id, operation({ kind: 'pick_up', targetId: 'key' }))).status,
            'committed',
          );
          const replayCommand = operation({ kind: 'wait' });
          await command(owner, id, replayCommand);
          const before = await state(id);
          await stopApi();
          const tx = await db.connect();
          try {
            await tx.query('BEGIN');
            await tx.query("SELECT set_config('dreamwalk.erasure','confirmed',true)");
            await tx.query('UPDATE users SET deleted_at=now() WHERE id=$1', [guest.user.id]);
            await purgeGameData(tx, guest.user.id);
            await tx.query('COMMIT');
          } catch (e) {
            await tx.query('ROLLBACK');
            throw e;
          } finally {
            tx.release();
          }
          const after = await state(id);
          assert.equal(after.entities.key.ownerId, `player-${owner.user.id}`);
          assert.deepEqual(
            after.maps[firstTurn.sceneId].blocked,
            before.maps[firstTurn.sceneId].blocked,
          );
          assert.deepEqual(
            after.maps[firstTurn.sceneId].exits.map((e) => [e.id, e.destinationMapId]),
            before.maps[firstTurn.sceneId].exits.map((e) => [e.id, e.destinationMapId]),
          );
          for (const [table, column] of [
            ['game_campaigns', 'state'],
            ['game_snapshots', 'state'],
            ['game_operations', 'result'],
          ]) {
            const rows = (
              await db.query(
                `SELECT ${column} FROM ${table} WHERE ${table === 'game_campaigns' ? 'id' : 'campaign_id'}=$1`,
                [id],
              )
            ).rows;
            assert.ok(!JSON.stringify(rows).includes(firstTurn.narration));
          }
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM game_narrative_turns WHERE campaign_id=$1',
                [id],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int n FROM game_narrative_media WHERE campaign_id=$1',
                [id],
              )
            ).rows[0].n,
            0,
          );
          await startApi();
          assert.ok(
            !JSON.stringify(await command(owner, id, replayCommand)).includes(firstTurn.narration),
          );
          await owner.request(path(id, 'narrative'), first.body, 'POST', 409);
          await guest.request(path(id, 'narrative'), undefined, 'GET', 401);
        },
      );
    } finally {
      if (game) await game.onModuleDestroy();
      await stopApi();
      if (database) await database.pool.end();
      await db.end();
    }
  },
);
