/** Owned hero selection is a private, immutable per-member campaign snapshot. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  db,
  startApi,
  stopApi,
  client,
  snapshot,
  actor,
  path,
  command,
  operation,
} from './support-runtime.mjs';
import { fixturePng } from '../images/support.mjs';
import { exportGameData, purgeGameData } from '../../scripts/game-data-requests.mjs';

await test(
  'owned heroes are pinned to campaigns without leaking personal preparation',
  { timeout: 90000 },
  async (t) => {
    try {
      await startApi();
      const owner = await client().register(),
        guest = await client().register(),
        outsider = await client().register();
      const form = new FormData();
      form.append('file', new Blob([await fixturePng()], { type: 'image/png' }), 'hero.png');
      const uploaded = await fetch(process.env.TEST_GAME_API_URL + '/assets', {
        method: 'POST',
        headers: { cookie: owner.cookie, origin: process.env.WEB_ORIGIN },
        body: form,
      });
      assert.equal(uploaded.status, 201);
      const portraitId = (await uploaded.json()).id;
      const hero = await owner.request('/heroes', {
        portraitAssetId: portraitId,
        name: 'Pinned explorer',
        backstory: 'OWNER_PRIVATE_HISTORY',
        notes: 'OWNER_PRIVATE_NOTES',
        traits: ['Patient'],
      });
      const guestHero = await guest.request('/heroes', {
        name: 'Guest scholar',
        backstory: 'GUEST_PRIVATE_HISTORY',
        notes: 'GUEST_PRIVATE_NOTES',
      });
      let campaignId;
      await t.test(
        'creation checks hero ownership and pins only the requesting player',
        async () => {
          await outsider.request(
            '/game/campaigns',
            { template: 'observatory-v1', heroId: hero.id },
            'POST',
            404,
          );
          ({ campaignId } = await owner.request('/game/campaigns', {
            template: 'observatory-v1',
            heroId: hero.id,
          }));
          const own = await owner.request(path(campaignId, 'hero'));
          assert.equal(own.hero.name, hero.name);
          assert.equal(own.hero.notes, 'OWNER_PRIVATE_NOTES');
          assert.equal(actor(await snapshot(owner, campaignId)).label, hero.name);
          await outsider.request(path(campaignId, 'hero'), undefined, 'GET', 403);
        },
      );
      await t.test(
        'each invited player can select only their own hero and cannot switch afterward',
        async () => {
          await owner.request(path(campaignId, 'invitations'), { username: guest.handle });
          await guest.request(path(campaignId, 'accept'), { heroId: hero.id }, 'POST', 404);
          await guest.request(path(campaignId, 'accept'), { heroId: guestHero.id });
          assert.equal((await guest.request(path(campaignId, 'hero'))).hero.name, guestHero.name);
          const another = await guest.request('/heroes', { name: 'Replacement scholar' });
          await guest.request(path(campaignId, 'accept'), { heroId: another.id }, 'POST', 409);
          const shared = JSON.stringify(await snapshot(guest, campaignId));
          assert.ok(shared.includes('Pinned explorer'));
          for (const secret of [
            'OWNER_PRIVATE_HISTORY',
            'OWNER_PRIVATE_NOTES',
            'GUEST_PRIVATE_HISTORY',
            'GUEST_PRIVATE_NOTES',
          ])
            assert.ok(!shared.includes(secret));
        },
      );
      await t.test(
        'portrait delivery is campaign scoped and revocation preserves the immutable choice',
        async () => {
          const portraitUrl = (await owner.request(path(campaignId, 'hero'))).hero.portraitUrl;
          const fetchPortrait = (who) =>
            fetch(new URL(portraitUrl, process.env.TEST_GAME_API_URL), {
              headers: { cookie: who.cookie },
            });
          const permitted = await fetchPortrait(guest);
          assert.equal(permitted.status, 200);
          assert.match(permitted.headers.get('content-type'), /image\/webp/);
          assert.equal((await fetchPortrait(outsider)).status, 403);
          const privateSource = await fetch(
            process.env.TEST_GAME_API_URL + '/assets/' + portraitId,
            { headers: { cookie: guest.cookie } },
          );
          assert.equal(privateSource.status, 404);
          await owner.request(path(campaignId, 'members/' + guest.user.id), {}, 'DELETE');
          assert.equal((await fetchPortrait(guest)).status, 403);
          await owner.request(path(campaignId, 'invitations'), { username: guest.handle });
          await guest.request(path(campaignId, 'accept'), {});
          assert.equal((await guest.request(path(campaignId, 'hero'))).hero.name, 'Guest scholar');
          assert.equal((await fetchPortrait(guest)).status, 200);
        },
      );
      await t.test(
        'editing or deleting the source does not rewrite an existing snapshot; restart retains it',
        async () => {
          await owner.request(
            `/heroes/${hero.id}`,
            { name: 'Changed source', notes: 'Changed notes' },
            'PATCH',
          );
          await owner.request(`/heroes/${hero.id}`, {}, 'DELETE');
          await stopApi('SIGKILL');
          await startApi();
          assert.equal(
            (await owner.request(path(campaignId, 'hero'))).hero.name,
            'Pinned explorer',
          );
          assert.equal(actor(await snapshot(owner, campaignId)).label, 'Pinned explorer');
          const ownExport = await exportGameData(db, owner.user.id);
          assert.equal(
            ownExport.find((c) => c.id === campaignId).ownHero.snapshot.notes,
            'OWNER_PRIVATE_NOTES',
          );
          assert.ok(
            !JSON.stringify(await exportGameData(db, guest.user.id)).includes(
              'OWNER_PRIVATE_NOTES',
            ),
          );
        },
      );
      await t.test(
        'legacy traveler campaigns stay compatible and cannot gain a late hero',
        async () => {
          const { campaignId: legacy } = await owner.request('/game/campaigns', {
            template: 'observatory-v1',
          });
          assert.deepEqual(await owner.request(path(legacy, 'hero')), { hero: null });
          const replacement = await owner.request('/heroes', { name: 'Later choice' });
          await owner.request(path(legacy, 'accept'), { heroId: replacement.id }, 'POST', 409);
        },
      );
      await t.test(
        'confirmed account erasure clears hero snapshots and retained public identities',
        async () => {
          const result = await command(
            guest,
            campaignId,
            operation({ kind: 'inspect', targetId: 'keeper' }),
          );
          assert.ok(result);
          await stopApi();
          const tx = await db.connect();
          try {
            await tx.query('BEGIN');
            await tx.query("SELECT set_config('dreamwalk.erasure','confirmed',true)");
            await purgeGameData(tx, owner.user.id);
            await tx.query('COMMIT');
          } catch (error) {
            await tx.query('ROLLBACK');
            throw error;
          } finally {
            tx.release();
          }
          assert.equal(
            Number(
              (
                await db.query('SELECT count(*) FROM game_member_heroes WHERE user_id=$1', [
                  owner.user.id,
                ])
              ).rows[0].count,
            ),
            0,
          );
          for (const [table, field] of [
            ['game_campaigns', 'state'],
            ['game_events', 'payload'],
            ['game_snapshots', 'state'],
            ['game_operations', 'result'],
          ]) {
            const rows = (
              await db.query(
                `SELECT ${field} FROM ${table} WHERE ${table === 'game_campaigns' ? 'id' : 'campaign_id'}=$1`,
                [campaignId],
              )
            ).rows;
            assert.ok(!JSON.stringify(rows).includes('Pinned explorer'), table);
            assert.ok(!JSON.stringify(rows).includes('OWNER_PRIVATE_NOTES'), table);
          }
          assert.equal(
            (
              await db.query(
                'SELECT snapshot FROM game_member_heroes WHERE campaign_id=$1 AND user_id=$2',
                [campaignId, guest.user.id],
              )
            ).rows[0].snapshot.name,
            'Guest scholar',
          );
        },
      );
    } finally {
      await stopApi();
      await db.end();
    }
  },
);
