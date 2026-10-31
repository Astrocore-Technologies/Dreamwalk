/** Real COMMIT/publication interleaving must not turn a healthy socket into another-tab control. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client } from './support-runtime.mjs';
const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db.js');
const { Auth } = require('../../apps/api/dist/auth.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const { PlayableService } = require('../../apps/api/dist/game/playable.service.js');
const { GameService } = require('../../apps/api/dist/game/game.service.js');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
const database = new Db();
await test(
  'local checkpoint publication preserves control while external checkpoints remain authoritative',
  { timeout: 30000 },
  async () => {
    let game, release;
    try {
      await startApi();
      const user = await client().register();
      const { campaignId: id } = await user.request('/game/campaigns', {
        template: 'observatory-v1',
      });
      await stopApi();
      const auth = new Auth(database),
        art = new AssetReuseService(database),
        playable = new PlayableService(database, auth, art);
      game = new GameService(database, auth, playable, new NpcAiEngine(database), art);
      clearInterval(game.timer);
      const req = { headers: { cookie: user.cookie } };
      const lease = await game.connected(req, id);
      const live = game.live.get(id);
      const realTx = database.tx.bind(database);
      let committed;
      const commitReached = new Promise((r) => {
        committed = r;
      });
      const gate = new Promise((r) => {
        release = r;
      });
      let armed = true;
      database.tx = async (work) => {
        const result = await realTx(work);
        if (armed) {
          armed = false;
          committed();
          await gate;
        }
        return result;
      };
      const saving = game.serial(id, () =>
        game.persist(id, live, structuredClone(live.state), 'test.publication.gate'),
      );
      await commitReached;
      // This is an ordinary non-writer HTTP service method, not an injected cache access.
      let readSettled = false;
      const reading = game.members(req, id).finally(() => {
        readSettled = true;
      });
      await new Promise((r) => setTimeout(r, 75));
      const retainedWhilePublishing = game.live.get(id) === live;
      const readWaitedForPublication = !readSettled;
      release();
      await Promise.all([saving, reading]);
      database.tx = realTx;
      assert.equal(readWaitedForPublication, true, 'members must await local publication');
      const after = await game.snapshot(req, id, false);
      assert.equal(
        retainedWhilePublishing,
        true,
        'members poll evicted a locally committed checkpoint before cache publication',
      );
      assert.equal(
        after.connectionEpoch,
        lease.connectionEpoch,
        'healthy control lease must survive own durable commit',
      );
      const own = after.projection.entities.find((e) => e.id === lease.actorId);
      const input = {
        connectionEpoch: lease.connectionEpoch,
        inputSeq: own.lastInputSeq + 1,
        movementGeneration: own.movementGeneration,
        target: { x: own.x + 1, y: own.y },
      };
      const moved = await game.move(req, id, input);
      assert.equal(moved.connectionEpoch, lease.connectionEpoch);
      const replacement = await game.connected(req, id);
      assert.notEqual(replacement.connectionEpoch, lease.connectionEpoch);
      await assert.rejects(
        game.move(req, id, input),
        (error) => error.getResponse?.().code === 'STALE_STATE',
      );
      // External privacy/admin writers still win; persisted state has no hot-only private canary.
      game.live.get(id).state.entities[lease.actorId].label = 'ERASED_CACHE_CANARY';
      await db.query('UPDATE game_campaigns SET revision=revision+1 WHERE id=$1', [id]);
      await game.members(req, id);
      assert.notEqual(
        game.live.get(id),
        live,
        'new external checkpoint must invalidate stale cached private data',
      );
      const safe = await game.snapshot(req, id, false);
      assert.equal(JSON.stringify(safe).includes('ERASED_CACHE_CANARY'), false);
      const rollbackLive = game.live.get(id);
      const revisionBeforeRollback = rollbackLive.dbRevision;
      await assert.rejects(
        game.serial(id, () =>
          game.persist(
            id,
            rollbackLive,
            structuredClone(rollbackLive.state),
            'test.rollback',
            undefined,
            async () => {
              throw new Error('EXPECTED_ROLLBACK');
            },
          ),
        ),
        /EXPECTED_ROLLBACK/,
      );
      assert.equal(
        Number(
          (await db.query('SELECT revision FROM game_campaigns WHERE id=$1', [id])).rows[0]
            .revision,
        ),
        revisionBeforeRollback,
      );
      // A failed publication must not leave a pending fence that deadlocks the next authoritative read.
      await db.query('UPDATE game_campaigns SET revision=revision+1 WHERE id=$1', [id]);
      let timeout;
      try {
        await Promise.race([
          game.members(req, id),
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('publication fence leaked after rollback')),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      assert.notEqual(game.live.get(id), rollbackLive);
    } finally {
      release?.();
      if (game) await game.onModuleDestroy();
      await stopApi();
      await database.pool.end();
      await db.end();
    }
  },
);
