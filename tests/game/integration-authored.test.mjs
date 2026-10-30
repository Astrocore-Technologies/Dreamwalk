/** Stage A: real Studio → immutable package → private/public campaign authorization. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
  db,
  startApi,
  stopApi,
  client,
  snapshot,
  actor,
  path,
  connect,
  rejectedSocket,
  command,
  operation,
} from './support-runtime.mjs';
import { authoredDraft, storyInput } from './support-authored.mjs';
import {
  exportGameData,
  exportPlayableData,
  purgeGameData,
} from '../../scripts/game-data-requests.mjs';

const draftPath = (id) => `/studio/adventures/${id}/playable-draft`;
const versionsPath = (id) => `/studio/adventures/${id}/playable-versions`;
const availablePath = (id) => `/game/adventures/${id}/playable-versions`;
const create = (c, versionId) => c.request('/game/campaigns', { playableVersionId: versionId });

await test(
  'authored playable snapshots preserve source ACL, moderation and live version immutability',
  { timeout: 90000 },
  async (t) => {
    try {
      await startApi();
      const author = await client().register(),
        guest = await client().register(),
        outsider = await client().register();
      const npc = await author.request('/npcs', {
        name: 'Original gardener',
        description: 'A patient gardener.',
        secrets: 'AUTHORED_PRIVATE_NPC_SECRET',
      });
      const story = await author.request('/studio/adventures', storyInput());
      const draft = authoredDraft(npc.id);
      let versionId, campaignId, invitation;
      await t.test(
        'Studio draft ownership, optimistic revision and actual custom geometry are enforced',
        async () => {
          assert.deepEqual(await author.request(draftPath(story.id)), { draft: null, revision: 0 });
          await outsider.request(draftPath(story.id), undefined, 'GET', 404);
          await outsider.request(draftPath(story.id), { expectedRevision: 0, draft }, 'PUT', 404);
          const saved = await author.request(
            draftPath(story.id),
            { expectedRevision: 0, draft },
            'PUT',
          );
          assert.equal(saved.revision, 1);
          assert.deepEqual(saved.draft, draft);
          await author.request(draftPath(story.id), { expectedRevision: 0, draft }, 'PUT', 409);
          const invalid = structuredClone(draft);
          invalid.maps[0].spawns[0] = { x: 0, y: 0 };
          await author.request(
            draftPath(story.id),
            { expectedRevision: 1, draft: invalid },
            'PUT',
            400,
          );
          const foreignNpc = await outsider.request('/npcs', { name: 'Foreign NPC' });
          const forbidden = structuredClone(draft);
          forbidden.npcs[0].sourceNpcId = foreignNpc.id;
          await author.request(
            draftPath(story.id),
            { expectedRevision: 1, draft: forbidden },
            'PUT',
            403,
          );
          ({ versionId } = await author.request(versionsPath(story.id), { expectedRevision: 1 }));
          assert.ok(versionId);
          await author.request(versionsPath(story.id), { expectedRevision: 2 }, 'POST', 409);
          ({ campaignId } = await create(author, versionId));
          const state = await snapshot(author, campaignId);
          assert.equal(state.projection.map.id, 'courtyard');
          assert.equal(state.projection.map.width, 9);
          assert.deepEqual([actor(state).x, actor(state).y], [2, 2]);
          assert.ok(state.projection.entities.some((e) => e.id === 'authored-key'));
          assert.ok(!JSON.stringify(state).includes('AUTHORED_PRIVATE_NPC_SECRET'));
          assert.ok(!JSON.stringify(state).includes('npcDefinitions'));
          assert.equal(
            (
              await command(
                author,
                campaignId,
                operation({ kind: 'pick_up', targetId: 'authored-key' }),
              )
            ).status,
            'committed',
          );
        },
      );
      await t.test(
        'private source invitation and campaign membership are independent gates',
        async () => {
          await outsider.request(availablePath(story.id), undefined, 'GET', 404);
          await outsider.request('/game/campaigns', { playableVersionId: versionId }, 'POST', 403);
          invitation = await author.request(`/studio/adventures/${story.id}/invitations`, {
            handle: guest.handle,
          });
          await guest.request('/game/campaigns', { playableVersionId: versionId }, 'POST', 403);
          await guest.request(`/invitations/${invitation.id}/respond`, { decision: 'accept' });
          assert.ok(
            (await guest.request(availablePath(story.id))).versions.some((v) => v.id === versionId),
          );
          await guest.request(path(campaignId, 'snapshot'), undefined, 'GET', 403);
          await author.request(path(campaignId, 'invitations'), { username: guest.handle });
          await guest.request(path(campaignId, 'accept'), {});
          assert.equal((await snapshot(guest, campaignId)).projection.map.id, 'courtyard');
          await guest.request(draftPath(story.id), { expectedRevision: 1, draft }, 'PUT', 404);
          const connection = await connect(guest, campaignId),
            closed = once(connection.ws, 'close');
          await author.request(
            `/studio/adventures/${story.id}/invitations/${invitation.id}`,
            {},
            'DELETE',
          );
          const result = await Promise.race([
            closed,
            delay(4000).then(() => {
              throw new Error('Source revoke left socket open');
            }),
          ]);
          assert.equal(result[0], 1008);
          await guest.request(path(campaignId, 'snapshot'), undefined, 'GET', 403);
          assert.equal(await rejectedSocket(guest, campaignId), 403);
          assert.ok(
            !(await guest.request('/game/campaigns')).campaigns.some((c) => c.id === campaignId),
          );
        },
      );
      await t.test(
        'later author map/NPC edits cannot mutate a pinned campaign or frozen package',
        async () => {
          const before = (
            await db.query('SELECT package,checksum FROM game_playable_versions WHERE id=$1', [
              versionId,
            ])
          ).rows[0];
          const changed = structuredClone(draft);
          changed.maps[0].label = 'Changed unpublished courtyard';
          changed.maps[0].spawns[0] = { x: 3, y: 3 };
          changed.objects[0].label = 'Changed key';
          await author.request(draftPath(story.id), { expectedRevision: 1, draft: changed }, 'PUT');
          await author.request(
            `/npcs/${npc.id}`,
            { name: 'Changed gardener', secrets: 'CHANGED_PRIVATE_SECRET' },
            'PATCH',
          );
          const frozen = (
            await db.query('SELECT package,checksum FROM game_playable_versions WHERE id=$1', [
              versionId,
            ])
          ).rows[0];
          assert.deepEqual(frozen, before);
          await assert.rejects(
            db.query("UPDATE game_playable_versions SET package='{}' WHERE id=$1", [versionId]),
            /Immutable playable version/,
          );
          await assert.rejects(
            db.query('DELETE FROM game_playable_versions WHERE id=$1', [versionId]),
            /Immutable playable version/,
          );
          const state = await snapshot(author, campaignId);
          assert.deepEqual([actor(state).x, actor(state).y], [2, 2]);
          assert.equal(state.projection.inventory.filter((e) => e.id === 'authored-key').length, 1);
          await stopApi('SIGKILL');
          await startApi();
          assert.equal(
            (await snapshot(author, campaignId)).projection.inventory.filter(
              (e) => e.id === 'authored-key',
            ).length,
            1,
          );
          const fresh = await author.request(versionsPath(story.id), { expectedRevision: 2 });
          const freshCampaign = await create(author, fresh.versionId);
          assert.deepEqual(
            [
              actor(await snapshot(author, freshCampaign.campaignId)).x,
              actor(await snapshot(author, freshCampaign.campaignId)).y,
            ],
            [3, 3],
          );
        },
      );
      await t.test(
        'public playable versions are exactly moderated immutable submissions, not draft bypasses',
        async () => {
          const publicStory = await author.request('/studio/adventures', storyInput('public'));
          await author.request(draftPath(publicStory.id), { expectedRevision: 0, draft }, 'PUT');
          await author.request(`/studio/adventures/${publicStory.id}/submit`, {});
          const pending = (await author.request(versionsPath(publicStory.id))).versions.find(
            (v) => v.audience === 'review',
          );
          assert.ok(pending);
          await outsider.request(
            `/admin/adventures/${publicStory.id}/playable-review`,
            undefined,
            'GET',
            404,
          );
          await author.request(
            `/admin/adventures/${publicStory.id}/playable-review`,
            undefined,
            'GET',
            404,
          );
          await outsider.request('/game/campaigns', { playableVersionId: pending.id }, 'POST', 403);
          await promisify(execFile)(
            process.execPath,
            ['scripts/admin-grant.mjs', '--email', author.email],
            { env: process.env },
          );
          await author.request(
            `/admin/adventures/${story.id}/playable-review`,
            undefined,
            'GET',
            404,
          );
          const narrativeOnly = await author.request('/studio/adventures', storyInput('public'));
          await author.request(`/studio/adventures/${narrativeOnly.id}/submit`, {});
          assert.deepEqual(
            await author.request(`/admin/adventures/${narrativeOnly.id}/playable-review`),
            { versionId: null, sourceRevision: null, compiled: null },
          );

          const review = await author.request(
            `/admin/adventures/${publicStory.id}/playable-review`,
          );
          assert.equal(review.versionId, pending.id);
          assert.equal(review.sourceRevision, 1);
          assert.equal(review.compiled.startMapId, 'courtyard');
          assert.equal(review.compiled.maps.courtyard.width, 9);
          assert.deepEqual(review.compiled.maps.courtyard.blocked, draft.maps[0].blocked);
          assert.deepEqual(review.compiled.maps.courtyard.spawns, draft.maps[0].spawns);
          assert.equal(review.compiled.entities['authored-key'].label, 'Copper key');
          assert.equal(review.compiled.entities['gardener'].label, 'Gardener');
          assert.deepEqual(review.compiled.roundPolicy, draft.roundPolicy);
          for (const forbidden of [
            'npcBrains',
            'npcDefinitions',
            'AUTHORED_PRIVATE_NPC_SECRET',
            'CHANGED_PRIVATE_SECRET',
            'inventory',
            'nextDecisionTick',
          ])
            assert.ok(!JSON.stringify(review).includes(forbidden));
          await author.request(
            `/admin/adventures/${publicStory.id}/moderate`,
            { decision: 'approve', reason: 'Missing reviewed version must fail' },
            'POST',
            409,
          );
          await author.request(`/admin/adventures/${publicStory.id}/moderate`, {
            decision: 'approve',
            reason: 'Synthetic isolated playable acceptance',
            reviewedPlayableVersionId: pending.id,
          });
          assert.equal(
            (await outsider.request(availablePath(publicStory.id))).versions[0].id,
            pending.id,
          );
          const publicCampaign = await create(outsider, pending.id);
          const revision = structuredClone(draft);
          revision.maps[0].label = 'Not approved';
          revision.maps[0].spawns[0] = { x: 3, y: 3 };
          await author.request(
            draftPath(publicStory.id),
            { expectedRevision: 1, draft: revision },
            'PUT',
          );
          await author.request(`/studio/adventures/${publicStory.id}/submit`, {});
          const pending2 = (await author.request(versionsPath(publicStory.id))).versions.find(
            (v) => v.audience === 'review' && v.id !== pending.id,
          );
          assert.ok(pending2);
          await outsider.request(
            '/game/campaigns',
            { playableVersionId: pending2.id },
            'POST',
            403,
          );
          assert.equal(
            (await outsider.request(availablePath(publicStory.id))).versions[0].id,
            pending.id,
          );
          const old = await snapshot(outsider, publicCampaign.campaignId);
          assert.deepEqual([actor(old).x, actor(old).y], [2, 2]);
          // Saving during pending review must invalidate that submission rather than
          // silently approving a different map than the moderator was asked to inspect.
          revision.maps[0].label = 'Changed after submission';
          await author.request(
            draftPath(publicStory.id),
            { expectedRevision: 2, draft: revision },
            'PUT',
          );
          await author.request(
            `/admin/adventures/${publicStory.id}/moderate`,
            {
              decision: 'approve',
              reason: 'Must reject invalidated submission',
              reviewedPlayableVersionId: pending2.id,
            },
            'POST',
            409,
          );
          await author.request(
            `/admin/adventures/${publicStory.id}/playable-review`,
            undefined,
            'GET',
            404,
          );
          await author.request(`/studio/adventures/${publicStory.id}/submit`, {});
          const pending3 = (await author.request(versionsPath(publicStory.id))).versions.find(
            (v) => v.audience === 'review' && v.id !== pending.id && v.id !== pending2.id,
          );
          assert.ok(pending3);
          const revisedReview = await author.request(
            `/admin/adventures/${publicStory.id}/playable-review`,
          );
          assert.equal(revisedReview.versionId, pending3.id);
          assert.equal(revisedReview.sourceRevision, 3);
          assert.equal(revisedReview.compiled.maps.courtyard.label, 'Changed after submission');
          assert.deepEqual(revisedReview.compiled.maps.courtyard.spawns[0], { x: 3, y: 3 });
          assert.equal(review.compiled.maps.courtyard.label, 'Authored courtyard');

          const staleReview = await author.request(
            `/admin/adventures/${publicStory.id}/moderate`,
            {
              decision: 'approve',
              reason: 'Stale reviewed package must fail',
              reviewedPlayableVersionId: pending2.id,
            },
            'POST',
            409,
          );
          assert.equal(staleReview.code, 'STALE_REVIEW');
          assert.equal(
            (await outsider.request(availablePath(publicStory.id))).versions[0].id,
            pending.id,
          );
          await author.request(`/admin/adventures/${publicStory.id}/moderate`, {
            decision: 'approve',
            reason: 'Synthetic second playable acceptance',
            reviewedPlayableVersionId: pending3.id,
          });
          assert.equal(
            (await outsider.request(availablePath(publicStory.id))).versions[0].id,
            pending3.id,
          );
          const unchanged = await snapshot(outsider, publicCampaign.campaignId);
          assert.deepEqual([actor(unchanged).x, actor(unchanged).y], [2, 2]);
          await outsider.request('/game/campaigns', { playableVersionId: pending.id }, 'POST', 403);
          await outsider.request(
            '/game/campaigns',
            { playableVersionId: pending2.id },
            'POST',
            403,
          );
          const newest = await create(outsider, pending3.id);
          const latest = await snapshot(outsider, newest.campaignId);
          assert.deepEqual([actor(latest).x, actor(latest).y], [3, 3]);
        },
      );
      await t.test(
        'author export stays scoped and confirmed erasure removes pinned source data from other owners',
        async () => {
          await stopApi();
          const c = await db.connect();
          try {
            await c.query('BEGIN');
            const own = await exportPlayableData(c, author.user.id);
            assert.ok(own.drafts.length >= 2 && own.versions.length >= 4);
            assert.ok(JSON.stringify(own).includes('AUTHORED_PRIVATE_NPC_SECRET'));
            assert.deepEqual(await exportPlayableData(c, outsider.user.id), {
              drafts: [],
              versions: [],
            });
            assert.ok(
              !JSON.stringify(await exportGameData(c, outsider.user.id)).includes(
                'AUTHORED_PRIVATE_NPC_SECRET',
              ),
            );
            const pinned = (
              await c.query(
                'SELECT c.id FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id JOIN adventures a ON a.id=v.adventure_id WHERE a.owner_id=$1 AND c.owner_id<>$1',
                [author.user.id],
              )
            ).rows;
            assert.ok(pinned.length >= 1);
            await c.query("SELECT set_config('dreamwalk.erasure','confirmed',true)");
            await c.query('UPDATE users SET deleted_at=now() WHERE id=$1', [author.user.id]);
            await purgeGameData(c, author.user.id);
            for (const { id } of pinned) {
              const row = (
                await c.query('SELECT state,status,runtime_clock FROM game_campaigns WHERE id=$1', [
                  id,
                ])
              ).rows[0];
              assert.equal(row.status, 'paused');
              assert.deepEqual(row.runtime_clock, {});
              assert.deepEqual(row.state, { erased: true });
              assert.equal(
                (await c.query('SELECT 1 FROM game_operations WHERE campaign_id=$1', [id]))
                  .rowCount,
                0,
              );
              for (const snapshot of (
                await c.query('SELECT state FROM game_snapshots WHERE campaign_id=$1', [id])
              ).rows)
                assert.deepEqual(snapshot.state, { erased: true });
              for (const event of (
                await c.query('SELECT payload FROM game_events WHERE campaign_id=$1', [id])
              ).rows)
                assert.deepEqual(event.payload, { erased: true });
            }
            const after = await exportPlayableData(c, author.user.id);
            assert.equal(after.drafts.length, 0);
            assert.ok(after.versions.every((v) => v.package.erased === true));
          } finally {
            await c.query('ROLLBACK');
            c.release();
          }
        },
      );
    } finally {
      await stopApi();
      await db.end();
    }
  },
);
