/** Real disposable PostgreSQL + actual text adapter with an injected synthetic transport only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { db, startApi, stopApi, client } from '../game/support-runtime.mjs';
import { createStory } from '../images/support.mjs';
import { ownerEnvironment, ownerProfile } from '../images/owner-config-fixture.mjs';
import { cleanupManualLiveFixture } from '../game/manual-live-fixture-cleanup.mjs';
import { spatialFixture } from './spatial-fixtures.mjs';
const require = createRequire(import.meta.url);
require('reflect-metadata');
const { Db } = require('../../apps/api/dist/db.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const { ImageGenerationEngine } = require('../../apps/api/dist/image-generation/service.js');
const { VisualAuthoringService } = require('../../apps/api/dist/visual-authoring/service.js');
const {
  SpatialPlannerService,
} = require('../../apps/api/dist/visual-authoring/spatial-planner.js');
const { spatialPlanDefinition } = require('../../apps/api/dist/visual-authoring/spatial-plan.js');
const { AuthoringTextEngine } = require('../../apps/api/dist/live-test/authoring-text.js');
const {
  BoundedAuthoringTextProvider,
} = require('../../apps/api/dist/live-test/authoring-provider.js');
const {
  GenerationAuthority,
  GENERATION_SCOPE_ID,
} = require('../../apps/api/dist/generation/service.js');
const { readOwnerGenerationConfig } = require('../../apps/api/dist/generation/config.js');
const op = () => randomUUID();
const mutation = (project) => ({ operationId: op(), expectedRevision: project.revision });

test(
  'owner profile drives private text authoring, explicit adoption, restart and late-cost stop',
  { timeout: 90000 },
  async (t) => {
    assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^visual-test-/);
    const database = new Db();
    let owner, authorizationId;
    try {
      await startApi();
      const account = await client().register();
      owner = account.user.id;
      const stories = [
        await createStory(account),
        await createStory(account),
        await createStory(account),
      ];
      const raw = (await db.query('SELECT data FROM adventures WHERE id=$1', [stories[0].id]))
        .rows[0].data;
      raw.content.npcSecrets = 'PRIVATE_OWNER_TEST_SENTINEL';
      await db.query('UPDATE adventures SET data=$2 WHERE id=$1', [stories[0].id, raw]);
      await stopApi();
      const handle = (await db.query('SELECT handle FROM users WHERE id=$1', [owner])).rows[0]
        .handle;
      const profile = ownerProfile();
      const config = readOwnerGenerationConfig(ownerEnvironment(profile, handle));
      const authority = new GenerationAuthority(database, config);
      const assets = new AssetReuseService(database);
      const images = new ImageGenerationEngine(database, assets);
      const visuals = new VisualAuthoringService(database, assets, images);
      let calls = 0,
        late = false;
      const provider = new BoundedAuthoringTextProvider(
        spatialPlanDefinition,
        'synthetic-owner-key',
        async (url, init) => {
          calls++;
          assert.equal(url, 'https://api.openai.com/v1/responses');
          assert.equal(init.redirect, 'error');
          const body = JSON.parse(init.body);
          assert.equal(body.model, profile.text.model);
          assert.equal(body.max_output_tokens, profile.text.maxOutputTokens);
          assert.equal(body.service_tier, 'default');
          assert.equal(init.body.includes('PRIVATE_OWNER_TEST_SENTINEL'), false);
          if (late)
            await db.query(
              "UPDATE live_authoring_text_jobs SET deadline_at=now()-interval '1 second' WHERE id=$1 AND status='dispatched'",
              [init.headers['X-Client-Request-Id']],
            );
          return new Response(
            JSON.stringify({
              id: `synthetic-owner-text-${calls}`,
              status: 'completed',
              service_tier: 'default',
              usage: { input_tokens: 100, output_tokens: 300 },
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: JSON.stringify(spatialFixture()) }],
                },
              ],
            }),
          );
        },
        config.text,
      );
      const engine = new AuthoringTextEngine(database, authority, provider, spatialPlanDefinition);
      const planner = new SpatialPlannerService(database, visuals, engine);
      const create = (story) =>
        visuals.create(owner, {
          kind: 'location',
          generationMode: 'external',
          operationId: op(),
          adventureId: story.id,
          brief: {
            name: 'Synthetic owner library',
            description: 'A private maritime library with a reachable archive.',
            style: 'drawn2D',
          },
        });

      await t.test(
        'claim is persistent and makes no call; real adapter result remains inert until adoption',
        async () => {
          let project = await create(stories[0]);
          assert.equal((await planner.state(owner, project.id)).available, false);
          const status = await authority.claim(owner, {
            consent: true,
            candidateFingerprint: config.configFingerprint,
          });
          authorizationId = status.authorizationId;
          assert.match(authorizationId, /^[0-9a-f-]{36}$/);
          assert.equal(status.expiresAt, null);
          assert.equal(calls, 0);
          const input = { ...mutation(project), sessionId: authorizationId };
          const quote = await planner.quote(owner, project.id, input);
          assert.equal(quote.model, profile.text.model);
          assert.equal(quote.upperMicros, config.text.upperMicros);
          assert.equal((await planner.quote(owner, project.id, input)).id, quote.id);
          assert.equal(calls, 0);
          const dispatch = { ...mutation(project), quoteId: quote.id, consent: true };
          const job = await planner.dispatch(owner, project.id, dispatch);
          assert.equal(job.status, 'committed');
          assert.equal(job.upperMicros, config.text.upperMicros);
          assert.equal(job.actualMicros, 700);
          assert.equal(calls, 1);
          assert.equal((await planner.dispatch(owner, project.id, dispatch)).id, job.id);
          assert.equal(calls, 1);
          assert.equal((await visuals.get(owner, project.id)).plan, null);
          const state = await planner.state(owner, project.id);
          assert.equal(state.canApply, true);
          project = await planner.apply(owner, project.id, {
            ...mutation(project),
            proposalId: state.currentProposal.id,
            consent: true,
          });
          assert.equal(project.planProvenance, 'ai-generated-plan');
          assert.equal(project.plan.maps[0].width, spatialFixture().rooms[0].width);
          const restarted = new GenerationAuthority(database, config);
          const resumed = await restarted.status(owner);
          assert.equal(resumed.authorizationId, authorizationId);
          assert.equal(resumed.usedMicros, 700);
          assert.equal(resumed.state, 'active');
        },
      );

      await t.test(
        'known receipt after persisted deadline stops permanently even before maintenance',
        async () => {
          late = true;
          const project = await create(stories[1]);
          const quote = await planner.quote(owner, project.id, {
            ...mutation(project),
            sessionId: authorizationId,
          });
          const dispatch = { ...mutation(project), quoteId: quote.id, consent: true };
          const job = await planner.dispatch(owner, project.id, dispatch);
          assert.equal(job.status, 'stale');
          assert.equal(job.actualMicros, 700);
          assert.equal(calls, 2);
          assert.equal((await visuals.get(owner, project.id)).plan, null);
          const stopped = await new GenerationAuthority(database, config).status(owner);
          assert.equal(stopped.state, 'stopped');
          assert.equal(stopped.stopCode, 'PROVIDER_DEADLINE_EXCEEDED');
          assert.equal(stopped.usedMicros, 1400);
          assert.equal(stopped.heldMicros, 0);
          await planner.dispatch(owner, project.id, dispatch);
          assert.equal(calls, 2);
          const next = await create(stories[2]);
          await assert.rejects(
            planner.quote(owner, next.id, { ...mutation(next), sessionId: authorizationId }),
            (error) => error.getResponse?.().code === 'GENERATION_PRIOR_LIABILITY_UNRESOLVED',
          );
        },
      );
    } finally {
      await stopApi();
      if (owner && authorizationId)
        await cleanupManualLiveFixture(db, authorizationId, owner, GENERATION_SCOPE_ID);
      await database.pool.end();
      await db.end();
    }
  },
);
