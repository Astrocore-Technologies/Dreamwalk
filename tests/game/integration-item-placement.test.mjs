/** KAN-32: real disposable PostgreSQL/authenticated transport. No external provider or browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  db,
  startApi,
  stopApi,
  client,
  snapshot,
  path,
  operation,
  command,
  until,
} from './support-runtime.mjs';
import { authoredDraft, storyInput } from './support-authored.mjs';
const require = createRequire(import.meta.url);
const g = require('../../packages/game-core/dist');
const sharp = require('sharp');
const { digest } = require('../../apps/api/dist/ai/context.js');
const { Db } = require('../../apps/api/dist/db.js');
const { Auth } = require('../../apps/api/dist/auth.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const { PlayableService } = require('../../apps/api/dist/game/playable.service.js');
const { GameService } = require('../../apps/api/dist/game/game.service.js');
const { GameController } = require('../../apps/api/dist/game/game.controller.js');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');

const itemId = 'authored-key';
const artSlot = `entity:${itemId}:object:default`;
const state = async (id) =>
  (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id])).rows[0].state;
const itemDetails = (item) => ({
  id: item.id,
  label: item.label,
  visual: item.visual,
  item: item.item && {
    definitionId: item.item.definitionId,
    quantity: item.item.quantity,
    portable: item.item.portable,
    edible: item.item.edible,
    restoreVitality: item.item.restoreVitality,
    visual: item.item.visual,
  },
});
const itemState = () => ({
  definitionId: 'copper-key',
  quantity: 2,
  portable: true,
  edible: false,
  restoreVitality: 0,
  visual: 'object',
});
const artFor = (p) => p.artBindings.find((binding) => binding.slot === artSlot);
const jobs = async (id) => {
  const result = await db.query(
    `SELECT (SELECT count(*)::int FROM npc_ai_jobs WHERE campaign_id=$1) AS ai,
      (SELECT count(*)::int FROM game_npc_jobs WHERE campaign_id=$1) AS legacy,
      (SELECT count(*)::int FROM game_npc_decision_requests WHERE campaign_id=$1) AS decisions`,
    [id],
  );
  return result.rows[0];
};
async function saveFixture(id, value) {
  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('UPDATE game_campaigns SET state=$2 WHERE id=$1', [
      id,
      JSON.stringify(value),
    ]);
    await connection.query('UPDATE game_snapshots SET state=$2,checksum=$3 WHERE campaign_id=$1', [
      id,
      JSON.stringify(value),
      digest(value),
    ]);
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}
async function createArt(owner) {
  // A generated local color swatch verifies immutable raster identity, not art quality.
  const bytes = await sharp({
    create: { width: 32, height: 32, channels: 4, background: '#a77d37' },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/png' }), 'item-fixture.png');
  const response = await fetch(process.env.TEST_GAME_API_URL + '/assets', {
    method: 'POST',
    headers: { cookie: owner.cookie, origin: process.env.WEB_ORIGIN },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 201);
  const upload = await response.json();
  return owner.request('/asset-library/revisions', {
    operationId: randomUUID(),
    uploadId: upload.id,
    metadata: {
      title: 'Synthetic item raster',
      kind: 'object',
      style: 'drawn2D',
      camera: 'top-down',
      tags: ['local-test'],
      variant: 'default',
      provenance: { source: 'upload', reference: 'Synthetic offline test fixture' },
      rights: {
        basis: 'owned',
        licenseLabel: 'Synthetic fixture',
        attribution: '',
        allowAuthorReuse: true,
        attested: true,
      },
    },
  });
}
async function createCampaigns(owner, guest) {
  const story = await owner.request('/studio/adventures', storyInput('private'));
  const draft = authoredDraft();
  draft.maps = [{ ...draft.maps[0], exits: [] }];
  draft.objects = [draft.objects[0]];
  draft.npcs = [];
  draft.npcBehavior = 'reactive-v1';
  const saved = await owner.request(
    `/studio/adventures/${story.id}/playable-draft`,
    { expectedRevision: 0, draft },
    'PUT',
  );
  const art = await createArt(owner);
  const bound = await owner.request(
    `/asset-library/stories/${story.id}/draft`,
    {
      operationId: randomUUID(),
      expectedRevision: 0,
      bindings: [{ slot: artSlot, revisionId: art.id }],
    },
    'PUT',
  );
  const fresh = await owner.request(`/studio/adventures/${story.id}`);
  const released = await owner.request(`/studio/adventures/${story.id}/private-release`, {
    operationId: randomUUID(),
    expectedEditRevision: fresh.editRevision,
    expectedGameRevision: saved.revision,
    expectedArtRevision: bound.revision,
  });
  const sourceInvite = await owner.request(`/studio/adventures/${story.id}/invitations`, {
    handle: guest.handle,
  });
  await guest.request(`/invitations/${sourceInvite.id}/respond`, { decision: 'accept' });
  const main = await owner.request('/game/campaigns', {
    turnBased: false,
    playableVersionId: released.playableVersionId,
  });
  await owner.request(path(main.campaignId, 'invitations'), { username: guest.handle });
  await guest.request(path(main.campaignId, 'accept'), {});
  const sequential = await owner.request('/game/campaigns', {
    playableVersionId: released.playableVersionId,
  });
  return { main: main.campaignId, sequential: sequential.campaignId, art };
}

await test(
  'owned item placement is authorized, durable and exactly once through authenticated HTTP',
  { timeout: 120000 },
  async (t) => {
    let game, database;
    try {
      await startApi();
      const owner = await client().register(),
        guest = await client().register(),
        outsider = await client().register(),
        anonymous = client();
      const ids = await createCampaigns(owner, guest);
      const actorId = (await snapshot(owner, ids.main)).projection.actorId;
      const storyOwner = await client().registerLegacyFixture();
      const source = await storyOwner.request('/adventures/old-observatory?view=published');
      const storyCampaign = await storyOwner.request('/game/campaigns', {
        turnBased: false,
        playableVersionId: source.playableVersionId,
      });
      // Add finite world-item metadata only while the fixture API is stopped. Both
      // snapshots retain the published object and its real, authorized art binding.
      await stopApi();
      for (const id of [ids.main, ids.sequential]) {
        const value = await state(id);
        value.entities[itemId].item = itemState();
        if (id === ids.sequential) {
          value.entities[itemId].ownerId = actorId;
          value.entities[actorId].inventory = [itemId];
        }
        await saveFixture(id, value);
      }
      await startApi();
      const taken = await command(
        owner,
        ids.main,
        operation({ kind: 'pick_up', targetId: itemId }),
      );
      assert.equal(taken.status, 'committed', taken.code);
      const original = itemDetails(taken.projection.inventory.find((item) => item.id === itemId));
      const originalArt = artFor(taken.projection);
      assert.equal(original.item.quantity, 2);
      assert.equal(originalArt.revisionId, ids.art.id);
      assert.deepEqual(await jobs(ids.main), { ai: 0, legacy: 0, decisions: 0 });
      const target = g.itemDropCandidates(await state(ids.main), actorId, itemId)[0];
      assert.ok(target);
      const drop = operation({ kind: 'drop', targetId: itemId, target });
      const receiptCount = async (operationId) =>
        (
          await db.query(
            'SELECT count(*)::int n FROM game_operations WHERE campaign_id=$1 AND actor_id=$2 AND operation_id=$3',
            [ids.main, actorId, operationId],
          )
        ).rows[0].n;
      const assertGround = async () => {
        const value = await state(ids.main);
        assert.equal(value.entities[itemId].ownerId, undefined);
        assert.equal(value.entities[itemId].mapId, value.entities[actorId].mapId);
        assert.deepEqual({ x: value.entities[itemId].x, y: value.entities[itemId].y }, target);
        assert.deepEqual(itemDetails(value.entities[itemId]), original);
        assert.equal(Object.values(value.entities).filter((item) => item.id === itemId).length, 1);
        for (const entity of Object.values(value.entities))
          assert.ok(!entity.inventory?.includes(itemId));
        const p = (await snapshot(owner, ids.main)).projection;
        assert.equal(p.entities.filter((item) => item.id === itemId).length, 1);
        assert.ok(!p.inventory.some((item) => item.id === itemId));
        assert.deepEqual(artFor(p), originalArt);
      };
      await t.test(
        'anonymous, nonmember and another member cannot drop the owner item',
        async () => {
          await anonymous.request(path(ids.main, 'commands'), drop, 'POST', 401);
          await outsider.request(path(ids.main, 'commands'), drop, 'POST', 403);
          const denied = await command(guest, ids.main, drop);
          assert.equal(denied.status, 'rejected');
          assert.equal(denied.code, 'FORBIDDEN');
          assert.equal((await state(ids.main)).entities[itemId].ownerId, actorId);
          assert.equal(await receiptCount(drop.operationId), 0);
        },
      );
      await t.test(
        'concurrent replay commits one placement and preserves the existing entity',
        async () => {
          const receipts = await Promise.all([
            command(owner, ids.main, drop),
            command(owner, ids.main, drop),
          ]);
          assert.deepEqual(receipts[0], receipts[1]);
          assert.equal(receipts[0].status, 'committed');
          assert.equal(
            receipts[0].events.filter((event) => event.kind === 'item.placed').length,
            1,
          );
          assert.equal(await receiptCount(drop.operationId), 1);
          await assertGround();
          const foreignProjection = (await snapshot(guest, ids.main)).projection;
          assert.equal(foreignProjection.entities.filter((item) => item.id === itemId).length, 1);
          assert.deepEqual(artFor(foreignProjection), originalArt);
          await owner.request(
            path(ids.main, 'commands'),
            { ...drop, action: { ...drop.action, target: { x: target.x + 1, y: target.y } } },
            'POST',
            409,
          );
          await assertGround();
        },
      );
      await t.test(
        'lost response survives process restart and take-back keeps identity, art and quantity',
        async () => {
          const picked = await command(
            owner,
            ids.main,
            operation({ kind: 'pick_up', targetId: itemId }),
          );
          assert.equal(picked.status, 'committed');
          assert.deepEqual(itemDetails(picked.projection.inventory[0]), original);
          const lost = operation(drop.action);
          const response = await fetch(process.env.TEST_GAME_API_URL + path(ids.main, 'commands'), {
            method: 'POST',
            headers: {
              cookie: owner.cookie,
              origin: process.env.WEB_ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify(lost),
            signal: AbortSignal.timeout(15000),
          });
          assert.equal(response.status, 201);
          // Deliberately discard the committed response body; the reconnect must use
          // the durable operation receipt, not any cached client state.
          await response.body.cancel();
          await stopApi('SIGKILL');
          await startApi();
          await assertGround();
          const stored = (
            await db.query(
              'SELECT result FROM game_operations WHERE campaign_id=$1 AND actor_id=$2 AND operation_id=$3',
              [ids.main, actorId, lost.operationId],
            )
          ).rows[0].result;
          assert.deepEqual(await command(owner, ids.main, lost), stored);
          assert.equal(await receiptCount(lost.operationId), 1);
          await assertGround();
          const takeBack = operation({ kind: 'pick_up', targetId: itemId });
          const receipts = await Promise.all([
            command(owner, ids.main, takeBack),
            command(owner, ids.main, takeBack),
          ]);
          assert.deepEqual(receipts[0], receipts[1]);
          assert.equal(receipts[0].status, 'committed');
          await stopApi();
          await startApi();
          const p = (await snapshot(owner, ids.main)).projection;
          assert.equal(p.inventory.filter((item) => item.id === itemId).length, 1);
          assert.deepEqual(itemDetails(p.inventory.find((item) => item.id === itemId)), original);
          assert.deepEqual(artFor(p), originalArt);
          assert.equal((await state(ids.main)).entities[itemId].ownerId, actorId);
          assert.deepEqual(await jobs(ids.main), { ai: 0, legacy: 0, decisions: 0 });
        },
      );
      await t.test(
        'free player drop preserves resources and replay never duplicates it',
        async () => {
          const before = (await snapshot(owner, ids.sequential)).projection;
          assert.equal(before.turn.resources.additional, 1);
          const target = g.itemDropCandidates(await state(ids.sequential), actorId, itemId)[0];
          const body = {
            ...operation({ kind: 'drop', targetId: itemId, target }),
            turnFence: {
              roundId: before.turn.roundId,
              phaseEpoch: before.turn.phaseEpoch,
              rulesetVersion: 1,
            },
          };
          const committed = await command(owner, ids.sequential, body);
          assert.equal(committed.status, 'committed');
          assert.deepEqual(committed.projection.turn.resources, before.turn.resources);
          assert.equal(committed.projection.turn.resources.main, before.turn.resources.main);
          assert.deepEqual(await command(owner, ids.sequential, body), committed);
          assert.deepEqual(await jobs(ids.sequential), { ai: 0, legacy: 0, decisions: 0 });
        },
      );
      await t.test(
        'synthetic semantic RP drop commits without a second confirmation or external provider call',
        async () => {
          await stopApi();
          database = new Db();
          const pending = new Map();
          let calls = 0;
          const ai = new NpcAiEngine(
            database,
            {
              id: `item-drop-fixture-${randomUUID()}`,
              version: 'v1',
              external: false,
              generate: (request) => {
                calls++;
                return new Promise((resolve) => pending.set(request.jobId, { request, resolve }));
              },
            },
            { timeoutMs: 20000 },
          );
          const auth = new Auth(database),
            art = new AssetReuseService(database);
          game = new GameService(database, auth, new PlayableService(database, auth, art), ai, art);
          clearInterval(game.timer);
          const controller = new GameController(game);
          const request = { headers: { cookie: storyOwner.cookie } };
          const id = storyCampaign.campaignId;
          const actorId = (await controller.snapshot(request, id)).projection.actorId;
          const live = game.live.get(id);
          Object.assign(live.state.entities[actorId], { x: 5, y: 4, inventory: ['key'] });
          Object.assign(live.state.entities.key, { ownerId: actorId, item: itemState() });
          for (const brain of Object.values(live.state.npcBrains)) {
            brain.plan = [];
            brain.cursor = 0;
            brain.nextDecisionTick = 999999;
          }
          await game.persist(id, live, live.state, 'test.item-drop.fixture');
          const original = itemDetails(live.state.entities.key);
          const originalItemIds = Object.values(live.state.entities)
            .filter((item) => item.kind === 'item')
            .map((item) => item.id)
            .sort();
          const target = g.itemDropCandidates(live.state, actorId, 'key')[0];
          assert.ok(target);
          const input = {
            operationId: randomUUID(),
            text: '*I lower the brass key from my pocket onto the ground beside me*',
            channel: 'say',
            expectedCanonRevision: live.state.narrativeCanon?.revision ?? 0,
          };
          const quote = await controller.storyQuote(request, id, input);
          assert.equal(quote.status, 'quoted');
          assert.equal(
            quote.actionPreview.length,
            0,
            'The handwritten semantic proposal must resolve RP without a deterministic action preview',
          );
          const submit = { ...input, turnId: quote.turnId, quoteId: quote.quote.id, consent: true };
          const queued = await controller.storySubmit(request, id, submit);
          assert.equal(queued.status, 'queued');
          await game.processDecisionRequests(id, live);
          const decision = await until(
            async () =>
              (
                await db.query('SELECT job_id FROM game_npc_decision_requests WHERE id=$1', [
                  queued.id,
                ])
              ).rows[0],
            (row) => !!row?.job_id,
          );
          await until(async () => pending.has(decision.job_id), Boolean);
          const provider = pending.get(decision.job_id);
          const candidate = provider.request.context.itemPlacementPolicy.segmentCandidates
            .find((segment) => segment.segmentIndex === 0)
            ?.items.find((item) => item.id === 'key');
          assert.ok(
            candidate?.points.some((point) => point.x === target.x && point.y === target.y),
          );
          const proposal = structuredClone(provider.request.context.mockProposal);
          proposal.status = 'ready';
          proposal.code = null;
          proposal.steps = [
            { segmentIndex: 0, action: { kind: 'drop', targetId: 'key', target }, reply: null },
          ];
          proposal.narrative = {
            narration: 'The brass key rests on the ground beside the player.',
            newScene: null,
            newNpc: null,
            evidenceIds: [],
          };
          provider.resolve({
            proposal,
            requestId: `synthetic-${decision.job_id}`,
            usage: { inputTokens: 1, outputTokens: 1, costMicros: 0 },
          });
          await until(
            async () =>
              (await db.query('SELECT status FROM npc_ai_jobs WHERE id=$1', [decision.job_id]))
                .rows[0],
            (row) => row.status === 'result_received',
          );
          await game.processAi(id, live);
          const result = (await db.query('SELECT * FROM game_story_turns WHERE id=$1', [queued.id]))
            .rows[0];
          assert.equal(result.status, 'committed');
          assert.equal(calls, 1);
          assert.equal((await controller.storySubmit(request, id, submit)).status, 'committed');
          game.live.delete(id);
          const reloaded = (await controller.snapshot(request, id)).projection;
          assert.ok(!reloaded.inventory.some((item) => item.id === 'key'));
          assert.deepEqual(
            itemDetails(reloaded.entities.find((item) => item.id === 'key')),
            original,
          );
          const durable = await state(id);
          assert.equal(durable.entities.key.ownerId, undefined);
          assert.deepEqual({ x: durable.entities.key.x, y: durable.entities.key.y }, target);
          assert.deepEqual(
            Object.values(durable.entities)
              .filter((item) => item.kind === 'item')
              .map((item) => item.id)
              .sort(),
            originalItemIds,
          );
          assert.equal(
            calls,
            1,
            'Commit, replay and reload must not dispatch another provider request',
          );
          const feed = await controller.storyFeed(request, id);
          assert.equal(
            feed.entries.filter(
              (entry) =>
                entry.turnId === queued.id &&
                entry.kind === 'outcome' &&
                entry.code === 'ACTION_SUCCEEDED',
            ).length,
            1,
          );
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
