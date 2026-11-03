/** Isolated real PostgreSQL planner flow, injected provider only. No key reads or external requests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { db, startApi, stopApi, client, snapshot } from '../game/support-runtime.mjs';
import { createStory } from '../images/support.mjs';
import { authoredDraft } from '../game/support-authored.mjs';
import { cleanupManualLiveFixture } from '../game/manual-live-fixture-cleanup.mjs';
import { spatialFixture } from './spatial-fixtures.mjs';
const require = createRequire(import.meta.url);
require('reflect-metadata');
const { Db } = require('../../apps/api/dist/db.js');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
const { ImageGenerationEngine } = require('../../apps/api/dist/image-generation/service.js');
const { defaultImagePolicy } = require('../../apps/api/dist/image-generation/contracts.js');
const { fixtureRaster } = require('../../apps/api/dist/visual-authoring/fixture-art.js');
const { VisualAuthoringService } = require('../../apps/api/dist/visual-authoring/service.js');
const {
  SpatialPlannerService,
} = require('../../apps/api/dist/visual-authoring/spatial-planner.js');
const {
  spatialPlanDefinition,
  authorizeSpatialPlan,
} = require('../../apps/api/dist/visual-authoring/spatial-plan.js');
const { AuthoringTextEngine } = require('../../apps/api/dist/live-test/authoring-text.js');
const { LiveTestService } = require('../../apps/api/dist/live-test/service.js');
const { LIVE_TEXT } = require('../../apps/api/dist/live-test/config.js');
const { ProviderFailure } = require('../../apps/api/dist/ai/types.js');
const {
  turnRulesSchema,
  narrativeConstraintsSchema,
} = require('../../packages/contracts/dist/index.js');
const code = (expected) => (e) => e?.getResponse?.().code === expected;
const op = () => randomUUID(),
  mutation = (p) => ({ operationId: op(), expectedRevision: p.revision });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
await test(
  'manual AI spatial plans are private inert proposals until validated author adoption',
  { timeout: 180000 },
  async (t) => {
    const database = new Db(),
      assets = new AssetReuseService(database),
      images = new ImageGenerationEngine(
        database,
        assets,
        {
          id: 'synthetic-spatial-art',
          async generate(input, dispatchId) {
            imageCalls++;
            const role = input.authoringContext.role,
              raster = await fixtureRaster(
                role === 'sample-sheet' ? 'sheet' : role === 'quest-item' ? 'plant' : role,
              );
            return {
              bytes: raster.bytes,
              mime: 'image/webp',
              actualMicros: 10,
              requestId: `synthetic-spatial-art-${dispatchId}`,
            };
          },
        },
        {
          ...defaultImagePolicy,
          scopeId: op(),
          externalEnabled: true,
          approved: true,
          verifiedUpperMicros: 10,
          totalCapMicros: 10000,
          imageCapMicros: 10000,
          textCapMicros: 0,
        },
      );
    const visuals = new VisualAuthoringService(database, assets, images);
    let sessionId,
      owner,
      preparedLocation,
      preparedPack,
      imageCalls = 0,
      mode = 'normal',
      pending,
      started,
      calls = 0;
    const captured = [];
    t.beforeEach(async () => {
      // Simulate separate human authoring sessions between fast synthetic cases; production limits stay unchanged.
      if (owner) {
        assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^visual-test-/);
        await db.query(
          "UPDATE visual_authoring_operations SET created_at=created_at-interval '2 minutes' WHERE owner_id=$1 AND created_at>now()-interval '1 minute'",
          [owner],
        );
      }
    });
    try {
      await startApi();
      // The injected legacy art transport has no priced model snapshot.
      const account = await client().registerLegacyFixture(),
        other = await client().register();
      owner = account.user.id;
      const stories = [];
      for (let i = 0; i < 10; i++) stories.push(await createStory(account));
      const raw = (await db.query('SELECT data FROM adventures WHERE id=$1', [stories[0].id]))
        .rows[0].data;
      raw.content.world = 'PUBLIC_WORLD: a maritime library of navigation charts.';
      raw.content.scenes[0].description = 'PUBLIC_OPENING: a catalogue tag has disappeared.';
      raw.content.rules = 'PRIVATE_RULE_PROSE';
      raw.content.npcSecrets = 'PRIVATE_NPC_SENTINEL';
      raw.privateHeroNotes = 'PRIVATE_HERO_SENTINEL';
      await db.query('UPDATE adventures SET data=$2 WHERE id=$1', [stories[0].id, raw]);
      const sourceDraft = authoredDraft();
      sourceDraft.turnRules = turnRulesSchema.parse({ movement: 4, main: 2 });
      sourceDraft.narrativeConstraints = narrativeConstraintsSchema.parse({
        allowNewScenes: false,
        allowNewNpcs: false,
        protectedFacts: [{ id: 'hidden-fact', text: 'PRIVATE_AUTHORITY_SENTINEL' }],
      });
      sourceDraft.maps[0].description = 'PUBLIC_CONFIRMED_MAP';
      await db.query('INSERT INTO adventure_game_drafts(adventure_id,draft) VALUES($1,$2)', [
        stories[0].id,
        sourceDraft,
      ]);
      await stopApi();
      sessionId = op();
      const live = new LiveTestService(database, {
        enabled: true,
        sessionId,
        ownerId: owner,
        expiresAt: new Date(Date.now() + 3600000),
      });
      await live.claim(owner, { consent: true });
      const provider = {
        version: 'synthetic-spatial-output-v1',
        async generate(request) {
          calls++;
          captured.push(request.context);
          const garden = request.context.brief.description.includes('conservatory');
          const proposal = spatialFixture(garden ? 'greenhouse' : 'library');
          if (mode === 'invalid') proposal.rooms[1].id = 'atelier';
          if (mode === 'unknown') throw new ProviderFailure('PROVIDER_OUTCOME_UNKNOWN', true);
          const response = {
            proposal,
            requestId: `synthetic-layout-${calls}`,
            usage: {
              inputTokens: 200,
              outputTokens: 600,
              costMicros: 1000,
              costEvidence: 'reported',
            },
          };
          if (mode === 'deferred') {
            started.resolve();
            return pending.promise;
          }
          return response;
        },
      };
      const engine = new AuthoringTextEngine(database, live, provider, spatialPlanDefinition),
        planner = new SpatialPlannerService(database, visuals, engine);
      const create = (
        story,
        description = 'A maritime library with oak chart tables and a reachable archive',
      ) =>
        visuals.create(owner, {
          kind: 'location',
          generationMode: 'external',
          operationId: op(),
          adventureId: story.id,
          brief: {
            name: description.includes('conservatory') ? 'Seedhouse' : 'Maritime library',
            description,
            style: 'drawn2D',
          },
        });
      const quote = (p) => planner.quote(owner, p.id, { ...mutation(p), sessionId });
      const dispatch = async (p) => {
        const q = await quote(p);
        const body = { ...mutation(p), quoteId: q.id, consent: true };
        return { job: await planner.dispatch(owner, p.id, body), body };
      };
      await t.test(
        'new AI projects have no template success; actual distinct outputs remain inert until apply',
        async () => {
          let p = await create(stories[0]);
          assert.equal(p.plan, null);
          assert.equal(p.projection, null);
          assert.equal(p.planProvenance, 'ai-pending');
          await assert.rejects(
            visuals.approve(owner, p.id, { ...mutation(p), consent: true }),
            code('SPATIAL_PLAN_REQUIRED'),
          );
          await assert.rejects(
            visuals.quoteGeneration(owner, p.id, { ...mutation(p), role: 'background' }),
            code('STATE_CONFLICT'),
          );
          const qBody = { ...mutation(p), sessionId },
            q = await planner.quote(owner, p.id, qBody);
          assert.equal((await planner.quote(owner, p.id, qBody)).id, q.id);
          assert.equal(calls, 0);
          const body = { ...mutation(p), quoteId: q.id, consent: true },
            job = await planner.dispatch(owner, p.id, body);
          assert.equal(job.status, 'committed');
          assert.equal(calls, 1);
          assert.equal((await planner.dispatch(owner, p.id, body)).id, job.id);
          assert.equal(calls, 1);
          let state = await planner.state(owner, p.id);
          assert.equal(state.canApply, true);
          assert.equal(state.canQuote, false);
          assert.equal(state.currentProposal.plan.maps[0].width, 24);
          assert.equal(state.currentProposal.plan.turnRules.movement, 4);
          assert.equal(state.currentProposal.plan.narrativeConstraints.allowNewScenes, false);
          assert.equal((await visuals.get(owner, p.id)).plan, null);
          const packed = JSON.stringify(captured[0]);
          for (const secret of [
            'PRIVATE_RULE_PROSE',
            'PRIVATE_NPC_SENTINEL',
            'PRIVATE_HERO_SENTINEL',
            'PRIVATE_AUTHORITY_SENTINEL',
          ])
            assert.equal(packed.includes(secret), false);
          for (const publicValue of ['PUBLIC_WORLD', 'PUBLIC_OPENING', 'PUBLIC_CONFIRMED_MAP'])
            assert.ok(packed.includes(publicValue));
          assert.equal(
            JSON.stringify(state.currentProposal.projection).includes('PRIVATE_AUTHORITY_SENTINEL'),
            false,
          );
          await assert.rejects(planner.state(other.user.id, p.id), code('NOT_FOUND'));
          const apply = { ...mutation(p), proposalId: state.currentProposal.id, consent: true };
          p = await planner.apply(owner, p.id, apply);
          assert.equal(p.revision, 2);
          assert.equal(p.planProvenance, 'ai-generated-plan');
          assert.equal(p.plan.npcs[0].publicProfile.description, spatialFixture().npc.description);
          assert.equal((await planner.apply(owner, p.id, apply)).revision, 2);
          assert.equal((await planner.state(owner, p.id)).canApply, false);
          assert.equal(p.projection.turn, undefined);
          p = await visuals.preview(owner, p.id, {
            ...mutation(p),
            action: { kind: 'move_to', target: { x: spatialFixture().connection.door.x, y: 4 } },
          });
          p = await visuals.preview(owner, p.id, {
            ...mutation(p),
            action: { kind: 'open', targetId: 'atelier-door' },
          });
          p = await visuals.preview(owner, p.id, {
            ...mutation(p),
            action: { kind: 'move_to', target: { x: 2, y: 8 } },
          });
          assert.equal(p.projection.entities.find((e) => e.id === 'visual-preview-player').x, 2);
          assert.equal(p.plan.turnRules.movement, 4);
          p = await visuals.approve(owner, p.id, { ...mutation(p), consent: true });
          assert.equal(p.status, 'approved');
          preparedLocation = p;
          const garden = await create(
            stories[1],
            'A conservatory with seed benches, warm glass walls and a propagation room',
          );
          await dispatch(garden);
          state = await planner.state(owner, garden.id);
          assert.equal(state.currentProposal.plan.maps[0].width, 24);
          assert.equal(state.currentProposal.plan.npcs[0].label, 'Elian');
          assert.equal((await visuals.get(owner, garden.id)).plan, null);
        },
      );
      await t.test(
        'accepted AI layout admits only required art and becomes a pinned playable campaign',
        async () => {
          const p = preparedLocation,
            state = await visuals.generation(owner, p.id),
            roles = state.requiredRoles;
          assert.ok(roles.includes('quest-item'));
          assert.ok(roles.includes('table'));
          assert.ok(roles.includes('rug'));
          assert.equal(roles.includes('counter'), false);
          assert.equal(roles.includes('shelf'), false);
          for (const role of roles) {
            const quote = await visuals.quoteGeneration(owner, p.id, {
              ...mutation(p),
              role,
              declineReuse: true,
            });
            const job = await visuals.dispatchGeneration(owner, p.id, {
              ...mutation(p),
              role,
              quoteId: quote.quote.id,
              consent: true,
            });
            await images.workOnce();
            assert.equal((await images.get(owner, job.id)).status, 'admitted');
          }
          const pack = await visuals.complete(owner, p.id, {
            ...mutation(p),
            consent: true,
            visualReview: true,
          });
          preparedPack = pack;
          assert.equal(pack.parts.length, roles.length);
          assert.ok(pack.parts.some((part) => part.role === 'quest-item'));
          const hash = (await visuals.sourceHash(owner, stories[0].id)).sourceHash;
          await visuals.apply(owner, pack.id, {
            operationId: op(),
            adventureId: stories[0].id,
            expectedSourceHash: hash,
            replaceDraft: true,
          });
          const saved = (
            await db.query('SELECT draft FROM adventure_game_drafts WHERE adventure_id=$1', [
              stories[0].id,
            ])
          ).rows[0].draft;
          assert.equal(saved.maps[0].composition.layers[0].id, 'chart-table');
          assert.equal(saved.maps[0].composition.layers[0].label, 'Navigator chart table');
          assert.equal(
            saved.objects.find((o) => o.id === 'rain-journal').label,
            'Brass catalogue tag',
          );
          assert.equal(saved.turnRules.movement, 4);
          assert.deepEqual(saved.narrativeConstraints, sourceDraft.narrativeConstraints);
          await startApi();
          try {
            const draft = await account.request(
                `/studio/adventures/${stories[0].id}/playable-draft`,
              ),
              art = await account.request(`/asset-library/stories/${stories[0].id}/draft`);
            const version = await account.request(
              `/studio/adventures/${stories[0].id}/playable-versions`,
              { expectedRevision: draft.revision, expectedArtRevision: art.revision },
            );
            const hero = await account.request('/heroes', { name: 'Sable' }),
              campaign = await account.request('/game/campaigns', {
                playableVersionId: version.versionId,
                heroId: hero.id,
              });
            const view = (await snapshot(account, campaign.campaignId)).projection;
            assert.equal(view.map.label, 'Chart reading room');
            assert.equal(view.turn.ruleset.movement, 4);
            const manifest = await account.request(
              `/asset-library/campaigns/${campaign.campaignId}/manifest`,
            );
            assert.ok(manifest.bindings.some((b) => b.slot === 'map:atelier:layer:chart-table'));
            assert.equal(
              manifest.bindings.some((b) => b.slot === 'entity:rain-journal:object:default'),
              false,
            );
            assert.equal(
              (
                await db.query(
                  "SELECT count(*)::int n FROM art_playable_pins WHERE playable_version_id=$1 AND slot='entity:rain-journal:object:default'",
                  [version.versionId],
                )
              ).rows[0].n,
              1,
            );
            const frozen = (
              await db.query('SELECT state FROM game_campaigns WHERE id=$1', [campaign.campaignId])
            ).rows[0].state;
            assert.ok(
              frozen.artBindings.some((b) => b.slot === 'entity:rain-journal:object:default'),
            );
            assert.equal(frozen.entities.alchemist.publicProfile.role, 'cataloguer');
            assert.equal(
              frozen.entities['rain-journal'].publicProfile.description,
              spatialFixture().item.description,
            );
            assert.equal(frozen.objectives[0].title, 'Recover the catalogue tag');
          } finally {
            await stopApi();
          }
        },
      );
      await t.test(
        'invalid output is a paid failure with no fixture fallback or automatic retry',
        async () => {
          const p = await create(stories[2]);
          mode = 'invalid';
          const { job } = await dispatch(p);
          mode = 'normal';
          assert.equal(job.status, 'failed');
          assert.equal(job.errorCode, 'AUTHORING_PROPOSAL_INVALID');
          assert.equal(job.actualMicros, 1000);
          assert.equal((await visuals.get(owner, p.id)).plan, null);
          const state = await planner.state(owner, p.id);
          assert.equal(state.currentProposal, undefined);
          assert.equal(state.canQuote, false);
          const before = calls;
          await engine.run(
            owner,
            job.id,
            async () => {},
            async () => {},
          );
          assert.equal(calls, before);
          await assert.rejects(quote(p), code('SPATIAL_ATTEMPT_ALREADY_STARTED'));
        },
      );
      await t.test(
        'changed canon rejects dispatch before cost and known late results cannot adopt a plan',
        async () => {
          let p = await create(stories[3]),
            q = await quote(p);
          await db.query("UPDATE adventures SET title=title||' changed' WHERE id=$1", [
            stories[3].id,
          ]);
          const before = calls;
          await assert.rejects(
            planner.dispatch(owner, p.id, { ...mutation(p), quoteId: q.id, consent: true }),
          );
          assert.equal(calls, before);
          p = await create(stories[4]);
          q = await quote(p);
          mode = 'deferred';
          pending = deferred();
          started = deferred();
          const run = planner.dispatch(owner, p.id, {
            ...mutation(p),
            quoteId: q.id,
            consent: true,
          });
          await started.promise;
          await db.query("UPDATE adventures SET title=title||' changed' WHERE id=$1", [
            stories[4].id,
          ]);
          pending.resolve({
            proposal: spatialFixture(),
            requestId: 'synthetic-stale',
            usage: {
              inputTokens: 100,
              outputTokens: 400,
              costMicros: 1000,
              costEvidence: 'reported',
            },
          });
          const job = await run;
          mode = 'normal';
          assert.equal(job.status, 'stale');
          assert.equal(job.actualMicros, 1000);
          assert.equal((await visuals.get(owner, p.id)).plan, null);
        },
      );
      await t.test(
        'cancelled project keeps in-flight liability and never receives the late proposal',
        async () => {
          const p = await create(stories[5]),
            q = await quote(p);
          mode = 'deferred';
          pending = deferred();
          started = deferred();
          const run = planner.dispatch(owner, p.id, {
            ...mutation(p),
            quoteId: q.id,
            consent: true,
          });
          await started.promise;
          await visuals.cancel(owner, p.id, mutation(p));
          await planner.cancelPendingForProject(owner, p.id);
          assert.equal((await live.status(owner)).heldMicros, LIVE_TEXT.upperMicros);
          pending.resolve({
            proposal: spatialFixture(),
            requestId: 'synthetic-cancelled',
            usage: {
              inputTokens: 100,
              outputTokens: 400,
              costMicros: 1000,
              costEvidence: 'reported',
            },
          });
          const job = await run;
          mode = 'normal';
          assert.equal(job.status, 'cancelled');
          assert.equal(job.actualMicros, 1000);
          assert.equal((await planner.state(owner, p.id)).currentProposal, undefined);
        },
      );
      await t.test(
        'explicit manual mode remains available without an AI label or paid call',
        async () => {
          const before = calls;
          let p = await visuals.create(owner, {
            kind: 'location',
            generationMode: 'external',
            spatialMode: 'manual',
            operationId: op(),
            adventureId: stories[6].id,
            brief: {
              name: 'Manual plan',
              description: 'An explicitly chosen manually editable template room',
              style: 'drawn2D',
            },
          });
          assert.ok(p.plan);
          assert.equal(p.planProvenance, 'manual');
          p = await visuals.approve(owner, p.id, { ...mutation(p), consent: true });
          assert.equal(p.status, 'approved');
          assert.equal(calls, before);
        },
      );
      await t.test(
        'library geometry preserves destination authority and rejects its supported scene limit',
        async () => {
          let fixture = await visuals.create(owner, {
            kind: 'location',
            generationMode: 'fixture',
            operationId: op(),
            adventureId: stories[9].id,
            brief: {
              name: 'Reusable room',
              description: 'An explicitly labelled fixture package used to test destination rules',
              style: 'drawn2D',
            },
          });
          const sourcePlan = authorizeSpatialPlan(spatialFixture(), {
            turnRules: turnRulesSchema.parse({ movement: 9 }),
            narrativeConstraints: narrativeConstraintsSchema.parse({
              protectedFacts: [{ id: 'origin-private', text: 'ORIGIN_PRIVATE_AUTHORITY' }],
            }),
          }).plan;
          await db.query('UPDATE visual_authoring_projects SET plan=$2 WHERE id=$1', [
            fixture.id,
            sourcePlan,
          ]);
          fixture = await visuals.approve(owner, fixture.id, {
            ...mutation(fixture),
            consent: true,
          });
          const pack = await visuals.complete(owner, fixture.id, {
            ...mutation(fixture),
            consent: true,
          });
          const target = authoredDraft();
          target.maps = [target.maps[0]];
          target.maps[0].exits = [];
          target.turnRules = turnRulesSchema.parse({ movement: 2, main: 3 });
          target.narrativeConstraints = narrativeConstraintsSchema.parse({
            maxScenes: 1,
            protectedFacts: [{ id: 'destination-private', text: 'DESTINATION_PRIVATE_AUTHORITY' }],
          });
          await db.query('INSERT INTO adventure_game_drafts(adventure_id,draft) VALUES($1,$2)', [
            stories[6].id,
            target,
          ]);
          let hash = (await visuals.sourceHash(owner, stories[6].id)).sourceHash;
          await assert.rejects(
            visuals.apply(owner, pack.id, {
              operationId: op(),
              adventureId: stories[6].id,
              expectedSourceHash: hash,
              replaceDraft: true,
            }),
            code('STORY_RULE_CONFLICT'),
          );
          target.narrativeConstraints.maxScenes = 4;
          await db.query(
            'UPDATE adventure_game_drafts SET draft=$2,revision=revision+1 WHERE adventure_id=$1',
            [stories[6].id, target],
          );
          hash = (await visuals.sourceHash(owner, stories[6].id)).sourceHash;
          await visuals.apply(owner, pack.id, {
            operationId: op(),
            adventureId: stories[6].id,
            expectedSourceHash: hash,
            replaceDraft: true,
          });
          const saved = (
            await db.query('SELECT draft FROM adventure_game_drafts WHERE adventure_id=$1', [
              stories[6].id,
            ])
          ).rows[0].draft;
          assert.equal(saved.turnRules.movement, 2);
          assert.equal(saved.turnRules.main, 3);
          assert.deepEqual(saved.narrativeConstraints, target.narrativeConstraints);
          assert.equal(JSON.stringify(saved).includes('ORIGIN_PRIVATE_AUTHORITY'), false);
          const priorCalls = { text: calls, images: imageCalls };
          const destinationHash = (await visuals.sourceHash(owner, stories[6].id)).sourceHash;
          await visuals.apply(owner, preparedPack.id, {
            operationId: op(),
            adventureId: stories[6].id,
            expectedSourceHash: destinationHash,
            replaceDraft: true,
          });
          const originHash = (await visuals.sourceHash(owner, stories[0].id)).sourceHash;
          const reapplied = await visuals.apply(owner, preparedPack.id, {
            operationId: op(),
            adventureId: stories[0].id,
            expectedSourceHash: originHash,
            replaceDraft: true,
          });
          assert.equal(reapplied.applied, true);
          assert.equal(calls, priorCalls.text);
          assert.equal(imageCalls, priorCalls.images);
        },
      );
      await t.test(
        'unknown outcome stops the shared grant and duplicate requests never redispatch',
        async () => {
          const p = await create(stories[7]);
          mode = 'unknown';
          const { job, body } = await dispatch(p);
          mode = 'normal';
          assert.equal(job.status, 'unknown');
          assert.equal((await live.status(owner)).heldMicros, LIVE_TEXT.upperMicros);
          assert.equal((await live.status(owner)).state, 'stopped');
          const before = calls;
          assert.equal((await planner.dispatch(owner, p.id, body)).status, 'unknown');
          assert.equal(calls, before);
          const next = await create(stories[8]);
          await assert.rejects(quote(next), code('LIVE_SESSION_STOPPED'));
        },
      );
    } finally {
      await stopApi();
      if (sessionId && owner)
        await cleanupManualLiveFixture(db, sessionId, owner, LIVE_TEXT.scopeId);
      await database.pool.end();
      await db.end();
    }
  },
);
