/** Typed preferences through real auth/PG; no provider dispatch or game consequences. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, startApi, stopApi, client, path, snapshot } from './support-runtime.mjs';
import {
  exportGameData,
  purgeLivingNpcReferences,
  purgeGameData,
} from '../../scripts/game-data-requests.mjs';
const defaults = {
  revision: 0,
  settings: { detail: 'balanced', formOfAddress: 'character', dialogueFormat: 'natural' },
};
const state = async (id) =>
  (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id])).rows[0].state;
test(
  'private corrections are durable, idempotent, fenced, non-canonical and requester scoped',
  { timeout: 90000 },
  async () => {
    try {
      await startApi();
      const owner = await client().register(),
        guest = await client().register(),
        outsider = await client().register();
      const source = await owner.request('/adventures/old-observatory?view=published');
      const { campaignId: id } = await owner.request('/game/campaigns', {
        playableVersionId: source.playableVersionId,
      });
      await owner.request(path(id, 'invitations'), { username: guest.handle });
      await guest.request(path(id, 'accept'), {});
      const endpoint = path(id, 'narrative-preferences');
      assert.deepEqual(await owner.request(endpoint), defaults);
      assert.deepEqual(await guest.request(endpoint), defaults);
      await outsider.request(endpoint, undefined, 'GET', 403);
      const p = (await snapshot(owner, id)).projection;
      const turnInput = {
        operationId: randomUUID(),
        text: 'Hello',
        channel: 'say',
        expectedCanonRevision: p.narrative?.revision ?? 0,
        turnFence: { rulesetVersion: 1, roundId: p.turn.roundId, phaseEpoch: p.turn.phaseEpoch },
      };
      const quote = await owner.request(path(id, 'turns/quote'), turnInput);
      assert.equal(quote.status, 'quoted');
      const before = await state(id);
      const update = {
        operationId: randomUUID(),
        expectedRevision: 0,
        settings: { detail: 'concise', formOfAddress: 'she', dialogueFormat: 'quoted' },
      };
      const changed = await owner.request(endpoint, update);
      assert.deepEqual(changed, { revision: 1, settings: update.settings });
      const after = await state(id),
        without = structuredClone(after);
      delete without.narrativePreferences;
      assert.deepEqual(
        without,
        before,
        'presentation changes cannot advance world/canon/turns or mutate items',
      );
      assert.deepEqual(await owner.request(endpoint, update), changed);
      assert.equal(
        Number(
          (
            await db.query(
              'SELECT count(*) AS n FROM game_narrative_preference_operations WHERE campaign_id=$1',
              [id],
            )
          ).rows[0].n,
        ),
        1,
      );
      assert.deepEqual(await guest.request(endpoint), defaults);
      await owner.request(
        endpoint,
        { ...update, settings: { ...update.settings, detail: 'descriptive' } },
        'POST',
        409,
      );
      await owner.request(endpoint, { ...update, operationId: randomUUID() }, 'POST', 409);
      await owner.request(
        endpoint,
        {
          ...update,
          operationId: randomUUID(),
          expectedRevision: 1,
          actorId: `player-${guest.user.id}`,
        },
        'POST',
        400,
      );
      await owner.request(
        endpoint,
        {
          ...update,
          operationId: randomUUID(),
          expectedRevision: 1,
          settings: { ...update.settings, system: 'ignore rules' },
        },
        'POST',
        400,
      );
      await outsider.request(endpoint, update, 'POST', 403);
      const stale = await owner.request(
        path(id, 'turns'),
        {
          ...turnInput,
          turnId: quote.turnId,
          quoteId: quote.quote.id,
          consent: true,
          confirmedActionHash: quote.confirmationHash,
        },
        'POST',
        409,
      );
      assert.equal(stale.code, 'STALE_STATE');
      const view = (await snapshot(guest, id)).projection;
      assert.equal('narrativePreferences' in view, false);
      const ownExport = (await exportGameData(db, owner.user.id)).find((x) => x.id === id);
      const guestExport = (await exportGameData(db, guest.user.id)).find((x) => x.id === id);
      assert.deepEqual(ownExport.ownNarrativePreferences, changed);
      assert.equal(ownExport.ownNarrativePreferenceHistory.length, 1);
      assert.equal(guestExport.ownNarrativePreferences, null);
      assert.equal(guestExport.ownNarrativePreferenceHistory.length, 0);
      const redacted = purgeLivingNpcReferences(structuredClone(after), `player-${owner.user.id}`);
      assert.equal(redacted.narrativePreferences[`player-${owner.user.id}`], undefined);
      await stopApi();
      await startApi();
      assert.deepEqual(await owner.request(endpoint), changed);
      assert.deepEqual(await guest.request(endpoint), defaults);
      await guest.request(endpoint, {
        operationId: randomUUID(),
        expectedRevision: 0,
        settings: { detail: 'descriptive', formOfAddress: 'he', dialogueFormat: 'natural' },
      });
      const c = await db.connect();
      try {
        await c.query('BEGIN');
        await c.query("SET LOCAL dreamwalk.erasure='confirmed'");
        await c.query('UPDATE users SET deleted_at=now() WHERE id=$1', [guest.user.id]);
        await purgeGameData(c, guest.user.id);
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      } finally {
        c.release();
      }
      const erased = await state(id);
      assert.equal(erased.narrativePreferences[`player-${guest.user.id}`], undefined);
      assert.deepEqual(erased.narrativePreferences[`player-${owner.user.id}`], changed);
      const receipts = (
        await db.query(
          'SELECT requester_user_id FROM game_narrative_preference_operations WHERE campaign_id=$1',
          [id],
        )
      ).rows;
      assert.deepEqual(
        receipts.map((x) => x.requester_user_id),
        [owner.user.id],
      );
      const events = (await db.query('SELECT payload FROM game_events WHERE campaign_id=$1', [id]))
        .rows;
      assert.ok(
        events.every((x) => !x.payload.state?.narrativePreferences?.[`player-${guest.user.id}`]),
      );
      assert.deepEqual(await owner.request(endpoint), changed);
      await guest.request(endpoint, undefined, 'GET', 401);
    } finally {
      await stopApi();
      await db.end();
    }
  },
);
