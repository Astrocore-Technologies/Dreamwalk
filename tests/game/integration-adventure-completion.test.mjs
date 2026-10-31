/** Complete first-party adventure through normal rules, real PostgreSQL and authenticated players. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCompleteObservatoryDraft } from '@dreamwalk/game-core';
import {
  db,
  startApi,
  stopApi,
  client,
  snapshot,
  path,
  command,
  operation,
  moveTo,
  until,
} from './support-runtime.mjs';
import { storyInput } from './support-authored.mjs';
const world = async (id) =>
  (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id])).rows[0].state;
const goal = (s) => s.projection.objectives.find((o) => o.id === 'recover-journal');
async function act(user, id, action) {
  const result = await command(user, id, operation(action));
  assert.equal(result.status, 'committed', JSON.stringify(result.error ?? result));
  return result;
}
async function party(owner, others, version) {
  const { campaignId } = await owner.request('/game/campaigns', { playableVersionId: version });
  for (const user of others) {
    await owner.request(path(campaignId, 'invitations'), { username: user.handle });
    await user.request(path(campaignId, 'accept'), {});
  }
  return campaignId;
}
async function mainStairs(user, id) {
  await moveTo(user, id, { x: 4, y: 6 });
  await act(user, id, { kind: 'pick_up', targetId: 'key' });
  await moveTo(user, id, { x: 9, y: 5 });
  await act(user, id, { kind: 'unlock', targetId: 'door' });
  await act(user, id, { kind: 'open', targetId: 'door' });
  await moveTo(user, id, { x: 13, y: 5 });
  await act(user, id, { kind: 'transition', targetId: 'roof-exit' });
  assert.equal((await snapshot(user, id)).projection.map.id, 'roof');
}
await test(
  'complete Observatory has two lawful routes and one durable shared journal achievement',
  { timeout: 180000 },
  async (t) => {
    try {
      await startApi();
      const users = await Promise.all(Array.from({ length: 4 }, () => client().register()));
      const [a, b, c, d] = users,
        publicStory = await client().request('/adventures/old-observatory?view=published');
      assert.ok(publicStory.playableVersionId, 'Editorial story must really be playable');
      const version = publicStory.playableVersionId;
      let id, winning, winCommand, receipt, achievedTick;
      await t.test(
        'public seed starts a normal pinned version for four authenticated members; hidden criteria and epilogues stay private',
        async () => {
          id = await party(a, [b, c, d], version);
          const state = await world(id),
            definition = state.objectives.find((o) => o.id === 'recover-journal');
          assert.ok(definition);
          for (const user of users) {
            const s = await snapshot(user, id);
            assert.equal(goal(s).status, 'active');
            assert.equal(goal(s).epilogue, undefined);
            assert.ok(!JSON.stringify(s).includes('completion'));
            assert.ok(!JSON.stringify(s).includes('party_owns_item'));
            for (const copy of [definition, ...Object.values(definition.translations)])
              assert.ok(!JSON.stringify(s).includes(copy.epilogue));
            assert.ok(!JSON.stringify(s).includes('npcBrains'));
          }
          assert.equal(state.entities.token.ownerId, 'keeper');
          await a.request(
            path(id, 'commands'),
            {
              ...operation({ kind: 'wait' }),
              objectiveProgress: { 'recover-journal': { achievedTick: 1 } },
            },
            'POST',
            400,
          );
        },
      );
      await t.test(
        'locked exits cannot be bypassed; brass key opens the actual main route',
        async () => {
          await moveTo(a, id, { x: 8, y: 9 });
          const denied = await command(
            a,
            id,
            operation({ kind: 'transition', targetId: 'side-roof-exit' }),
          );
          assert.equal(denied.status, 'rejected');
          await mainStairs(a, id);
          assert.equal(goal(await snapshot(a, id)).status, 'active');
          assert.equal((await snapshot(c, id)).projection.map.id, 'observatory');
          assert.ok(!(await snapshot(c, id)).projection.entities.some((e) => e.id === 'journal'));
          await moveTo(a, id, { x: 6, y: 4 });
          await moveTo(b, id, { x: 13, y: 5 });
          await act(b, id, { kind: 'transition', targetId: 'roof-exit' });
          await moveTo(b, id, { x: 7, y: 3 });
        },
      );
      await t.test(
        'simultaneous journal pickup creates one owner and one completion in commit-before-ack results',
        async () => {
          const ops = [
            operation({ kind: 'pick_up', targetId: 'journal' }),
            operation({ kind: 'pick_up', targetId: 'journal' }),
          ];
          const results = await Promise.all([command(a, id, ops[0]), command(b, id, ops[1])]);
          assert.equal(results.filter((r) => r.status === 'committed').length, 1);
          const i = results.findIndex((r) => r.status === 'committed');
          winning = [a, b][i];
          winCommand = ops[i];
          receipt = results[i];
          assert.equal(receipt.events.filter((e) => e.kind === 'objective.achieved').length, 1);
          assert.equal(goal(receipt).status, 'achieved');
          achievedTick = goal(receipt).achievedTick;
          for (const user of users) {
            const s = await snapshot(user, id);
            assert.equal(goal(s).status, 'achieved');
            assert.equal(goal(s).achievedTick, achievedTick);
            assert.ok(goal(s).epilogue);
          }
          const state = await world(id);
          assert.equal(state.entities.journal.ownerId, `player-${winning.user.id}`);
          assert.equal(Object.keys(state.objectiveProgress).length, 1);
          assert.deepEqual(await command(winning, id, winCommand), receipt);
        },
      );
      await t.test(
        'hard restart and exact action replay retain the same shared ending while exploration continues',
        async () => {
          await stopApi('SIGKILL');
          await startApi();
          assert.deepEqual(await command(winning, id, winCommand), receipt);
          for (const user of users)
            assert.equal(goal(await snapshot(user, id)).achievedTick, achievedTick);
          const later = await act(winning, id, { kind: 'wait' });
          assert.equal(later.events.filter((e) => e.kind === 'objective.achieved').length, 0);
          assert.equal(goal(later).status, 'achieved');
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM game_events e CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.payload->'objectiveEvents','[]'::jsonb)) objective WHERE campaign_id=$1 AND objective->>'kind'='objective.achieved'",
                [id],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        'explicit accepted keeper promise transfers his existing token and opens the independent side route',
        async () => {
          const social = await party(a, [b], version);
          await moveTo(a, social, { x: 5, y: 4 });
          await command(a, social, {
            protocolVersion: 1,
            operationId: randomUUID(),
            type: 'npc.speech',
            npcId: 'keeper',
            speech: { channel: 'whisper', text: 'Please offer your service token for the roof.' },
          });
          const s = await until(
            () => snapshot(a, social),
            (s) =>
              s.projection.npcObligations?.some(
                (p) => p.npcId === 'keeper' && p.status === 'proposed',
              ),
          );
          const promise = s.projection.npcObligations.find(
            (p) => p.npcId === 'keeper' && p.status === 'proposed',
          );
          assert.equal((await world(social)).entities.token.ownerId, 'keeper');
          const wrong = await command(b, social, {
            protocolVersion: 1,
            operationId: randomUUID(),
            type: 'npc.promise',
            npcId: 'keeper',
            promiseId: promise.id,
            decision: 'accept',
          });
          assert.equal(wrong.status, 'rejected');
          const accepted = await command(a, social, {
            protocolVersion: 1,
            operationId: randomUUID(),
            type: 'npc.promise',
            npcId: 'keeper',
            promiseId: promise.id,
            decision: 'accept',
          });
          assert.equal(
            accepted.status,
            'committed',
            `promise response ${accepted.code}; keeper ${JSON.stringify((await world(social)).entities.keeper)}; token owner ${(await world(social)).entities.token.ownerId}`,
          );
          await until(
            () => snapshot(a, social),
            (s) => s.projection.inventory.some((e) => e.id === 'token'),
            12000,
          );
          await moveTo(a, social, { x: 7, y: 8 });
          await act(a, social, { kind: 'unlock', targetId: 'side-door' });
          await act(a, social, { kind: 'open', targetId: 'side-door' });
          await moveTo(a, social, { x: 8, y: 9 });
          await act(a, social, { kind: 'transition', targetId: 'side-roof-exit' });
          await moveTo(a, social, { x: 6, y: 4 });
          const final = await act(a, social, { kind: 'pick_up', targetId: 'journal' });
          assert.equal(goal(final).status, 'achieved');
          const state = await world(social);
          assert.equal(state.entities.door.locked, true);
          assert.equal(state.entities.key.ownerId, undefined);
          assert.equal(state.entities.token.ownerId, `player-${a.user.id}`);
          assert.equal(goal(await snapshot(b, social)).status, 'achieved');
        },
      );
      await t.test('revoked ghost actors cannot satisfy party objectives', async () => {
        const denied = await party(a, [b], version);
        await snapshot(a, denied);
        await stopApi();
        const state = await world(denied),
          ghost = state.entities[`player-${b.user.id}`];
        ghost.inventory ??= [];
        ghost.inventory.push('journal');
        state.entities.journal.ownerId = ghost.id;
        await db.query(
          "UPDATE game_members SET status='revoked' WHERE campaign_id=$1 AND user_id=$2",
          [denied, b.user.id],
        );
        await db.query('UPDATE game_campaigns SET state=$2,revision=revision+1 WHERE id=$1', [
          denied,
          state,
        ]);
        const canonical = (value) =>
          Array.isArray(value)
            ? value.map(canonical)
            : value && typeof value === 'object'
              ? Object.fromEntries(
                  Object.entries(value)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([key, item]) => [key, canonical(item)]),
                )
              : value;
        const checksum = createHash('sha256')
          .update(JSON.stringify(canonical(state)))
          .digest('hex');
        await db.query('UPDATE game_snapshots SET state=$2,checksum=$3 WHERE campaign_id=$1', [
          denied,
          state,
          checksum,
        ]);
        await startApi();
        await act(a, denied, { kind: 'wait' });
        assert.equal(goal(await snapshot(a, denied)).status, 'active');
        await b.request(path(denied, 'snapshot'), undefined, 'GET', 403);
      });
      await t.test('editing author objectives never changes an already pinned save', async () => {
        const story = await a.request('/studio/adventures', storyInput());
        const draft = createCompleteObservatoryDraft();
        await a.request(
          `/studio/adventures/${story.id}/playable-draft`,
          { expectedRevision: 0, draft },
          'PUT',
        );
        const v = await a.request(`/studio/adventures/${story.id}/playable-versions`, {
          expectedRevision: 1,
        });
        const { campaignId } = await a.request('/game/campaigns', {
          playableVersionId: v.versionId,
        });
        const before = goal(await snapshot(a, campaignId)).title;
        draft.objectives[0].title = 'New unpublished objective';
        draft.objectives[0].epilogue = 'UNAPPROVED_ENDING';
        await a.request(
          `/studio/adventures/${story.id}/playable-draft`,
          { expectedRevision: 1, draft },
          'PUT',
        );
        assert.equal(goal(await snapshot(a, campaignId)).title, before);
        assert.ok(!JSON.stringify(await snapshot(a, campaignId)).includes('UNAPPROVED_ENDING'));
      });
      await t.test(
        'moderators inspect pinned objective conditions; outsiders and invalidated submissions cannot',
        async () => {
          const story = await a.request('/studio/adventures', storyInput('public'));
          const draft = createCompleteObservatoryDraft();
          await a.request(
            `/studio/adventures/${story.id}/playable-draft`,
            { expectedRevision: 0, draft },
            'PUT',
          );
          await a.request(`/studio/adventures/${story.id}/submit`, {});
          await b.request(`/admin/adventures/${story.id}/playable-review`, undefined, 'GET', 404);
          await promisify(execFile)(
            process.execPath,
            ['scripts/admin-grant.mjs', '--email', a.email],
            { env: process.env },
          );
          const review = await a.request(`/admin/adventures/${story.id}/playable-review`);
          assert.deepEqual(review.compiled.objectives, draft.objectives);
          assert.ok(!JSON.stringify(review).includes('npcBrains'));
          draft.objectives[0].epilogue = 'NEW_UNREVIEWED_ENDING';
          await a.request(
            `/studio/adventures/${story.id}/playable-draft`,
            { expectedRevision: 1, draft },
            'PUT',
          );
          await a.request(`/admin/adventures/${story.id}/playable-review`, undefined, 'GET', 404);
        },
      );
      await t.test(
        'repeated seed keeps approved playable identity and does not overwrite an edited author draft',
        async () => {
          const count = async () =>
            (
              await db.query(
                'SELECT count(*)::int n FROM game_playable_versions WHERE adventure_id=$1',
                [publicStory.id],
              )
            ).rows[0].n;
          const before = await count();
          await promisify(execFile)(process.execPath, ['apps/api/dist/seed.js'], {
            env: process.env,
          });
          assert.equal(
            (await client().request('/adventures/old-observatory?view=published'))
              .playableVersionId,
            version,
          );
          assert.equal(await count(), before);
          const row = (
            await db.query('SELECT * FROM adventure_game_drafts WHERE adventure_id=$1', [
              publicStory.id,
            ])
          ).rows[0];
          assert.ok(row);
          const edited = structuredClone(row.data ?? row.draft);
          edited.title = 'Author edited preserved map';
          const column = row.data ? 'data' : 'draft';
          await db.query(`UPDATE adventure_game_drafts SET ${column}=$2 WHERE adventure_id=$1`, [
            publicStory.id,
            edited,
          ]);
          await promisify(execFile)(process.execPath, ['apps/api/dist/seed.js'], {
            env: process.env,
          });
          assert.deepEqual(
            (
              await db.query('SELECT * FROM adventure_game_drafts WHERE adventure_id=$1', [
                publicStory.id,
              ])
            ).rows[0][column],
            edited,
          );
          assert.equal(await count(), before);
          assert.equal(
            (await client().request('/adventures/old-observatory?view=published'))
              .playableVersionId,
            version,
          );
        },
      );
    } finally {
      await stopApi();
      await db.end();
    }
  },
);
