/** Real disposable PostgreSQL, original synthetic raster, injected authoring provider and mock dialogue. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  db,
  startApi,
  stopApi,
  client,
  rejectedSocket,
  snapshot,
  actor,
} from './support-runtime.mjs';
import { requestEstimateOwnerProfile } from '../images/owner-config-fixture.mjs';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { Db } = require('../../apps/api/dist/db');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service');
const { normalizeRaster, storeRasterTx } = require('../../apps/api/dist/assets/raster');
const { StoryBuildService } = require('../../apps/api/dist/game/story-build.service');
const { storyPlanDefinition, compileStoryPlan } = require('../../apps/api/dist/game/story-plan');
const { AuthoringTextEngine } = require('../../apps/api/dist/live-test/authoring-text');
const { GenerationAuthority } = require('../../apps/api/dist/generation/service');
const { readGenerationConfig } = require('../../apps/api/dist/generation/config');
const { estimateTextRequest } = require('../../apps/api/dist/generation/estimates');
const { activateReleaseDeployment } = require('../images/release-deployment-fixture.cjs');
const hash = (v) => createHash('sha256').update(v).digest('hex');
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, value]) => [k, canonical(value)]),
        )
      : v;
const { turnFence, createStateFromPlayable } = require('../../packages/game-core/dist');
const database = new Db();
await test(
  'uncertain map rejects new play once; historical save reloads read-only without mutation or spend',
  { timeout: 120000 },
  async () => {
    try {
      assert.match(process.env.LOCAL_POSTGRES_CLUSTER ?? '', /^game-test-/);
      await startApi();
      const owner = await client().registerLegacyFixture(),
        guest = await client().registerLegacyFixture(),
        outsider = await client().registerLegacyFixture(),
        offstage = await client().registerLegacyFixture();
      const npc = await owner.request('/npcs', {
        name: 'Present keeper',
        description: 'Welcomes visitors in the hall.',
        secrets: 'NEVER_RAW_SOURCE_SECRET',
      });
      const hidden = await owner.request('/npcs', {
        name: 'Offstage archivist',
        description: 'Alone in a separate closed archive.',
        secrets: 'NEVER_ARCHIVE_SECRET',
      });
      const unresolved = await owner.request('/npcs', {
        name: 'Unplaced visitor',
        description: 'A visitor whose exact meeting place is not established.',
        secrets: 'NEVER_UNPLACED_SECRET',
      });
      const story = await owner.request('/studio/adventures', {
        title: 'Location-only tower',
        visibility: 'private',
        content: {
          locations: [
            { id: 'tower', name: 'Tower', description: 'A hall and separate private archive.' },
          ],
          npcIds: [npc.id, hidden.id, unresolved.id],
          scenes: [
            {
              id: 'welcome',
              participantNpcIds: [npc.id],
              name: 'Welcome',
              locationId: 'tower',
              description: 'Present keeper greets the arriving visitors in the hall.',
            },
            {
              id: 'archive',
              participantNpcIds: [hidden.id],
              name: 'Archive',
              locationId: 'tower',
              description: 'The archivist is alone and offstage.',
            },
          ],
          startSceneId: 'welcome',
        },
      });
      await stopApi();
      const art = new AssetReuseService(database);
      const raster = await normalizeRaster(
        await sharp({ create: { width: 96, height: 64, channels: 3, background: '#756b64' } })
          .png()
          .toBuffer(),
        'image/png',
        false,
      );
      const revision = await database.tx(async (c) => {
        await art.lockAuthor(c, owner.user.id);
        const uploadId = randomUUID();
        await storeRasterTx(c, owner.user.id, uploadId, raster);
        return art.registerTx(c, owner.user.id, {
          operationId: randomUUID(),
          uploadId,
          metadata: {
            title: 'Exact synthetic tower map',
            kind: 'background',
            style: 'drawn2D',
            camera: 'top-down',
            tags: ['test-fixture'],
            variant: 'location-only',
            provenance: {
              source: 'generated',
              provider: 'synthetic-offline-fixture',
              reference: 'No external calls',
            },
            rights: {
              basis: 'generated',
              licenseLabel: 'Test fixture',
              attribution: '',
              allowAuthorReuse: false,
              attested: true,
            },
          },
        });
      });
      await db.query(
        'INSERT INTO studio_location_images(adventure_id,location_id,owner_id,revision_id,source_hash,map_id) VALUES($1,$2,$3,$4,$5,NULL)',
        [story.id, 'tower', owner.user.id, revision.id, hash('synthetic source')],
      );
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
        GENERATION_CONFIG_JSON: JSON.stringify({
          ...profile,
          aggregateCapMicros: 10000000,
        }),
      });
      await database.tx((c) => activateReleaseDeployment(c, config));
      const authority = new GenerationAuthority(database, config);
      let dispatches = 0;
      let generatedProposal;
      const provider = {
        version: storyPlanDefinition.version,
        profile: {
          ...config.text,
          storyVision: { model: config.text.model, maxImages: 4, detail: 'high' },
        },
        prepareTextRequest(context) {
          const body = JSON.stringify({ version: storyPlanDefinition.version, context });
          return { body, snapshot: estimateTextRequest(body, config.text, this.version) };
        },
        async generate({ context }) {
          dispatches++;
          assert.equal(context.mapImages.length, 1);
          assert.equal(context.mapImages[0].revisionId, revision.id);
          assert.ok(!JSON.stringify(context).includes('NEVER_RAW_SOURCE_SECRET'));
          const image = context.mapImages[0];
          return {
            proposal: (generatedProposal = {
              version: 1,
              rooms: [
                {
                  locationId: 'tower',
                  width: 24,
                  height: 24,
                  spawns: [],
                  blocked: [],
                  surfaces: [],
                  spatialGrounding: {
                    version: 1,
                    imageRevisionId: image.revisionId,
                    imageSha256: image.sha256,
                    confidence: 0.2,
                    // No usable floor at all: server placement cannot start a game here.
                    rows: Array(24).fill('#'.repeat(24)),
                    landmarks: [],
                  },
                  scenePresence: {
                    version: 1,
                    entrySceneId: 'welcome',
                    scenes: [
                      {
                        id: 'welcome',
                        participantIds: [npc.id],
                        evidence: { kind: 'authored_scene', reference: 'welcome' },
                      },
                      {
                        id: 'archive',
                        participantIds: [hidden.id],
                        evidence: { kind: 'authored_scene', reference: 'archive' },
                      },
                      {
                        id: 'unresolved',
                        participantIds: [unresolved.id],
                        evidence: { kind: 'accepted_story_plan', reference: 'tower' },
                      },
                    ],
                  },
                },
              ],
              connections: [],
              npcs: [
                {
                  sourceNpcId: npc.id,
                  locationId: 'tower',
                  sceneId: 'welcome',
                  stock: [],
                },
                { sourceNpcId: hidden.id, locationId: 'tower', sceneId: 'archive', stock: [] },
                {
                  sourceNpcId: unresolved.id,
                  presenceUnspecified: true,
                  locationId: 'tower',
                  sceneId: 'unresolved',
                  stock: [],
                },
              ],
              items: [],
            }),
            requestId: `synthetic-${randomUUID()}`,
            usage: {
              inputTokens: 100,
              outputTokens: 100,
              costMicros: 300,
              costEvidence: 'configured_rates',
              costVerifiedForSparks: true,
            },
          };
        },
      };
      const engine = new AuthoringTextEngine(database, authority, provider, storyPlanDefinition);
      const builder = new StoryBuildService(database, art, engine);
      const prepared = await builder.prepare(owner.user.id, story.id, {
        operationId: randomUUID(),
      });
      const quote = await builder.quote(owner.user.id, prepared.id, { operationId: randomUUID() });
      const dispatch = {
        operationId: randomUUID(),
        quoteId: quote.id,
        consent: true,
        automaticKnownCostPolicy: 'known-cost-v1',
      };
      await builder.dispatch(owner.user.id, prepared.id, dispatch);
      await builder.dispatch(owner.user.id, prepared.id, dispatch);
      assert.equal(dispatches, 1);
      const proposed = await builder.state(owner.user.id, prepared.id);
      assert.equal(proposed.status, 'prepared');
      assert.equal(proposed.draft, null);
      assert.equal(proposed.jobs[0].error_code, 'MAP_IMAGE_UNSAFE_SPAWN');
      const authoringJobs = (
        await db.query(
          'SELECT j.status,r.status AS reserve_status,j.spark_quote_id FROM live_authoring_text_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.project_id=$1',
          [prepared.id],
        )
      ).rows;
      assert.equal(authoringJobs.length, 1);
      assert.equal(authoringJobs[0].status, 'stale');
      assert.equal(authoringJobs[0].reserve_status, 'settled');
      assert.equal(
        (
          await db.query("SELECT count(*) FROM spark_ledger WHERE hold_id=$1 AND kind='capture'", [
            authoringJobs[0].spark_quote_id,
          ])
        ).rows[0].count,
        '1',
      );

      const apply = {
        operationId: randomUUID(),
        sourceHash: prepared.sourceHash,
        reviewed: true,
        imageReuseConsent: true,
      };
      await assert.rejects(() => builder.apply(owner.user.id, prepared.id, apply));
      assert.equal(dispatches, 1);
      assert.equal(
        (
          await db.query('SELECT map_id FROM studio_location_images WHERE adventure_id=$1', [
            story.id,
          ])
        ).rows[0].map_id,
        null,
      );
      assert.equal(
        (
          await db.query('SELECT count(*) FROM game_playable_versions WHERE adventure_id=$1', [
            story.id,
          ])
        ).rows[0].count,
        '0',
      );
      assert.equal(
        (await db.query('SELECT count(*) FROM game_campaigns WHERE owner_id=$1', [owner.user.id]))
          .rows[0].count,
        '0',
      );

      // This is a historical-save fixture, not a back door in new game admission.
      // The compiler still reads old location-only data; only this stopped disposable
      // database receives it. No production save is modified or relocated.
      const source = (
        await db.query('SELECT source_snapshot FROM story_playable_builds WHERE project_id=$1', [
          prepared.id,
        ])
      ).rows[0].source_snapshot.source;
      // Only an image deliberately left unanalyzed still compiles to a location-only map.
      const omittedImage = source.mapImages[0];
      const historical = compileStoryPlan(
        {
          ...source,
          mapImages: undefined,
          omittedMapImages: [
            {
              locationId: omittedImage.locationId,
              revisionId: omittedImage.revisionId,
              sha256: omittedImage.sha256,
            },
          ],
        },
        {
          ...generatedProposal,
          rooms: generatedProposal.rooms.map(({ spatialGrounding: _grounding, ...room }) => room),
        },
      );
      await startApi();
      const { campaignId } = await owner.request('/game/campaigns', {
        template: 'observatory-v1',
        turnBased: true,
      });
      for (const member of [guest, offstage]) {
        await owner.request(`/game/campaigns/${campaignId}/invitations`, {
          username: member.handle,
        });
        await member.request(`/game/campaigns/${campaignId}/accept`, {});
      }
      await stopApi();
      const actorId = `player-${owner.user.id}`,
        guestId = `player-${guest.user.id}`,
        offstageId = `player-${offstage.user.id}`;
      const saved = createStateFromPlayable(historical.playable, [actorId, guestId, offstageId], 1);
      saved.entities[offstageId].sceneId = 'archive';
      for (const scene of saved.maps.tower.scenePresence.scenes)
        scene.participantIds = scene.participantIds.filter((id) => id !== offstageId);
      saved.maps.tower.scenePresence.scenes
        .find((scene) => scene.id === 'archive')
        .participantIds.push(offstageId);
      saved.artBindings = [
        { slot: 'map:tower:background', revisionId: revision.id, sha256: revision.sha256 },
      ];
      saved.npcUtterances = [
        {
          id: 'saved-private',
          speakerId: npc.id,
          tick: 0,
          text: 'PRIVATE_LOCATION_DIALOGUE',
          mapId: 'tower',
          audienceIds: [actorId],
          speakerKnownToIds: [actorId],
        },
      ];
      const checkpoint = await db.connect();
      try {
        await checkpoint.query('BEGIN');
        await checkpoint.query(
          'UPDATE game_campaigns SET state=$2,revision=revision+1,runtime_clock=$3 WHERE id=$1',
          [
            campaignId,
            JSON.stringify(saved),
            JSON.stringify({ paused: true, capturedAtMs: Date.now(), rounds: {}, jobs: {} }),
          ],
        );
        await checkpoint.query(
          'UPDATE game_snapshots SET state=$2,checksum=$3 WHERE campaign_id=$1',
          [campaignId, JSON.stringify(saved), hash(JSON.stringify(canonical(saved)))],
        );
        const historyId = randomUUID();
        await checkpoint.query(
          "INSERT INTO game_story_turns(id,campaign_id,requester_user_id,actor_id,operation_id,request_hash,input,segments,context,status) VALUES($1,$2,$3,$4,$5,'historical-fixture','{}','[]','{}','committed')",
          [historyId, campaignId, owner.user.id, actorId, randomUUID()],
        );
        for (const [ordinal, audience, text] of [
          [0, [actorId, guestId], 'SAVED_SCENE_HISTORY'],
          [1, ['*'], 'LEGACY_WILDCARD_CANARY'],
        ]) {
          await checkpoint.query(
            "INSERT INTO game_story_feed(id,turn_id,campaign_id,sequence,ordinal,tick,channel,audience_ids,entry) VALUES($1,$2,$3,0,$4,0,'say',$5,$6)",
            [
              randomUUID(),
              historyId,
              campaignId,
              ordinal,
              audience,
              JSON.stringify({ kind: 'narration', channel: 'say', text }),
            ],
          );
        }
        await checkpoint.query('COMMIT');
      } catch (error) {
        await checkpoint.query('ROLLBACK');
        throw error;
      } finally {
        checkpoint.release();
      }
      const immutable = async () => ({
        campaign: (
          await db.query(
            'SELECT state,revision,event_seq,runtime_clock FROM game_campaigns WHERE id=$1',
            [campaignId],
          )
        ).rows[0],
        snapshot: (
          await db.query(
            'SELECT state,checksum,sequence FROM game_snapshots WHERE campaign_id=$1',
            [campaignId],
          )
        ).rows[0],
        events: (
          await db.query('SELECT count(*) FROM game_events WHERE campaign_id=$1', [campaignId])
        ).rows[0].count,
        jobs: (
          await db.query('SELECT count(*) FROM npc_ai_jobs WHERE campaign_id=$1', [campaignId])
        ).rows[0].count,
        requests: (
          await db.query('SELECT count(*) FROM game_npc_decision_requests WHERE campaign_id=$1', [
            campaignId,
          ])
        ).rows[0].count,
        quotes: (
          await db.query('SELECT count(*) FROM npc_ai_quotes WHERE campaign_id=$1', [campaignId])
        ).rows[0].count,
        ledger: (
          await db.query('SELECT * FROM spark_ledger WHERE owner_id=$1 ORDER BY id', [
            owner.user.id,
          ])
        ).rows,
        feed: (
          await db.query('SELECT * FROM game_story_feed WHERE campaign_id=$1 ORDER BY id', [
            campaignId,
          ])
        ).rows,
      });
      const preserved = await immutable();
      await startApi();
      const before = await snapshot(owner, campaignId);
      assert.equal(before.paused, true);
      assert.equal(before.projection.spatialRecoveryRequired, true);
      assert.equal(actor(before).spatialMode, 'location_only');
      assert.equal(actor(before).x, undefined);
      assert.equal(actor(before).y, undefined);
      assert.ok(before.projection.entities.some((e) => e.id === npc.id));
      assert.ok(!JSON.stringify(before).includes(hidden.id));
      assert.ok(!JSON.stringify(before).includes(unresolved.id));
      assert.ok(!JSON.stringify(before).includes('NEVER_RAW_SOURCE_SECRET'));
      assert.ok(
        !JSON.stringify(await snapshot(guest, campaignId)).includes('PRIVATE_LOCATION_DIALOGUE'),
      );
      await outsider.request(`/game/campaigns/${campaignId}/snapshot`, undefined, 'GET', 403);
      assert.equal(await rejectedSocket(owner, campaignId), 403);
      const input = {
        operationId: randomUUID(),
        text: 'Continue from the saved scene.',
        channel: 'say',
        expectedCanonRevision: saved.narrativeCanon?.revision ?? 0,
        turnFence: turnFence(saved),
      };
      for (const path of ['turns/quote', 'world-generation/quote']) {
        const result = await owner.request(
          `/game/campaigns/${campaignId}/${path}`,
          input,
          'POST',
          409,
        );
        assert.equal(result.code, 'MAP_GRID_RECOVERY_REQUIRED');
      }
      for (const body of [
        { type: 'turn.end' },
        {
          type: 'npc.speech',
          npcId: npc.id,
          speech: { channel: 'whisper', text: 'Do not dispatch.' },
        },
        { type: 'action', action: { kind: 'travel', targetId: 'tower' } },
      ]) {
        const result = await owner.request(
          `/game/campaigns/${campaignId}/commands`,
          { protocolVersion: 1, operationId: randomUUID(), turnFence: turnFence(saved), ...body },
          'POST',
          409,
        );
        assert.equal(result.code, 'MAP_GRID_RECOVERY_REQUIRED');
      }
      const ownFeed = await owner.request(`/game/campaigns/${campaignId}/turns/feed`);
      assert.ok(JSON.stringify(ownFeed).includes('SAVED_SCENE_HISTORY'));
      assert.ok(JSON.stringify(ownFeed).includes('PRIVATE_LOCATION_DIALOGUE'));
      assert.ok(!JSON.stringify(ownFeed).includes('LEGACY_WILDCARD_CANARY'));
      const otherFeed = await offstage.request(`/game/campaigns/${campaignId}/turns/feed`);
      assert.ok(!JSON.stringify(otherFeed).includes('SAVED_SCENE_HISTORY'));
      assert.ok(!JSON.stringify(otherFeed).includes('PRIVATE_LOCATION_DIALOGUE'));
      assert.ok(!JSON.stringify(otherFeed).includes('LEGACY_WILDCARD_CANARY'));
      assert.equal(saved.maps.tower.locationImage.revisionId, revision.id);
      assert.deepEqual(
        await immutable(),
        preserved,
        'read-only reads/rejections do not change state, clock, history, jobs, quotes or billing',
      );
      await stopApi();
      await startApi();
      const reloaded = await snapshot(owner, campaignId);
      assert.equal(actor(reloaded).spatialMode, 'location_only');
      assert.equal(reloaded.projection.spatialRecoveryRequired, true);
      assert.ok(!JSON.stringify(reloaded).includes(hidden.id));
      assert.ok(!JSON.stringify(reloaded).includes('NEVER_RAW_SOURCE_SECRET'));
      assert.deepEqual(
        await immutable(),
        preserved,
        'restart does not silently repair or resume legacy save',
      );
      assert.equal(dispatches, 1);
    } finally {
      await stopApi();
      await database.pool.end();
      await db.end();
    }
  },
);
