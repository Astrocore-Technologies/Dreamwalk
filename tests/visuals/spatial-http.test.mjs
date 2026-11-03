/** Actual HTTP/manual adapter wiring with a fake Responses transport; never a paid smoke test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, startApi, stopApi, client } from '../game/support-runtime.mjs';
import { createStory } from '../images/support.mjs';
import { spatialFixture } from './spatial-fixtures.mjs';
import { cleanupManualLiveFixture } from '../game/manual-live-fixture-cleanup.mjs';

const op = () => randomUUID();
const base = process.env.TEST_GAME_API_URL;
const scopeId = 'manual-live-test-20261031';
assert.equal(process.env.NODE_ENV, 'test');
assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^visual-test-/);
assert.equal(new URL(process.env.DATABASE_URL).port, process.env.LOCAL_POSTGRES_PORT);

async function until(read, match, timeout = 15000) {
  const end = Date.now() + timeout;
  do {
    const value = await read();
    if (match(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < end);
  assert.fail('Spatial HTTP result did not arrive');
}
await test(
  'manual spatial HTTP uses the real bounded adapter, explicit intent and an inert validated proposal',
  { timeout: 90000 },
  async (t) => {
    let liveApi, owner, outsider, story;
    const sessionId = op();
    const directory = await mkdtemp(join(tmpdir(), 'dreamwalk-spatial-http-'));
    const trace = join(directory, 'synthetic-calls.json');
    await writeFile(trace, '[]');
    const calls = async () => JSON.parse(await readFile(trace, 'utf8'));
    const mutation = (p) => ({ operationId: op(), expectedRevision: p.revision });
    const route = (id) => '/visual-authoring/projects/' + id + '/spatial-plan';
    try {
      await startApi();
      owner = await client().register();
      outsider = await client().register();
      story = await createStory(owner);
      await db.query(
        "UPDATE adventures SET data=jsonb_set(data,'{gmNotes}',to_jsonb($2::text),true) WHERE id=$1",
        [story.id, 'PRIVATE_SPATIAL_CANARY'],
      );
      await stopApi();
      const env = { ...process.env };
      for (const key of Object.keys(env))
        if (
          key.startsWith('NPC_AI_') ||
          key.startsWith('LIVE_TEST_') ||
          key.startsWith('IMAGE_') ||
          key.startsWith('OPENAI_')
        )
          delete env[key];
      Object.assign(env, {
        NODE_ENV: 'test',
        LIVE_TEST_ENABLED: 'true',
        LIVE_TEST_SESSION_ID: sessionId,
        LIVE_TEST_OWNER_ID: owner.user.id,
        LIVE_TEST_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
        NPC_AI_API_KEY: 'synthetic-only-no-network',
        SPATIAL_HTTP_TEST_TRANSPORT: 'true',
        SPATIAL_HTTP_CALLS_FILE: trace,
      });
      liveApi = spawn(
        process.execPath,
        [
          '--import',
          new URL('./spatial-http-preload.mjs', import.meta.url).href,
          'apps/api/dist/main.js',
        ],
        {
          env,
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
        },
      );
      liveApi.stderr.on('data', () => {});
      await until(async () => {
        if (liveApi.exitCode !== null) assert.fail('Disposable spatial API exited at startup');
        return fetch(base + '/health', { signal: AbortSignal.timeout(1000) })
          .then((r) => r.ok)
          .catch(() => false);
      }, Boolean);
      let project;
      await t.test(
        'creation, polling and forbidden approval cause zero transport calls',
        async () => {
          project = await owner.request('/visual-authoring/projects', {
            kind: 'location',
            operationId: op(),
            adventureId: story.id,
            generationMode: 'external',
            spatialMode: 'ai',
            brief: {
              name: 'HTTP conservatory',
              description:
                'HTTP_GREENHOUSE: glass rooms shelter rare seeds and a recoverable case.',
              style: 'drawn2D',
            },
          });
          assert.equal(project.plan, null);
          await owner.request(route(project.id));
          await outsider.request(route(project.id), undefined, 'GET', 404);
          await owner.request(
            '/visual-authoring/projects/' + project.id + '/approve',
            { ...mutation(project), consent: true },
            'POST',
            409,
          );
          assert.equal((await calls()).length, 0);
          assert.equal((await owner.request('/live-test/status')).state, 'unclaimed');
        },
      );
      let proposal;
      await t.test(
        'explicit claim and quote still do not dispatch; duplicate intent sends once',
        async () => {
          await owner.request('/live-test/claim', { consent: true });
          const quote = await owner.request(route(project.id) + '/quote', {
            ...mutation(project),
            sessionId,
          });
          assert.equal(quote.upperMicros, 264036);
          assert.equal((await calls()).length, 0);
          const intent = { ...mutation(project), quoteId: quote.id, consent: true };
          const results = await Promise.all([
            owner.request(route(project.id) + '/dispatch', intent),
            owner.request(route(project.id) + '/dispatch', intent),
          ]);
          assert.equal(results[0].id, results[1].id);
          const state = await until(
            () => owner.request(route(project.id)),
            (s) => !!s.currentProposal,
          );
          proposal = state.currentProposal;
          assert.equal(proposal.validated, true);
          assert.equal(proposal.status, 'proposed');
          assert.equal((await calls()).length, 1);
          assert.equal(
            (await owner.request('/visual-authoring/projects/' + project.id)).plan,
            null,
          );
          assert.equal(proposal.plan.title, spatialFixture('greenhouse').title);
          assert.equal(proposal.plan.maps[0].width, 24);
          assert.ok(!JSON.stringify(proposal.plan).includes('Mira'));
          assert.ok(!JSON.stringify(proposal.plan).includes('PRIVATE_SPATIAL_CANARY'));
          const budget = await owner.request('/live-test/status');
          assert.equal(budget.heldMicros, 0);
          assert.equal(budget.usedMicros, 325);
        },
      );
      await t.test(
        'author applies once, reloads and walks the proposed layout through the actual engine',
        async () => {
          const apply = { ...mutation(project), proposalId: proposal.id, consent: true };
          const applied = await owner.request(route(project.id) + '/apply', apply);
          assert.equal(applied.revision, project.revision + 1);
          assert.equal(applied.plan.maps[0].width, 24);
          assert.equal(
            (await owner.request(route(project.id) + '/apply', apply)).revision,
            applied.revision,
          );
          const stored = await owner.request('/visual-authoring/projects/' + project.id);
          assert.deepEqual(
            stored.plan.maps.map((m) => m.label),
            spatialFixture('greenhouse').rooms.map((r) => r.name),
          );
          const walked = await owner.request(
            '/visual-authoring/projects/' + project.id + '/preview',
            {
              ...mutation(stored),
              action: { kind: 'move_to', target: { x: 2, y: 2 } },
            },
          );
          const actor = walked.projection.entities.find((e) => e.id === walked.projection.actorId);
          assert.deepEqual({ x: actor.x, y: actor.y }, { x: 2, y: 2 });
          const returned = await owner.request(
            '/visual-authoring/projects/' + project.id + '/preview',
            {
              ...mutation(walked),
              action: { kind: 'move_to', target: { x: 2, y: 8 } },
            },
          );
          const returnActor = returned.projection.entities.find(
            (e) => e.id === returned.projection.actorId,
          );
          assert.deepEqual({ x: returnActor.x, y: returnActor.y }, { x: 2, y: 8 });
          assert.ok(
            returned.plan.turnRules,
            'Saved campaign rules remain pinned while author preview is free',
          );
          assert.equal((await calls()).length, 1);
        },
      );
      await t.test(
        'a changed confirmed source rejects a previously quoted plan without transport',
        async () => {
          const second = await owner.request('/visual-authoring/projects', {
            kind: 'location',
            operationId: op(),
            adventureId: story.id,
            generationMode: 'external',
            spatialMode: 'ai',
            brief: {
              name: 'Second conservatory',
              description:
                'HTTP_GREENHOUSE: another bounded proposal, never sent after its source changes.',
              style: 'drawn2D',
            },
          });
          const quote = await owner.request(route(second.id) + '/quote', {
            ...mutation(second),
            sessionId,
          });
          await db.query("UPDATE adventures SET title=title||' revised' WHERE id=$1", [story.id]);
          await owner.request(
            route(second.id) + '/dispatch',
            { ...mutation(second), quoteId: quote.id, consent: true },
            'POST',
            409,
          );
          assert.equal((await calls()).length, 1);
          const budget = await owner.request('/live-test/status');
          assert.equal(budget.heldMicros, 0);
          assert.equal(budget.usedMicros, 325);
        },
      );
    } finally {
      if (liveApi && liveApi.exitCode === null && liveApi.signalCode === null) {
        const exited = once(liveApi, 'exit');
        liveApi.kill('SIGTERM');
        await exited;
      }
      await stopApi();
      if (owner) await cleanupManualLiveFixture(db, sessionId, owner.user.id, scopeId);
      await db.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
