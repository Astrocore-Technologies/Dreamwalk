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
  connect,
  snapshot,
  actor,
  command,
  until,
} from './support-runtime.mjs';
import { requestEstimateOwnerProfile } from '../images/owner-config-fixture.mjs';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { Db } = require('../../apps/api/dist/db');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service');
const { normalizeRaster, storeRasterTx } = require('../../apps/api/dist/assets/raster');
const { StoryBuildService } = require('../../apps/api/dist/game/story-build.service');
const { storyPlanDefinition } = require('../../apps/api/dist/game/story-plan');
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
const { turnFence } = require('../../packages/game-core/dist');
const database = new Db();
const persistedFence = async (id) =>
  turnFence((await db.query('SELECT state FROM game_campaigns WHERE id=$1', [id])).rows[0].state);
await test(
  'uncertain original map: one consented semantic plan, apply/start, private ordinary dialogue and reload',
  { timeout: 120000 },
  async () => {
    let encounterGame;
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
            proposal: {
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
                    rows: Array(24).fill('?'.repeat(24)),
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
            },
            requestId: `synthetic-${randomUUID()}`,
            usage: {
              inputTokens: 100,
              outputTokens: 100,
              costMicros: 30,
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
      const dispatch = { operationId: randomUUID(), quoteId: quote.id, consent: true };
      await builder.dispatch(owner.user.id, prepared.id, dispatch);
      await builder.dispatch(owner.user.id, prepared.id, dispatch);
      assert.equal(dispatches, 1);
      const proposed = await builder.state(owner.user.id, prepared.id);
      assert.equal(proposed.status, 'proposed');
      const authoringJobs = (
        await db.query(
          'SELECT j.status,r.status AS reserve_status,j.spark_quote_id FROM live_authoring_text_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.project_id=$1',
          [prepared.id],
        )
      ).rows;
      assert.equal(authoringJobs.length, 1);
      assert.equal(authoringJobs[0].status, 'committed');
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
      const applied = await builder.apply(owner.user.id, prepared.id, apply);
      assert.deepEqual(await builder.apply(owner.user.id, prepared.id, apply), applied);
      assert.equal(dispatches, 1);
      assert.equal(
        (
          await db.query('SELECT map_id FROM studio_location_images WHERE adventure_id=$1', [
            story.id,
          ])
        ).rows[0].map_id,
        'tower',
      );
      await startApi();
      const currentStory = await owner.request(`/studio/adventures/${story.id}`);
      const version = await owner.request(`/studio/adventures/${story.id}/private-release`, {
        operationId: randomUUID(),
        expectedEditRevision: currentStory.editRevision,
        expectedGameRevision: applied.playableRevision,
        expectedArtRevision: 1,
      });
      const { campaignId } = await owner.request('/game/campaigns', {
        playableVersionId: version.playableVersionId,
        turnBased: false,
      });
      const invitation = await owner.request(`/studio/adventures/${story.id}/invitations`, {
        handle: guest.handle,
      });
      await guest.request(`/invitations/${invitation.id}/respond`, { decision: 'accept' });
      await owner.request(`/game/campaigns/${campaignId}/invitations`, { username: guest.handle });
      await guest.request(`/game/campaigns/${campaignId}/accept`, {});
      const offstageInvitation = await owner.request(`/studio/adventures/${story.id}/invitations`, {
        handle: offstage.handle,
      });
      await offstage.request(`/invitations/${offstageInvitation.id}/respond`, {
        decision: 'accept',
      });
      await owner.request(`/game/campaigns/${campaignId}/invitations`, {
        username: offstage.handle,
      });
      await offstage.request(`/game/campaigns/${campaignId}/accept`, {});
      // Seed an already-canonical separate encounter in this disposable fixture,
      // with the API stopped so no live writer can overwrite the test checkpoint.
      await stopApi();
      const separated = (
        await db.query('SELECT state FROM game_campaigns WHERE id=$1', [campaignId])
      ).rows[0].state;
      const offstageId = `player-${offstage.user.id}`;
      separated.entities[offstageId].sceneId = 'archive';
      for (const scene of separated.maps.tower.scenePresence.scenes)
        scene.participantIds = scene.participantIds.filter((id) => id !== offstageId);
      separated.maps.tower.scenePresence.scenes
        .find((s) => s.id === 'archive')
        .participantIds.push(offstageId);
      const checkpoint = await db.connect();
      try {
        await checkpoint.query('BEGIN');
        await checkpoint.query(
          'UPDATE game_campaigns SET state=$2,revision=revision+1 WHERE id=$1',
          [campaignId, JSON.stringify(separated)],
        );
        await checkpoint.query(
          'UPDATE game_snapshots SET state=$2,checksum=$3 WHERE campaign_id=$1',
          [campaignId, JSON.stringify(separated), hash(JSON.stringify(canonical(separated)))],
        );
        await checkpoint.query('COMMIT');
      } catch (error) {
        await checkpoint.query('ROLLBACK');
        throw error;
      } finally {
        checkpoint.release();
      }
      await startApi();
      await connect(owner, campaignId);
      const before = await snapshot(owner, campaignId);
      assert.equal(actor(before).spatialMode, 'location_only');
      assert.equal(actor(before).x, undefined);
      assert.equal(actor(before).y, undefined);
      assert.ok(before.projection.entities.some((e) => e.id === npc.id));
      assert.ok(!before.projection.entities.some((e) => e.id === hidden.id));
      assert.ok(!JSON.stringify(before).includes(hidden.id));
      const finishRound = async () => {
        for (let i = 0; i < 3; i++) {
          const state = (
            await db.query('SELECT state FROM game_campaigns WHERE id=$1', [campaignId])
          ).rows[0].state;
          if (state.turnController.phase !== 'player') break;
          const next = [owner, guest, offstage].find(
            (c) => `player-${c.user.id}` === state.turnController.activeActorId,
          );
          const result = await command(next, campaignId, {
            protocolVersion: 1,
            operationId: randomUUID(),
            type: 'turn.end',
            turnFence: turnFence(state),
          });
          assert.equal(result.status, 'committed', result.code);
        }
      };
      const awaitPlayerRound = () =>
        until(
          () => snapshot(owner, campaignId),
          (s) =>
            s.projection.turn.phase === 'player' &&
            s.projection.turn.activeActorId === `player-${owner.user.id}`,
        );
      const op = {
        protocolVersion: 1,
        operationId: randomUUID(),
        type: 'npc.speech',
        turnFence: await persistedFence(campaignId),
        npcId: npc.id,
        speech: { channel: 'whisper', text: 'PRIVATE_LOCATION_DIALOGUE: How are you?' },
      };
      const said = await command(owner, campaignId, op);
      assert.equal(said.status, 'committed', said.code);
      assert.ok(said.decisionRequestId);
      assert.equal(
        (await command(owner, campaignId, op)).decisionRequestId,
        said.decisionRequestId,
      );
      await finishRound();
      await until(
        () =>
          db.query(
            'SELECT r.status,j.status AS job_status FROM game_npc_decision_requests r LEFT JOIN npc_ai_jobs j ON j.id=r.job_id WHERE r.id=$1',
            [said.decisionRequestId],
          ),
        (r) => r.rows[0]?.job_status === 'committed',
      );
      assert.ok(
        !JSON.stringify(await snapshot(guest, campaignId)).includes('PRIVATE_LOCATION_DIALOGUE'),
      );
      await outsider.request(`/game/campaigns/${campaignId}/snapshot`, undefined, 'GET', 403);
      const saved = (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [campaignId]))
        .rows[0].state;
      assert.equal(saved.maps.tower.locationImage.revisionId, revision.id);
      assert.equal(saved.entities[npc.id].x, undefined);
      assert.equal(saved.npcUtterances.filter((u) => u.text === op.speech.text).length, 1);
      assert.equal(
        (
          await db.query(
            'SELECT count(*) FROM npc_ai_jobs j JOIN game_npc_decision_requests r ON r.job_id=j.id WHERE r.id=$1',
            [said.decisionRequestId],
          )
        ).rows[0].count,
        '1',
      );
      await awaitPlayerRound();
      const canon = (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [campaignId]))
        .rows[0].state;
      const narrativeInput = {
        operationId: randomUUID(),
        text: '*SCENE_ONLY_NARRATOR_INPUT: I listen to the room.*',
        channel: 'say',
        expectedCanonRevision: canon.narrativeCanon?.revision ?? 0,
        turnFence: turnFence(canon),
      };
      const narrativeQuote = await owner.request(
        `/game/campaigns/${campaignId}/turns/quote`,
        narrativeInput,
      );
      assert.equal(narrativeQuote.status, 'quoted');
      const narrativeSubmit = {
        ...narrativeInput,
        turnId: narrativeQuote.turnId,
        quoteId: narrativeQuote.quote.id,
        consent: true,
        confirmedActionHash: narrativeQuote.confirmationHash,
      };
      const narration = await owner.request(`/game/campaigns/${campaignId}/turns`, narrativeSubmit);
      await finishRound();
      await until(
        () =>
          db.query(
            'SELECT r.status,j.status AS job_status FROM game_npc_decision_requests r LEFT JOIN npc_ai_jobs j ON j.id=r.job_id WHERE r.id=$1',
            [narration.id],
          ),
        (r) => r.rows[0]?.job_status === 'committed',
      );
      const rows = (
        await db.query('SELECT audience_ids,entry FROM game_story_feed WHERE turn_id=$1', [
          narration.id,
        ])
      ).rows;
      assert.ok(rows.some((r) => r.entry.kind === 'narration'));
      assert.ok(
        rows.every((r) => !r.audience_ids.includes('*') && !r.audience_ids.includes(offstageId)),
      );
      await db.query(
        "INSERT INTO game_story_feed(id,turn_id,campaign_id,sequence,ordinal,tick,channel,audience_ids,entry) SELECT $1,turn_id,campaign_id,sequence,9999,tick,'say',ARRAY['*']::text[],$3::jsonb FROM game_story_feed WHERE turn_id=$2 LIMIT 1",
        [
          randomUUID(),
          narration.id,
          JSON.stringify({ kind: 'narration', channel: 'say', text: 'LEGACY_WILDCARD_CANARY' }),
        ],
      );
      await db.query(
        "INSERT INTO game_narrative_turns(id,campaign_id,requester_user_id,actor_id,operation_id,request_hash,expected_canon_revision,input_text,status,consent,result) VALUES($1,$2,$3,$4,$5,$6,0,'LEGACY_UNSCOPED_CANARY','committed',true,$7)",
        [
          said.decisionRequestId,
          campaignId,
          owner.user.id,
          `player-${owner.user.id}`,
          randomUUID(),
          hash('legacy fixture'),
          JSON.stringify({ narration: 'LEGACY_UNSCOPED_CANARY' }),
        ],
      );
      const ownFeed = await owner.request(`/game/campaigns/${campaignId}/turns/feed`);
      assert.ok(JSON.stringify(ownFeed).includes('SCENE_ONLY_NARRATOR_INPUT'));
      assert.ok(!JSON.stringify(ownFeed).includes('LEGACY_'));
      const otherFeed = await offstage.request(`/game/campaigns/${campaignId}/turns/feed`);
      assert.ok(!JSON.stringify(otherFeed).includes('SCENE_ONLY_NARRATOR_INPUT'));
      assert.ok(!JSON.stringify(otherFeed).includes('LEGACY_'));
      const fresh = (await db.query('SELECT state FROM game_campaigns WHERE id=$1', [campaignId]))
        .rows[0].state;
      const { extendContextHistory } = require('../../apps/api/dist/game/context-history');
      const { buildNarrativeContext } = require('../../packages/game-core/dist');
      const future = await extendContextHistory(
        database,
        { contextWindow: () => ({ effectiveContextTokens: 4096 }), packContext: (value) => value },
        campaignId,
        fresh,
        offstageId,
        {
          mode: 'director',
          channel: 'say',
          director: buildNarrativeContext(fresh, offstageId, 'Continue.'),
        },
        'story_turn',
      );
      assert.ok(!JSON.stringify(future).includes('SCENE_ONLY_NARRATOR_INPUT'));
      assert.ok(!JSON.stringify(future).includes('LEGACY_'));
      const canonTurn = fresh.narrativeCanon.turns.find((t) => t.id === narration.id);
      if (canonTurn) assert.ok(!canonTurn.audienceIds.includes(offstageId));
      await awaitPlayerRound();
      await stopApi();
      await startApi();
      const reloaded = await snapshot(owner, campaignId);
      assert.equal(actor(reloaded).spatialMode, 'location_only');
      assert.ok(!JSON.stringify(reloaded).includes('NEVER_RAW_SOURCE_SECRET'));
      assert.ok(!JSON.stringify(reloaded).includes(hidden.id));
      assert.equal(dispatches, 1);
      await stopApi();
      const { Auth } = require('../../apps/api/dist/auth');
      const { GameService } = require('../../apps/api/dist/game/game.service');
      const { PlayableService } = require('../../apps/api/dist/game/playable.service');
      const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service');
      const { MockNpcProvider } = require('../../apps/api/dist/ai/provider');
      const mockOptions = {};
      const runtimeProvider = new MockNpcProvider(mockOptions);
      let encounterCalls = 0;
      const originalGenerate = runtimeProvider.generate.bind(runtimeProvider);
      runtimeProvider.generate = async (request) => {
        if (request.purpose === 'story_turn') encounterCalls++;
        return originalGenerate(request);
      };
      const encounterProposal = (context) => {
        const candidates = context.sceneEncounterPolicy.candidates;
        assert.equal(candidates.length, 1);
        assert.ok(!JSON.stringify(candidates).includes(unresolved.id));
        assert.ok(!JSON.stringify(candidates).includes('Unplaced visitor'));
        assert.ok(!candidates.some((c) => c.npcId === hidden.id));
        assert.ok(!JSON.stringify(context).includes('NEVER_UNPLACED_SECRET'));
        const proposal = structuredClone(context.mockProposal);
        proposal.status = 'ready';
        proposal.code = null;
        proposal.steps = context.segments.map((segment) => ({
          segmentIndex: segment.index,
          action: null,
          reply: null,
          ...(segment.index === 0 ? { sceneEncounter: { npcId: candidates[0].npcId } } : {}),
        }));
        proposal.narrative = {
          narration: 'Someone joins the encounter.',
          newScene: null,
          newNpc: null,
          newItem: null,
          evidenceIds: [],
        };
        return proposal;
      };
      const auth = new Auth(database),
        runtimeArt = new AssetReuseService(database);
      const runtimeAi = new NpcAiEngine(database, runtimeProvider, { timeoutMs: 20000 });
      encounterGame = new GameService(
        database,
        auth,
        new PlayableService(database, auth, runtimeArt),
        runtimeAi,
        runtimeArt,
      );
      clearInterval(encounterGame.timer);
      const req = { headers: { cookie: owner.cookie } };
      await encounterGame.snapshot(req, campaignId);
      const live = encounterGame.live.get(campaignId);
      assert.equal(live.state.entities[hidden.id].unresolvedScenePresence, undefined);
      assert.equal(
        live.state.entities[unresolved.id].unresolvedScenePresence.sourceChecksum,
        live.state.narrativeSource.checksum,
      );
      const meetInput = {
        operationId: randomUUID(),
        text: '*I look for the unplaced visitor and meet them here*',
        channel: 'say',
        expectedCanonRevision: live.state.narrativeCanon?.revision ?? 0,
        turnFence: turnFence(live.state),
      };
      const meetQuote = await encounterGame.storyQuote(req, campaignId, meetInput);
      const meetSubmit = {
        ...meetInput,
        turnId: meetQuote.turnId,
        quoteId: meetQuote.quote.id,
        consent: true,
        confirmedActionHash: meetQuote.confirmationHash,
      };
      const meet = await encounterGame.storySubmit(req, campaignId, meetSubmit);
      const { endPlayerTurn } = require('../../packages/game-core/dist');
      for (let i = 0; i < 3 && live.state.turnController.phase === 'player'; i++) {
        const ended = endPlayerTurn(
          live.state,
          live.state.turnController.activeActorId,
          turnFence(live.state),
        );
        assert.equal(ended.error, undefined);
        await encounterGame.persist(campaignId, live, ended.state, 'test.location-only.end-turn');
      }
      await encounterGame.story.prepareWorldRequests(campaignId, live);
      const preparedMeet = (
        await db.query('SELECT context FROM game_npc_decision_requests WHERE id=$1', [meet.id])
      ).rows[0];
      mockOptions.proposal = encounterProposal(preparedMeet.context);
      await encounterGame.processDecisionRequests(campaignId, encounterGame.live.get(campaignId));
      const meetRequest = (
        await db.query(
          'SELECT job_id,status,result_code FROM game_npc_decision_requests WHERE id=$1',
          [meet.id],
        )
      ).rows[0];
      assert.ok(meetRequest?.job_id, JSON.stringify(meetRequest));
      await runtimeAi.run(meetRequest.job_id, async () => true);
      await until(
        () =>
          db.query(
            'SELECT j.status FROM game_npc_decision_requests r JOIN npc_ai_jobs j ON j.id=r.job_id WHERE r.id=$1',
            [meet.id],
          ),
        (r) => r.rows[0]?.status === 'result_received',
      );
      await encounterGame.processAi(campaignId, encounterGame.live.get(campaignId));
      assert.equal(
        (await db.query('SELECT status FROM game_story_turns WHERE id=$1', [meet.id])).rows[0]
          .status,
        'committed',
      );
      await encounterGame.storySubmit(req, campaignId, meetSubmit);
      assert.equal(encounterCalls, 1);
      const met = encounterGame.live.get(campaignId).state;
      assert.equal(
        met.entities[unresolved.id].sceneId,
        met.entities[`player-${owner.user.id}`].sceneId,
      );
      assert.ok(
        !met.npcUtterances.some((u) => u.speakerId === unresolved.id),
        'No stale pre-encounter voice',
      );
      await encounterGame.onModuleDestroy();
      encounterGame = undefined;
      await startApi();
      await connect(owner, campaignId);
      await awaitPlayerRound();
      const postEncounter = await command(owner, campaignId, {
        protocolVersion: 1,
        operationId: randomUUID(),
        type: 'npc.speech',
        turnFence: await persistedFence(campaignId),
        npcId: unresolved.id,
        speech: { channel: 'say', text: 'Hello, now that we have met.' },
      });
      assert.equal(postEncounter.status, 'committed');
      assert.ok(postEncounter.decisionRequestId);
      await finishRound();
      await until(
        () =>
          db.query(
            'SELECT j.status FROM game_npc_decision_requests r JOIN npc_ai_jobs j ON j.id=r.job_id WHERE r.id=$1',
            [postEncounter.decisionRequestId],
          ),
        (r) => r.rows[0]?.status === 'committed',
      );
      assert.equal(encounterCalls, 1);
    } finally {
      if (encounterGame) await encounterGame.onModuleDestroy();
      await stopApi();
      await database.pool.end();
      await db.end();
    }
  },
);
