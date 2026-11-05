/** Real disposable PostgreSQL and the bounded Responses adapter with an injected transport.
 * Author input contains no coordinates or images. No external provider or paid call is made. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  db,
  startApi,
  stopApi,
  client,
  snapshot,
  actor,
  connect,
  until,
} from './support-runtime.mjs';
import { requestEstimateOwnerProfile } from '../images/owner-config-fixture.mjs';

const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service');
const { StoryBuildService } = require('../../apps/api/dist/game/story-build.service');
const { storyPlanDefinition } = require('../../apps/api/dist/game/story-plan');
const { AuthoringTextEngine } = require('../../apps/api/dist/live-test/authoring-text');
const {
  BoundedAuthoringTextProvider,
} = require('../../apps/api/dist/live-test/authoring-provider');
const { GenerationAuthority } = require('../../apps/api/dist/generation/service');
const { readGenerationConfig } = require('../../apps/api/dist/generation/config');
const { activateReleaseDeployment } = require('../images/release-deployment-fixture.cjs');
const { gameEnvelopeSchema } = require('../../packages/contracts/dist');
const database = new Db();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// Fill only schema-required nullable fields. Coordinates always come from this
// synthetic provider response, never a draft upload, DB repair or manual input API.
function strictResponse(value, schema) {
  if (schema.anyOf) {
    if (value === undefined) {
      assert.ok(schema.anyOf.some((branch) => branch.type === 'null'));
      return null;
    }
    return strictResponse(
      value,
      schema.anyOf.find((branch) => branch.type !== 'null'),
    );
  }
  if (schema.type === 'array') return value.map((entry) => strictResponse(entry, schema.items));
  if (schema.type === 'object') {
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
    assert.equal(schema.additionalProperties, false);
    return Object.fromEntries(
      Object.entries(schema.properties).map(([key, child]) => [
        key,
        strictResponse(value[key], child),
      ]),
    );
  }
  assert.notEqual(value, undefined, 'Required non-null provider field must be supplied');
  return value;
}

function providerPlan(source, schema) {
  const slots = [
    { x: 2, y: 2 },
    { x: 2, y: 3 },
    { x: 2, y: 4 },
    { x: 2, y: 5 },
  ];
  return strictResponse(
    {
      version: 1,
      rooms: source.content.locations.map((location) => ({
        locationId: location.id,
        width: 24,
        height: 24,
        spawns: slots,
        blocked: [],
        surfaces: [
          {
            id: `table_${location.id}`,
            visual: 'table',
            x: 12,
            y: 10,
            width: 2,
            height: 2,
            solid: true,
          },
        ],
      })),
      connections: [{ a: 'hall', b: 'workshop', atA: { x: 18, y: 12 }, atB: { x: 3, y: 12 } }],
      npcs: source.content.npcIds.map((sourceNpcId, index) => ({
        sourceNpcId,
        locationId: index < 3 ? 'hall' : 'workshop',
        x: 6 + (index % 3) * 2,
        y: 6,
        stock: [],
      })),
      items: [],
    },
    schema,
  );
}

await test(
  'text-only author story reaches a playable grid through one bounded plan and keeps rejection receipts',
  { timeout: 120000 },
  async (t) => {
    try {
      assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^game-test-/);
      assert.equal(process.env.NPC_AI_PROVIDER, 'mock');
      assert.equal(process.env.PAID_GENERATION_ENABLED, 'false');
      await startApi();
      const owner = await client().registerLegacyFixture();
      const npcs = [];
      for (const name of ['Keeper', 'Courier', 'Visitor', 'Artisan', 'Apprentice']) {
        npcs.push(
          await owner.request('/npcs', {
            name,
            description: `${name} at the old station.`,
            secrets: 'TEXT_PLAN_PRIVATE_CANARY',
          }),
        );
      }
      const sourceInput = (title) => ({
        title,
        synopsis: 'Visitors meet three people in a hall beside a workshop with two artisans.',
        visibility: 'private',
        content: {
          world: 'A peaceful old station. Each room has a table and a clear connecting passage.',
          locations: [
            {
              id: 'hall',
              name: 'Arrival hall',
              description: 'A hall with a table and a passage to the workshop.',
            },
            {
              id: 'workshop',
              name: 'Workshop',
              description: 'A workshop with a table and a passage to the hall.',
            },
          ],
          npcIds: npcs.map((npc) => npc.id),
          scenes: [
            {
              id: 'arrival',
              name: 'Arrival',
              locationId: 'hall',
              participantNpcIds: npcs.slice(0, 3).map((npc) => npc.id),
            },
            {
              id: 'craft',
              name: 'Crafting',
              locationId: 'workshop',
              participantNpcIds: npcs.slice(3).map((npc) => npc.id),
            },
          ],
          startSceneId: 'arrival',
        },
      });
      const story = await owner.request('/studio/adventures', sourceInput('Text-only station'));
      const malformedStory = await owner.request(
        '/studio/adventures',
        sourceInput('Invalid provider station'),
      );
      const changedStory = await owner.request(
        '/studio/adventures',
        sourceInput('Later edited station'),
      );
      await stopApi();
      await db.query(
        'INSERT INTO spark_wallets(owner_id,enabled,balance_subunits) VALUES($1,true,1000000)',
        [owner.user.id],
      );
      const profile = requestEstimateOwnerProfile();
      Object.assign(profile.text, {
        maxInputBytes: 4194304,
        contextTokens: 1050000,
        contextBudgetTokens: 200000,
        maxOutputTokens: 8192,
      });
      const config = readGenerationConfig({
        GENERATION_MODE: 'release',
        GENERATION_CONFIG_JSON: JSON.stringify({ ...profile, aggregateCapMicros: 10000000 }),
      });
      await database.tx((c) => activateReleaseDeployment(c, config));
      const authority = new GenerationAuthority(database, config);
      let mode = 'valid';
      const dispatched = [],
        preparedBodies = [];
      const provider = new BoundedAuthoringTextProvider(
        storyPlanDefinition,
        'synthetic-not-a-real-key',
        async (url, init) => {
          // Any token-count/image/extra endpoint is a regression, not a network fallback.
          assert.equal(url, 'https://api.openai.com/v1/responses');
          dispatched.push(init.body);
          const body = JSON.parse(init.body),
            source = JSON.parse(body.input),
            schema = body.text.format.schema;
          assert.equal(body.text.format.strict, true);
          assert.equal(source.mapImages?.length ?? 0, 0);
          assert.equal(source.omittedMapImages?.length ?? 0, 0);
          assert.equal(source.content.locations.length, 2);
          assert.equal(source.npcs.length, 5);
          assert.ok(!init.body.includes('TEXT_PLAN_PRIVATE_CANARY'));
          assert.equal(schema.properties.rooms.items.properties.spawns.minItems, 4);
          assert.equal(schema.properties.rooms.items.properties.spawns.maxItems, 4);
          for (const key of ['x', 'y'])
            assert.equal(schema.properties.npcs.items.properties[key].type, 'integer');
          for (const key of ['atA', 'atB'])
            assert.equal(schema.properties.connections.items.properties[key].type, 'object');
          const proposal = providerPlan(source, schema);
          // The malformed response reproduces what the old nullable schema admitted.
          if (mode === 'missing_positions') {
            proposal.rooms[0].spawns = [];
            proposal.connections[0].atA = null;
            proposal.npcs[0].x = null;
          }
          return new Response(
            JSON.stringify({
              id: `synthetic-text-plan-${dispatched.length}`,
              status: 'completed',
              service_tier: 'default',
              usage: { input_tokens: 100, output_tokens: 100 },
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: JSON.stringify(proposal) }],
                },
              ],
            }),
          );
        },
        config.text,
      );
      const prepareRequest = provider.prepareTextRequest.bind(provider);
      provider.prepareTextRequest = (...args) => {
        const prepared = prepareRequest(...args);
        preparedBodies.push(prepared.body);
        return prepared;
      };
      const engine = new AuthoringTextEngine(database, authority, provider, storyPlanDefinition);
      const builder = new StoryBuildService(database, new AssetReuseService(database), engine);
      const prepareAndQuote = async (adventureId) => {
        const before = dispatched.length;
        const prepared = await builder.prepare(owner.user.id, adventureId, {
          operationId: randomUUID(),
        });
        const quote = await builder.quote(owner.user.id, prepared.id, {
          operationId: randomUUID(),
        });
        assert.equal(
          dispatched.length,
          before,
          'prepare and quote never dispatch or count externally',
        );
        assert.equal(quote.automaticKnownCostPolicy, 'known-cost-v1');
        const quotedBody = preparedBodies.at(-1);
        const persisted = (
          await db.query('SELECT request_snapshot FROM live_authoring_text_quotes WHERE id=$1', [
            quote.id,
          ])
        ).rows[0];
        assert.equal(persisted.request_snapshot.bodySha256, sha256(quotedBody));
        return {
          prepared,
          quote,
          quotedBody,
          dispatch: {
            operationId: randomUUID(),
            quoteId: quote.id,
            consent: true,
            automaticKnownCostPolicy: 'known-cost-v1',
          },
        };
      };
      const receipt = async (projectId) => {
        const jobs = (
          await db.query(
            'SELECT j.*,r.status AS reserve_status,r.actual_micros AS reserve_actual,h.status AS hold_status,h.captured_subunits FROM live_authoring_text_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id JOIN spark_holds h ON h.id=j.spark_quote_id WHERE j.project_id=$1',
            [projectId],
          )
        ).rows;
        assert.equal(jobs.length, 1);
        const job = jobs[0];
        const ledger = (
          await db.query('SELECT * FROM spark_ledger WHERE hold_id=$1 ORDER BY event_key', [
            job.spark_quote_id,
          ])
        ).rows;
        assert.equal(job.actual_micros, '300');
        assert.equal(job.reserve_actual, '300');
        assert.equal(job.reserve_status, 'settled');
        assert.equal(job.hold_status, 'settled');
        assert.equal(job.provider_usage.inputTokens, 100);
        assert.equal(job.provider_usage.outputTokens, 100);
        assert.equal(job.spark_cost_evidence, 'configured_rates');
        assert.equal(ledger.filter((entry) => entry.kind === 'capture').length, 1);
        assert.ok(Number(job.captured_subunits) > 0);
        return { job, ledger };
      };

      await t.test(
        'one exact request yields reviewable geometry, one charge, immutable private release and player movement',
        async (subtest) => {
          subtest.after(stopApi);
          const { prepared, quotedBody, dispatch } = await prepareAndQuote(story.id);
          await builder.dispatch(owner.user.id, prepared.id, dispatch);
          assert.equal(dispatched.length, 1);
          assert.equal(
            dispatched[0],
            quotedBody,
            'quote bytes equal actual bounded transport bytes',
          );
          const proposed = await builder.state(owner.user.id, prepared.id);
          assert.equal(proposed.status, 'proposed');
          assert.equal(proposed.sourceCurrent, true);
          assert.equal(proposed.draft.maps.length, 2);
          assert.equal(proposed.draft.npcs.length, 5);
          for (const map of proposed.draft.maps) {
            assert.equal(map.spawns.length, 4);
            assert.equal(new Set(map.spawns.map((point) => `${point.x},${point.y}`)).size, 4);
            assert.equal(map.exits.length, 1);
            for (const point of [map.exits[0], map.exits[0].destination]) {
              assert.ok(Number.isInteger(point.x) && Number.isInteger(point.y));
            }
          }
          for (const npc of proposed.draft.npcs)
            assert.ok(Number.isInteger(npc.x) && Number.isInteger(npc.y));
          const paid = await receipt(prepared.id);
          assert.equal(paid.job.status, 'committed');
          assert.equal(paid.job.provider_request_id, 'synthetic-text-plan-1');
          await builder.dispatch(owner.user.id, prepared.id, dispatch);
          assert.equal(dispatched.length, 1);
          assert.deepEqual(
            await receipt(prepared.id),
            paid,
            'dispatch replay preserves the receipt and ledger',
          );
          const apply = {
            operationId: randomUUID(),
            sourceHash: prepared.sourceHash,
            reviewed: true,
            imageReuseConsent: true,
          };
          const applied = await builder.apply(owner.user.id, prepared.id, apply);
          assert.equal(applied.providerCalls, 0);
          assert.equal(applied.chargeMicros, 0);
          assert.deepEqual(await builder.apply(owner.user.id, prepared.id, apply), applied);
          assert.equal((await builder.state(owner.user.id, prepared.id)).sourceCurrent, true);
          assert.equal(dispatched.length, 1);
          assert.deepEqual(await receipt(prepared.id), paid);

          await startApi();
          const fresh = await owner.request(`/studio/adventures/${story.id}`);
          const draft = await owner.request(`/studio/adventures/${story.id}/playable-draft`);
          const artRevision = (
            await db.query('SELECT revision FROM art_story_asset_drafts WHERE adventure_id=$1', [
              story.id,
            ])
          ).rows[0].revision;
          const releaseRequest = {
            operationId: randomUUID(),
            expectedEditRevision: fresh.editRevision,
            expectedGameRevision: draft.revision,
            expectedArtRevision: artRevision,
          };
          const released = await owner.request(
            `/studio/adventures/${story.id}/private-release`,
            releaseRequest,
          );
          assert.ok(released.playableVersionId);
          assert.deepEqual(
            await owner.request(`/studio/adventures/${story.id}/private-release`, releaseRequest),
            released,
          );
          const frozen = (
            await db.query('SELECT package,checksum FROM game_playable_versions WHERE id=$1', [
              released.playableVersionId,
            ])
          ).rows[0];
          const { campaignId } = await owner.request('/game/campaigns', {
            playableVersionId: released.playableVersionId,
            turnBased: true,
          });
          await connect(owner, campaignId);
          const before = await snapshot(owner, campaignId);
          gameEnvelopeSchema.parse(before);
          assert.equal(before.projection.map.id, 'hall');
          assert.notEqual(before.projection.map.spatialMode, 'location_only');
          assert.notEqual(before.projection.spatialRecoveryRequired, true);
          assert.deepEqual([actor(before).x, actor(before).y], [2, 2]);
          assert.ok(!JSON.stringify(before).includes('TEXT_PLAN_PRIVATE_CANARY'));
          const player = actor(before);
          const movement = {
            operationId: randomUUID(),
            turnFence: {
              roundId: before.projection.turn.roundId,
              phaseEpoch: before.projection.turn.phaseEpoch,
              rulesetVersion: 1,
            },
            connectionEpoch: before.connectionEpoch,
            inputSeq: (player.lastInputSeq ?? 0) + 1,
            movementGeneration: player.movementGeneration ?? 0,
            target: { x: 3, y: 2 },
          };
          await owner.request(`/game/campaigns/${campaignId}/move`, movement);
          const moved = await until(
            () => snapshot(owner, campaignId),
            (state) => actor(state).x === 3 && actor(state).y === 2,
          );
          gameEnvelopeSchema.parse(moved);
          assert.deepEqual([actor(moved).x, actor(moved).y], [3, 2]);
          assert.deepEqual(
            (
              await db.query('SELECT package,checksum FROM game_playable_versions WHERE id=$1', [
                released.playableVersionId,
              ])
            ).rows[0],
            frozen,
          );
          await stopApi();
          assert.equal(dispatched.length, 1);
          assert.deepEqual(
            await receipt(prepared.id),
            paid,
            'release/start/movement never re-charge authoring',
          );
        },
      );

      await t.test(
        'missing positions fail before compilation while preserving known usage and one capture without retry',
        async () => {
          mode = 'missing_positions';
          const { prepared, quotedBody, dispatch } = await prepareAndQuote(malformedStory.id);
          await builder.dispatch(owner.user.id, prepared.id, dispatch);
          assert.equal(dispatched.length, 2);
          assert.equal(dispatched[1], quotedBody);
          const state = await builder.state(owner.user.id, prepared.id);
          assert.equal(state.status, 'prepared');
          assert.equal(state.draft, null);
          assert.equal(state.sourceCurrent, true);
          assert.equal(state.jobs[0].error_code, 'AUTHORING_PROPOSAL_INVALID');
          const paid = await receipt(prepared.id);
          assert.equal(paid.job.status, 'failed');
          assert.equal(paid.job.proposal, null);
          assert.equal(paid.job.provider_request_id, 'synthetic-text-plan-2');
          await builder.dispatch(owner.user.id, prepared.id, dispatch);
          await assert.rejects(() =>
            builder.apply(owner.user.id, prepared.id, {
              operationId: randomUUID(),
              sourceHash: prepared.sourceHash,
              reviewed: true,
              imageReuseConsent: true,
            }),
          );
          assert.equal(dispatched.length, 2);
          assert.deepEqual(await receipt(prepared.id), paid);
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int AS n FROM adventure_game_drafts WHERE adventure_id=$1',
                [malformedStory.id],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int AS n FROM game_playable_versions WHERE adventure_id=$1',
                [malformedStory.id],
              )
            ).rows[0].n,
            0,
          );
        },
      );

      await t.test(
        'a later source edit still fences a quoted plan before another dispatch or charge',
        async () => {
          mode = 'valid';
          const { prepared, dispatch } = await prepareAndQuote(changedStory.id);
          const ledger = (
            await db.query('SELECT * FROM spark_ledger WHERE owner_id=$1 ORDER BY event_key', [
              owner.user.id,
            ])
          ).rows;
          await startApi();
          await owner.request(
            `/studio/adventures/${changedStory.id}`,
            { synopsis: 'Changed after the exact plan was quoted.' },
            'PATCH',
          );
          await stopApi();
          assert.equal((await builder.state(owner.user.id, prepared.id)).sourceCurrent, false);
          await assert.rejects(
            () => builder.dispatch(owner.user.id, prepared.id, dispatch),
            (error) => error.getResponse?.().code === 'STORY_CONTEXT_STALE',
          );
          assert.equal(dispatched.length, 2);
          assert.deepEqual(
            (
              await db.query('SELECT * FROM spark_ledger WHERE owner_id=$1 ORDER BY event_key', [
                owner.user.id,
              ])
            ).rows,
            ledger,
          );
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int AS n FROM live_authoring_text_jobs WHERE project_id=$1',
                [prepared.id],
              )
            ).rows[0].n,
            0,
          );
        },
      );
    } finally {
      await stopApi();
      await database.pool.end();
      await db.end();
    }
  },
);
