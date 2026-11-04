import { releasePrivateFixture } from './support-authored.mjs';
/** Real PostgreSQL acceptance for explicit opt-in sequential Dreamwalk turns. No provider network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  db,
  startApi,
  stopApi,
  client,
  snapshot,
  actor,
  path,
  until,
  command,
} from './support-runtime.mjs';
const op = () => randomUUID();
const fence = (p) => ({
  roundId: p.turn.roundId,
  phaseEpoch: p.turn.phaseEpoch,
  rulesetVersion: 1,
});
const input = (projection, type, extra = {}) => ({
  protocolVersion: 1,
  operationId: op(),
  type,
  turnFence: fence(projection),
  ...extra,
});
const state = async (id) =>
  (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id])).rows[0].state;
async function move(c, id, target) {
  const s = await snapshot(c, id),
    a = actor(s);
  return c.request(path(id, 'move'), {
    operationId: op(),
    turnFence: fence(s.projection),
    connectionEpoch: s.connectionEpoch,
    inputSeq: (a.lastInputSeq ?? 0) + 1,
    movementGeneration: a.movementGeneration ?? 0,
    target,
  });
}
async function post(c, id, text, targetNpcId, channel = 'say', replyLocale) {
  const p = (await snapshot(c, id)).projection;
  const body = {
    operationId: op(),
    text,
    channel,
    expectedCanonRevision: p.narrative?.revision ?? 0,
    turnFence: fence(p),
    ...(targetNpcId ? { targetNpcId } : {}),
    ...(replyLocale ? { replyLocale } : {}),
  };
  const quote = await c.request(path(id, 'turns/quote'), body);
  assert.equal(quote.status, 'quoted', quote.code);
  const submitted = {
    ...body,
    turnId: quote.turnId,
    quoteId: quote.quote.id,
    consent: true,
    confirmedActionHash: quote.confirmationHash,
  };
  if (replyLocale) {
    const conflict = await c.request(
      path(id, 'turns'),
      { ...submitted, replyLocale: replyLocale === 'en' ? 'uk' : 'en' },
      'POST',
      409,
    );
    assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
    const stored = (
      await db.query('SELECT input FROM game_story_turns WHERE id=$1', [quote.turnId])
    ).rows[0].input;
    assert.equal(stored.replyLocale, replyLocale);
    const withoutLocale = { ...submitted };
    delete withoutLocale.replyLocale;
    // Older confirmation clients must retain the quote's language rather than
    // replacing it with the account preference read at confirmation time.
    await c.request(path(id, 'turns'), withoutLocale);
  }
  const receipt = await c.request(path(id, 'turns'), submitted);
  return { quote, receipt, submitted };
}
async function fixture(owner, guest) {
  const story = await owner.request('/studio/adventures', { title: 'Sequential dialogue fixture' });
  const draft = {
    schemaVersion: 1,
    title: 'Sequential fixture',
    npcBehavior: 'reactive-v1',
    startMapId: 'room',
    turnRules: { movement: 12 },
    maps: [
      {
        id: 'room',
        label: 'Rain room',
        width: 24,
        height: 24,
        blocked: [],
        spawns: [
          { x: 2, y: 2 },
          { x: 3, y: 2 },
          { x: 2, y: 3 },
          { x: 3, y: 3 },
        ],
        exits: [],
      },
    ],
    objects: [
      {
        id: 'first-token',
        kind: 'item',
        label: 'First token',
        mapId: 'room',
        x: 5,
        y: 4,
        visual: 'token',
      },
      {
        id: 'second-token',
        kind: 'item',
        label: 'Second token',
        mapId: 'room',
        x: 5,
        y: 2,
        visual: 'token',
      },
    ],
    npcs: [
      {
        id: 'first-npc',
        label: 'Mira',
        mapId: 'room',
        x: 4,
        y: 3,
        visual: 'keeper',
        goal: 'patrol',
        patrolTarget: { x: 8, y: 6 },
        personality: {
          role: 'helper',
          values: ['kindness'],
          taboos: ['disclose_private'],
          speechStyle: 'patient',
          publicSpeechStyle: 'warm',
        },
      },
      {
        id: 'second-npc',
        label: 'Tarin',
        mapId: 'room',
        x: 6,
        y: 3,
        visual: 'traveler',
        goal: 'patrol',
        patrolTarget: { x: 7, y: 6 },
        personality: {
          role: 'guard',
          values: ['duty'],
          taboos: ['disclose_private'],
          speechStyle: 'terse',
          publicSpeechStyle: 'terse',
        },
      },
    ],
    narrativeConstraints: {
      allowNewScenes: true,
      allowNewNpcs: true,
      maxScenes: 16,
      maxSupportingNpcs: 16,
      maxTurns: 256,
      protectedFacts: [],
      forbiddenRoles: [],
    },
    roundPolicy: { maxRounds: 5, planningMs: 30000 },
  };
  await owner.request(
    `/studio/adventures/${story.id}/playable-draft`,
    { expectedRevision: 0, draft },
    'PUT',
  );
  const { playableVersionId: versionId } = await releasePrivateFixture(owner, story.id);
  const { campaignId } = await owner.request('/game/campaigns', { playableVersionId: versionId });
  const invitation = await owner.request(`/studio/adventures/${story.id}/invitations`, {
    handle: guest.handle,
  });
  await guest.request(`/invitations/${invitation.id}/respond`, { decision: 'accept' });
  await owner.request(path(campaignId, 'invitations'), { username: guest.handle });
  await guest.request(path(campaignId, 'accept'), {});
  return campaignId;
}
await test(
  'sequential turns preserve immediate mechanics, deferred ordered NPC dialogue and durable budgets',
  { timeout: 120000 },
  async (t) => {
    try {
      await startApi();
      const owner = await client().register(),
        guest = await client().register(),
        outsider = await client().register();
      const id = await fixture(owner, guest);
      let firstPost, endCommand, roundOne;
      await t.test(
        'new authored preset is pinned; legacy campaigns retain compatibility',
        async () => {
          const p = (await snapshot(owner, id)).projection;
          assert.equal(p.turn.phase, 'player');
          assert.equal(p.turn.activeActorId, p.actorId);
          assert.equal(p.turn.resources.movement, 12);
          const legacy = await owner.request('/game/campaigns', { template: 'observatory-v1' });
          assert.equal((await snapshot(owner, legacy.campaignId)).projection.turn, undefined);
          await outsider.request(path(id, 'snapshot'), undefined, 'GET', 403);
        },
      );
      await t.test(
        'walking is immediately committed, bounded and shares durable receipt sequence',
        async () => {
          const before = await snapshot(owner, id),
            a = actor(before);
          const body = {
            operationId: op(),
            turnFence: fence(before.projection),
            connectionEpoch: before.connectionEpoch,
            inputSeq: (a.lastInputSeq ?? 0) + 1,
            movementGeneration: a.movementGeneration ?? 0,
            target: { x: 3, y: 3 },
          };
          const moved = await owner.request(path(id, 'move'), body);
          assert.equal(moved.status, 'committed');
          assert.deepEqual([actor(moved).x, actor(moved).y], [3, 3]);
          assert.equal(moved.projection.turn.resources.movement, 10);
          assert.deepEqual(await owner.request(path(id, 'move'), body), moved);
          assert.equal((await state(id)).entities[before.projection.actorId].x, 3);
          const other = (await snapshot(guest, id)).projection;
          const denied = await command(
            guest,
            id,
            input(other, 'action', { action: { kind: 'wait' } }),
          );
          assert.equal(denied.status, 'rejected');
          assert.equal(denied.code, 'WRONG_MODE');
        },
      );
      await t.test(
        'two distinct addressed messages queue with order and do not move or answer during player phase',
        async () => {
          // Stand within whisper range of Mira, but outside the nearby player's range.
          // A whisper at (3,3) is legitimately overheard by the guest at (3,2).
          await move(owner, id, { x: 4, y: 4 });
          firstPost = await post(
            owner,
            id,
            'PRIVATE_WHISPER_FIRST_NPC',
            'first-npc',
            'whisper',
            'uk',
          );
          await owner.request('/account/settings', { language: 'en' }, 'PATCH');
          assert.equal(firstPost.receipt.status, 'committed');
          assert.equal(firstPost.receipt.code, 'NPC_REPLY_DEFERRED');
          await move(owner, id, { x: 5, y: 3 });
          const second = await post(
            owner,
            id,
            'Hello Tarin, we are looking for shelter.',
            'second-npc',
            'say',
            'ru',
          );
          assert.equal(second.receipt.status, 'committed');
          assert.equal(
            (await owner.request(path(id, 'turns'), firstPost.submitted)).id,
            firstPost.receipt.id,
          );
          const frozen = await state(id);
          // Whisper reaches only Mira; the subsequent public speech reaches both nearby NPCs.
          assert.equal(frozen.turnController.deferredSpeech.length, 3);
          const queuedLanguages = (
            await db.query(
              "SELECT npc_id,context->>'replyLocale' AS locale FROM game_npc_decision_requests WHERE campaign_id=$1 AND purpose='speech' ORDER BY context->>'turnOrder'",
              [id],
            )
          ).rows;
          assert.deepEqual(queuedLanguages, [
            { npc_id: 'first-npc', locale: 'uk' },
            { npc_id: 'first-npc', locale: 'ru' },
            { npc_id: 'second-npc', locale: 'ru' },
          ]);
          assert.deepEqual(
            frozen.turnController.deferredSpeech.map((s) => s.recipientId),
            ['first-npc', 'first-npc', 'second-npc'],
          );
          await delay(350);
          await snapshot(owner, id);
          const after = await state(id);
          assert.deepEqual(after.entities['first-npc'], frozen.entities['first-npc']);
          assert.deepEqual(after.entities['second-npc'], frozen.entities['second-npc']);
          assert.equal(after.tick, frozen.tick);
          assert.ok(
            !(await owner.request(path(id, 'turns/feed'))).entries.some(
              (e) => e.kind === 'npc_reply',
            ),
          );
          assert.ok(
            !JSON.stringify(await guest.request(path(id, 'turns/feed'))).includes(
              'PRIVATE_WHISPER_FIRST_NPC',
            ),
          );
        },
      );
      await t.test(
        'click and text use one additional-action budget and failed attempts never claim success',
        async () => {
          let p = (await snapshot(owner, id)).projection;
          const take = await command(
            owner,
            id,
            input(p, 'action', { action: { kind: 'pick_up', targetId: 'first-token' } }),
          );
          assert.equal(take.status, 'committed');
          assert.equal(take.projection.turn.resources.additional, 0);
          const attempt = await post(owner, id, '*take second-token*');
          assert.equal(attempt.receipt.status, 'committed');
          const feed = await owner.request(path(id, 'turns/feed'));
          assert.ok(
            feed.entries.some(
              (e) =>
                e.turnId === attempt.receipt.id &&
                e.kind === 'outcome' &&
                e.code === 'ROUND_LOCKED',
            ),
          );
          assert.equal((await state(id)).entities['second-token'].ownerId, undefined);
          p = (await snapshot(owner, id)).projection;
          const bad = await command(
            owner,
            id,
            input(p, 'action', { action: { kind: 'hit', targetId: 'missing' } }),
          );
          assert.equal(bad.status, 'rejected');
          assert.equal(bad.projection.turn.resources.main, 1);
        },
      );
      await t.test(
        'End Turn selects second player; replay and stale fences cannot skip or spend',
        async () => {
          const p = (await snapshot(owner, id)).projection;
          roundOne = p.turn.roundId;
          endCommand = input(p, 'turn.end');
          const ended = await command(owner, id, endCommand);
          assert.equal(ended.status, 'committed');
          assert.equal(ended.projection.turn.activeActorId, `player-${guest.user.id}`);
          assert.equal((await command(owner, id, endCommand)).operationId, endCommand.operationId);
          const stale = await command(owner, id, input(p, 'action', { action: { kind: 'wait' } }));
          assert.equal(stale.status, 'rejected');
          const persisted = await state(id);
          assert.equal(persisted.turnController.activeActorId, `player-${guest.user.id}`);
          assert.equal(persisted.turnController.deferredSpeech.length, 3);
        },
      );
      await t.test(
        'restart restores active player, remaining budgets and both exact addresses',
        async () => {
          const before = (await state(id)).turnController;
          await stopApi();
          await startApi();
          const p = (await snapshot(owner, id)).projection;
          assert.equal(p.turn.activeActorId, `player-${guest.user.id}`);
          assert.equal(p.turn.pendingNpcReplies.length, 2);
          const after = (await state(id)).turnController;
          assert.deepEqual(after.resources, before.resources);
          assert.deepEqual(after.deferredSpeech, before.deferredSpeech);
          await delay(150);
          assert.equal((await state(id)).turnController.activeActorId, `player-${guest.user.id}`);
        },
      );
      await t.test(
        'only final player End Turn releases ordered NPC replies and finite world actions',
        async () => {
          const p = (await snapshot(guest, id)).projection;
          const ended = await command(guest, id, input(p, 'turn.end'));
          assert.equal(ended.status, 'committed');
          await until(
            () => snapshot(owner, id),
            (s) => s.projection.turn.phase === 'player' && s.projection.turn.roundId !== roundOne,
            15000,
          );
          const current = await state(id);
          assert.equal(current.turnController.deferredSpeech.length, 0);
          assert.equal(current.turnController.activeActorId, `player-${owner.user.id}`);
          const replies = (await owner.request(path(id, 'turns/feed'))).entries.filter(
            (e) => e.kind === 'npc_reply',
          );
          assert.equal(replies.length, 3);
          assert.deepEqual(
            replies.map((e) => e.authorId),
            ['first-npc', 'first-npc', 'second-npc'],
          );
          assert.deepEqual(
            replies.map((entry) => entry.text),
            [
              'Я вас чую. Продовжуйте, будь ласка.',
              'Я вас слышу. Продолжайте, пожалуйста.',
              'Я вас слышу. Продолжайте, пожалуйста.',
            ],
          );
          assert.ok(
            !JSON.stringify(await guest.request(path(id, 'turns/feed'))).includes(
              'PRIVATE_WHISPER_FIRST_NPC',
            ),
          );
          const generatedLanguages = (
            await db.query(
              "SELECT npc_id,context->>'replyLocale' AS locale,status FROM npc_ai_jobs WHERE campaign_id=$1 AND purpose='speech' ORDER BY context->>'turnOrder'",
              [id],
            )
          ).rows;
          assert.deepEqual(generatedLanguages, [
            { npc_id: 'first-npc', locale: 'uk', status: 'committed' },
            { npc_id: 'first-npc', locale: 'ru', status: 'committed' },
            { npc_id: 'second-npc', locale: 'ru', status: 'committed' },
          ]);
          const jobs = (
            await db.query('SELECT count(*)::int AS n FROM npc_ai_jobs WHERE campaign_id=$1', [id])
          ).rows[0].n;
          await delay(250);
          await snapshot(owner, id);
          assert.equal(
            (
              await db.query('SELECT count(*)::int AS n FROM npc_ai_jobs WHERE campaign_id=$1', [
                id,
              ])
            ).rows[0].n,
            jobs,
          );
        },
      );
      await t.test(
        'player reactions persist and duplicate attacks do not double consume resources',
        async () => {
          const fight = await fixture(owner, guest),
            p = (await snapshot(owner, fight)).projection;
          const hit = input(p, 'action', {
              action: { kind: 'hit', targetId: `player-${guest.user.id}` },
            }),
            pending = await command(owner, fight, hit);
          assert.equal(pending.status, 'committed');
          assert.equal(pending.projection.turn.phase, 'reaction');
          const blocked = await command(owner, fight, input(pending.projection, 'turn.end'));
          assert.equal(blocked.status, 'rejected');
          await stopApi();
          await startApi();
          const react = (await snapshot(guest, fight)).projection;
          assert.equal(react.turn.phase, 'reaction');
          const defense = await command(
            guest,
            fight,
            input(react, 'turn.reaction', { decision: 'defend' }),
          );
          assert.equal(defense.status, 'committed');
          assert.equal(defense.projection.turn.resources.reaction, 0);
          const resolved = (await snapshot(owner, fight)).projection;
          assert.equal(resolved.turn.phase, 'player');
          assert.equal(resolved.turn.resources.main, 0);
          await command(owner, fight, hit);
          assert.equal((await snapshot(owner, fight)).projection.turn.resources.main, 0);
        },
      );
      await t.test(
        'authored legacy geometry cannot silently become a different adventure',
        async () => {
          const story = await owner.request('/studio/adventures', {
            title: 'Legacy authored river room',
          });
          const draft = {
            schemaVersion: 1,
            title: 'River room',
            startMapId: 'river',
            maps: [
              {
                id: 'river',
                label: 'Custom river room',
                width: 7,
                height: 6,
                blocked: [],
                spawns: [{ x: 1, y: 1 }],
                exits: [],
              },
            ],
            objects: [],
            npcs: [],
            roundPolicy: { maxRounds: 5, planningMs: 30000 },
          };
          // A genuinely preexisting map remains editable; fresh API imports now require24.
          await db.query(
            'INSERT INTO adventure_game_drafts(adventure_id,revision,draft) VALUES($1,1,$2)',
            [story.id, JSON.stringify(draft)],
          );
          await owner.request(
            `/studio/adventures/${story.id}/playable-draft`,
            { expectedRevision: 1, draft },
            'PUT',
          );
          const { versionId } = await owner.request(
            `/studio/adventures/${story.id}/playable-versions`,
            { expectedRevision: 2 },
          );
          const rejected = await owner.request(
            '/game/campaigns',
            { playableVersionId: versionId, turnBased: true },
            'POST',
            409,
          );
          assert.equal(rejected.code, 'TURN_RULESET_UPGRADE_REQUIRED');
          const omitted = await owner.request(
            '/game/campaigns',
            { playableVersionId: versionId },
            'POST',
            409,
          );
          assert.equal(omitted.code, 'TURN_RULESET_UPGRADE_REQUIRED');
          const { campaignId } = await owner.request('/game/campaigns', {
            playableVersionId: versionId,
            turnBased: false,
          });
          assert.equal((await snapshot(owner, campaignId)).projection.map.id, 'river');
        },
      );
      await t.test(
        'a plain click hit schedules at most one personality-plan decision per NPC world phase',
        async () => {
          const harm = await fixture(owner, guest);
          await move(owner, harm, { x: 3, y: 3 });
          let p = (await snapshot(owner, harm)).projection;
          const hit = await command(
            owner,
            harm,
            input(p, 'action', { action: { kind: 'hit', targetId: 'first-npc' } }),
          );
          assert.equal(hit.status, 'committed');
          const before = await state(harm);
          assert.ok(
            before.npcBrains['first-npc'].living.observations.some((o) => o.kind === 'harmed'),
          );
          const attempts = (
            await db.query(
              "SELECT count(*)::int AS n FROM game_npc_decision_requests WHERE campaign_id=$1 AND purpose='plan'",
              [harm],
            )
          ).rows[0].n;
          assert.equal(attempts, 0);
          p = (await snapshot(owner, harm)).projection;
          await command(owner, harm, input(p, 'turn.end'));
          p = (await snapshot(guest, harm)).projection;
          await command(guest, harm, input(p, 'turn.end'));
          await until(
            () => snapshot(owner, harm),
            (value) =>
              value.projection.turn.phase === 'player' && value.projection.turn.roundNumber === 2,
            10000,
          );
          const rows = (
            await db.query(
              "SELECT npc_id,context FROM game_npc_decision_requests WHERE campaign_id=$1 AND purpose='plan'",
              [harm],
            )
          ).rows;
          assert.equal(rows.filter((r) => r.npc_id === 'first-npc').length, 1);
          assert.ok(rows.some((r) => JSON.stringify(r.context).includes('harmed')));
        },
      );
      await t.test(
        'an NPC world attack interrupts for a persisted player reaction and resumes its finite world phase once',
        async () => {
          const world = await fixture(owner, guest);
          await move(owner, world, { x: 3, y: 3 });
          await stopApi();
          const staged = await state(world);
          staged.npcBrains['first-npc'].plan = [
            { kind: 'hit', targetId: `player-${owner.user.id}` },
          ];
          staged.npcBrains['first-npc'].cursor = 0;
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
            .update(JSON.stringify(canonical(staged)))
            .digest('hex');
          await db.query('UPDATE game_campaigns SET state=$2,revision=revision+1 WHERE id=$1', [
            world,
            JSON.stringify(staged),
          ]);
          await db.query('UPDATE game_snapshots SET state=$2,checksum=$3 WHERE campaign_id=$1', [
            world,
            JSON.stringify(staged),
            checksum,
          ]);
          await startApi();
          let p = (await snapshot(owner, world)).projection;
          await command(owner, world, input(p, 'turn.end'));
          p = (await snapshot(guest, world)).projection;
          await command(guest, world, input(p, 'turn.end'));
          await until(
            () => snapshot(owner, world),
            (value) => value.projection.turn.phase === 'reaction',
            8000,
          );
          await stopApi();
          await startApi();
          p = (await snapshot(owner, world)).projection;
          assert.equal(p.turn.phase, 'reaction');
          const decline = input(p, 'turn.reaction', { decision: 'decline' });
          const resolved = await command(owner, world, decline);
          assert.equal(resolved.status, 'committed');
          assert.equal(resolved.projection.turn.phase, 'world');
          await command(owner, world, decline);
          await until(
            () => snapshot(owner, world),
            (value) =>
              value.projection.turn.phase === 'player' && value.projection.turn.roundNumber === 2,
            8000,
          );
          const final = await state(world);
          assert.equal(final.entities[`player-${owner.user.id}`].vitality, 5);
        },
      );
      await t.test(
        'untargeted roleplay attempts commit player intent now and continue canon only in the world phase',
        async () => {
          const storyWorld = await fixture(owner, guest);
          const submitted = await post(
            owner,
            storyWorld,
            '*I investigate a faint signal beyond the rain room.*',
          );
          assert.equal(submitted.receipt.status, 'committed');
          let feed = await owner.request(path(storyWorld, 'turns/feed'));
          assert.equal(feed.configuration.provider, 'local-turn-resolver');
          assert.equal(feed.configuration.creditPrice, 0);
          assert.ok(!feed.entries.some((entry) => entry.kind === 'narration'));
          let p = (await snapshot(owner, storyWorld)).projection;
          await command(owner, storyWorld, input(p, 'turn.end'));
          p = (await snapshot(guest, storyWorld)).projection;
          await command(guest, storyWorld, input(p, 'turn.end'));
          await until(
            () => owner.request(path(storyWorld, 'turns/feed')),
            (value) => value.entries.some((entry) => entry.kind === 'narration'),
            12000,
          );
          await until(
            () => snapshot(owner, storyWorld),
            (value) =>
              value.projection.turn.phase === 'player' && value.projection.turn.roundNumber === 2,
            8000,
          );
          feed = await owner.request(path(storyWorld, 'turns/feed'));
          assert.equal(
            feed.entries.filter(
              (entry) =>
                entry.kind === 'attempt' &&
                entry.text === 'I investigate a faint signal beyond the rain room.',
            ).length,
            1,
          );
          assert.ok((await state(storyWorld)).narrativeCanon.turns.length > 0);
        },
      );
    } finally {
      await stopApi();
      await db.end();
    }
  },
);
