/** Execute the production scheduler selector against disposable, read-only PG fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { db } from './support-runtime.mjs';
const require = createRequire(import.meta.url);
const { orderedTurnRequestsSql } = require('../../apps/api/dist/game/turn-request-order');
const prefix = `WITH game_npc_decision_requests AS (
  SELECT * FROM jsonb_to_recordset($3::jsonb) AS r(
    id text,campaign_id text,purpose text,status text,context jsonb,job_id text,created_at bigint)
), game_story_turns AS (
  SELECT * FROM jsonb_to_recordset($4::jsonb) AS t(
    id text,campaign_id text,submitted_sequence bigint,input jsonb)
), npc_ai_jobs AS (
  SELECT * FROM jsonb_to_recordset($5::jsonb) AS j(id text,status text)
) `;
const post = (id, sequence, roundId = 'round') => ({
  id,
  campaign_id: 'campaign',
  submitted_sequence: sequence,
  input: { turnFence: { roundId } },
});
const request = (id, purpose, context, extra = {}) => ({
  id,
  campaign_id: 'campaign',
  purpose,
  status: 'queued',
  context,
  job_id: null,
  created_at: 1,
  ...extra,
});
const speech = (id, storyTurnId, turnOrder = 1, extra = {}) =>
  request(id, 'speech', { storyTurnId, deferredSpeechId: id, turnOrder }, extra);
const director = (id, extra = {}) =>
  request(id, 'story_turn', { turnBasedDeferredDirector: true }, extra);
const select = async (requests, posts, jobs = [], roundId = 'round') =>
  (
    await db.query(prefix + orderedTurnRequestsSql, [
      'campaign',
      roundId,
      JSON.stringify(requests),
      JSON.stringify(posts),
      JSON.stringify(jobs),
    ])
  ).rows;

await test('cross-kind turn ordering preserves authored chronology and frozen work', async (t) => {
  try {
    await t.test(
      'more than eight higher-priority later directors cannot starve earlier speech',
      async () => {
        const first = speech('reply', 'spoken-post');
        const later = Array.from({ length: 12 }, (_, i) =>
          director(`director-${i}`, {
            context: {
              turnBasedDeferredDirector: true,
              generationPolicy: 'world-batch-v1',
              worldPrepared: true,
              frozenBody: `unchanged-${i}`,
            },
          }),
        );
        const posts = [post('spoken-post', 1), ...later.map((r, i) => post(r.id, i + 2))];
        const rows = await select([...later, first], posts);
        assert.deepEqual(
          rows.map((r) => r.id),
          ['reply'],
        );
        const after = await select([{ ...first, status: 'fallback' }, ...later], posts);
        assert.deepEqual(
          after.map((r) => r.id),
          ['director-0'],
        );
        assert.deepEqual(
          after[0].context,
          later[0].context,
          'selection never rewrites paid context',
        );
      },
    );
    await t.test(
      'inflight earlier speech blocks director; each terminal job status releases it',
      async () => {
        const requests = [
          speech('reply', 'spoken-post', 1, { status: 'scheduled', job_id: 'job' }),
          director('later'),
        ];
        const posts = [post('spoken-post', 1), post('later', 2)];
        for (const status of ['reserved', 'running', 'result_received', 'validated'])
          assert.deepEqual(await select(requests, posts, [{ id: 'job', status }]), [], status);
        for (const status of ['committed', 'stale', 'failed', 'cancelled', 'reconciling'])
          assert.deepEqual(
            (await select(requests, posts, [{ id: 'job', status }])).map((r) => r.id),
            ['later'],
            status,
          );
      },
    );
    await t.test(
      'earlier director also blocks later speech without blocking independent world plans',
      async () => {
        const requests = [
          speech('reply', 'spoken-post'),
          director('first'),
          request('plan', 'plan', { worldRoundDecision: true }),
        ];
        const rows = await select(requests, [post('first', 1), post('spoken-post', 2)]);
        assert.deepEqual(
          rows.map((r) => r.id),
          ['plan', 'first'],
        );
      },
    );
    await t.test(
      'same-post speech and director remain selectable for the existing explicit dependency gate',
      async () => {
        const reply = speech('reply', 'mixed');
        reply.context.awaitStoryDirector = 'mixed';
        const rows = await select([reply, director('mixed')], [post('mixed', 1)]);
        assert.deepEqual(new Set(rows.map((r) => r.id)), new Set(['reply', 'mixed']));
        assert.equal(rows.find((r) => r.id === 'reply').context.awaitStoryDirector, 'mixed');
      },
    );
    await t.test(
      'unpaid pending consent is not bypassed; another round and legacy non-turn work are unaffected',
      async () => {
        const first = director('first');
        first.context.generationPolicy = 'world-batch-v1';
        first.context.frozenBody = 'unchanged';
        const later = speech('reply', 'spoken-post');
        const posts = [post('first', 1), post('spoken-post', 2)];
        assert.deepEqual(
          (await select([first, later], posts)).map((r) => r.id),
          ['first'],
        );
        posts[0].input.turnFence.roundId = 'old-round';
        assert.ok((await select([first, later], posts)).some((r) => r.id === 'reply'));
        assert.equal((await select([first, later], posts, [], null)).length, 2);
      },
    );
  } finally {
    await db.end();
  }
});
