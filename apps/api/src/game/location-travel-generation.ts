import {
  assertPresentationAliasAuthority,
  storedPresentationAliases,
} from './presentation-aliases';
import {
  reconcileTerminalTravelGrounding,
  resolvedTerminalTravelGroundings,
} from './travel-map-grounding-reconciliation';
import { TravelMapGrounding, type TravelGroundingEntry } from './travel-map-grounding';
import type { AuthoringTextEngine } from '../live-test/authoring-text';
import { digest } from '../ai/context';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  storyTurnProposalSchema,
  storyTravelIntentSchema,
  type GameState,
  type StoryQuote,
  type StoryTurnProposal,
} from '@dreamwalk/contracts';
import {
  applyNarrativeProposal,
  applyStoryTurnProposal,
  createMockStoryTurnProposal,
  buildNarrativeContext,
  buildStoryTurnContext,
  matchesTurnFence,
  normalizeLocationName,
  turnFence,
  parseStorySegments,
  type PresentationAliases,
} from '@dreamwalk/game-core';
import { Db } from '../db';
import { fail } from '../errors';
import { ImageGenerationEngine } from '../image-generation/service';
import { generationRequestSchema, type GenerationRequest } from '../image-generation/contracts';
import { AssetReuseService } from '../assets/reuse.service';
import { prepareSceneMedia } from './media-preparation';
import { sourceAccessSql } from './source-access';
export type TravelMediaEntry = {
  preparationId: string;
  imageQuoteId: string;
  quote: StoryQuote;
  automaticKnownCostPolicyHash?: string;
  grounding: TravelGroundingEntry;
};
/** A future scene uses an exact image request fixed before consent, never a blanket future allowance. */
export class LocationTravelGeneration {
  private grounding?: TravelMapGrounding;
  constructor(
    private db: Db,
    private images: ImageGenerationEngine,
    private art: AssetReuseService,
    groundingEngine?: AuthoringTextEngine,
  ) {
    if (groundingEngine)
      this.grounding = new TravelMapGrounding(db, art, groundingEngine, (c, user, row) =>
        this.validate(c, user, row),
      );
    images.attachTravelValidator((c, actor, input) => this.authorizeImage(c, actor, input));
  }
  private async source(c: Pick<PoolClient, 'query'>, userId: string, campaignId: string) {
    const row = (
      await c.query(
        `SELECT c.state,c.source_version_id,v.checksum AS source_checksum,v.adventure_id
      FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id
      JOIN users u ON u.id=c.owner_id
      WHERE c.id=$1 AND c.owner_id=$2 AND c.status='active' AND u.deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM game_members m WHERE m.campaign_id=c.id AND m.user_id=$2 AND m.status='accepted')
      AND ${sourceAccessSql('$2')} FOR SHARE OF c,v,u`,
        [campaignId, userId],
      )
    ).rows[0];
    return row ?? fail(403, 'FORBIDDEN', 'FORBIDDEN');
  }
  private async compatibleCanon(
    c: Pick<PoolClient, 'query'>,
    row: QueryResultRow,
    state: GameState,
  ) {
    const before = row.canon_snapshot ?? { revision: 0, turns: [] };
    const current = state.narrativeCanon ?? { revision: 0, turns: [] };
    if (digest(before) === digest(current)) return true;
    if (!row.batch_id || current.turns.length < before.turns.length) return false;
    const prefix = {
      ...current,
      revision: before.revision,
      turns: current.turns.slice(0, before.turns.length),
    };
    if (digest(prefix) !== digest(before)) return false;
    const added = current.turns.slice(before.turns.length);
    if (current.revision !== before.revision + added.length) return false;
    const committed = (
      await c.query(
        "SELECT id,actor_id,scene FROM game_location_travel_preparations WHERE batch_id=$1 AND state='committed'",
        [row.batch_id],
      )
    ).rows;
    return added.every((turn) =>
      committed.some(
        (sibling) =>
          sibling.id === turn.id &&
          sibling.actor_id !== row.actor_id &&
          turn.sceneId === `scene-${sibling.id}` &&
          !turn.introducedNpc &&
          turn.introducedScene?.name === sibling.scene.name &&
          turn.introducedScene?.description === sibling.scene.description,
      ),
    );
  }
  private async validate(c: Pick<PoolClient, 'query'>, userId: string, row: QueryResultRow) {
    const source = await this.source(c, userId, row.campaign_id),
      state = source.state as GameState;
    const actorAllowed = await c.query(
      `SELECT 1 FROM game_members m JOIN users u ON u.id=m.user_id
      JOIN game_campaigns c ON c.id=m.campaign_id WHERE m.campaign_id=$1 AND m.actor_id=$2
      AND m.status='accepted' AND u.deleted_at IS NULL AND ${sourceAccessSql('m.user_id')}`,
      [row.campaign_id, row.actor_id],
    );
    if (
      !actorAllowed.rowCount ||
      row.owner_id !== userId ||
      row.state === 'failed' ||
      row.state === 'committed' ||
      state.entities[row.actor_id]?.mapId !== row.origin_map_id ||
      source.source_version_id !== row.source_version_id ||
      source.source_checksum !== row.source_checksum ||
      !(await this.compatibleCanon(c, row, state)) ||
      !matchesTurnFence(state, row.turn_fence)
    )
      fail(409, 'LOCATION_PREPARATION_STALE', 'LOCATION_PREPARATION_STALE');
    return source;
  }
  async authorizeImage(c: PoolClient, userId: string, input: GenerationRequest) {
    const row = (
      await c.query('SELECT * FROM game_location_travel_preparations WHERE id=$1 FOR SHARE', [
        input.travelContext!.preparationId,
      ])
    ).rows[0];
    if (!row) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    await this.validate(c, userId, row);
    // The native authorizer adds its verified durable authorization ID. All actual image inputs stay exact.
    const comparable = { ...input };
    delete comparable.generationAuthorizationId;
    if (digest(comparable) !== row.input_hash)
      fail(409, 'LOCATION_MEDIA_CHANGED', 'LOCATION_MEDIA_CHANGED');
  }
  private async failUnspent(campaignId: string, requestId: string, code: string) {
    return this.db.tx(async (c) => {
      const changed = await c.query(
        `UPDATE game_npc_decision_requests r SET status='failed',result_code=$3
        WHERE r.campaign_id=$1 AND r.id=$2 AND r.status='queued' AND r.job_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM npc_ai_jobs j WHERE j.operation_id=r.id OR j.request_meta->>'runtimeRequestId'=r.id::text)
        AND NOT EXISTS(SELECT 1 FROM live_test_text_permits p WHERE p.request_id=r.id)
        AND NOT EXISTS(SELECT 1 FROM spark_holds h WHERE h.source_id=r.id::text)
        AND NOT EXISTS(SELECT 1 FROM game_location_travel_preparations p JOIN image_generation_jobs j ON j.id=p.image_job_id WHERE p.id=r.id)
        RETURNING id`,
        [campaignId, requestId, code],
      );
      if (!changed.rowCount) return false;
      await c.query(
        "UPDATE game_story_turns SET result_code=$2 WHERE id=$1 AND status='committed' AND erased_at IS NULL",
        [requestId, code],
      );
      await c.query(
        "UPDATE game_location_travel_preparations SET state='failed' WHERE id=$1 AND state='prepared' AND image_job_id IS NULL",
        [requestId],
      );
      return true;
    });
  }
  async prepare(
    userId: string,
    campaignId: string,
    state: GameState,
    mode: 'mock' | 'external' = 'external',
  ) {
    const requests = await this.db.query(
      `SELECT r.id,r.context,t.actor_id FROM game_npc_decision_requests r
      JOIN game_story_turns t ON t.id=r.id WHERE r.campaign_id=$1 AND r.purpose='story_turn'
      AND r.status='queued' AND r.job_id IS NULL AND r.context->>'worldPrepared'='true'
      AND t.erased_at IS NULL ORDER BY r.created_at,r.id`,
      [campaignId],
    );
    const destinations = new Set<string>(),
      actors = new Set<string>(),
      connections = new Set<string>();
    for (const request of requests) {
      const travels = request.context.travelRequests as
        { destinationName: string; mapId: string | null; ambiguous: boolean }[] | undefined;
      if (!travels?.length) continue;
      if (travels.length !== 1 || travels[0].ambiguous) {
        await this.failUnspent(campaignId, request.id, 'AMBIGUOUS');
        continue;
      }
      if (travels[0].mapId) continue;
      const pendingSegments = parseStorySegments(request.context.worldInput?.text ?? '');
      if (
        pendingSegments.code ||
        pendingSegments.segments.length !== 1 ||
        pendingSegments.segments[0].kind !== 'attempt'
      ) {
        await this.failUnspent(campaignId, request.id, 'LOCATION_TRAVEL_SEPARATE_POST');
        continue;
      }
      if (!this.grounding)
        fail(409, 'LOCATION_GROUNDING_UNAVAILABLE', 'LOCATION_GROUNDING_UNAVAILABLE');
      try {
        const destinationKey = normalizeLocationName(travels[0].destinationName);
        if (destinations.has(destinationKey) || actors.has(request.actor_id)) {
          await this.failUnspent(campaignId, request.id, 'LOCATION_ALREADY_PREPARING');
          continue;
        }
        destinations.add(destinationKey);
        actors.add(request.actor_id);
        const row = await this.db.tx(async (c) => {
          const source = await this.source(c, userId, campaignId);
          const prior = (
            await c.query(
              'SELECT * FROM game_location_travel_preparations WHERE id=$1 FOR UPDATE',
              [request.id],
            )
          ).rows[0];
          if (prior) {
            await this.validate(c, userId, prior);
            return prior;
          }
          const intent = request.context.worldInput?.text;
          if (typeof intent !== 'string')
            fail(409, 'LOCATION_PREPARATION_STALE', 'LOCATION_PREPARATION_STALE');
          const context = buildNarrativeContext(
            state,
            request.actor_id,
            intent,
            'en',
            undefined,
            true,
          );
          const connection = context.availableConnections.find(
            (point) =>
              !connections.has(`${state.entities[request.actor_id].mapId}:${point.x}:${point.y}`),
          );
          if (!connection) fail(409, 'PATH_BLOCKED', 'PATH_BLOCKED');
          const semantic = storyTravelIntentSchema.safeParse(request.context.semanticTravelIntent);
          const scene = {
            name: travels[0].destinationName,
            description: semantic.success
              ? semantic.data.description
              : `A new place in this story: ${travels[0].destinationName}.`,
            template: semantic.success
              ? semantic.data.template
              : /(?:park|forest|garden|square|парк|лес|ліс|сад|площад|площ)/iu.test(
                    travels[0].destinationName,
                  )
                ? ('courtyard' as const)
                : ('room' as const),
            connection: {
              fromMapId: state.entities[request.actor_id].mapId,
              ...connection,
            },
          };
          const preview = applyNarrativeProposal(
            state,
            request.actor_id,
            {
              turnId: request.id,
              contextHash: context.contextHash,
              narration: scene.description,
              newScene: scene,
              newNpc: null,
              actions: [],
              evidenceIds: [],
            },
            intent,
            'en',
            undefined,
            true,
          );
          if (preview.error)
            fail(409, 'LOCATION_GENERATION_UNAVAILABLE', 'LOCATION_GENERATION_UNAVAILABLE');
          // This preview is never persisted as campaign state or shown as a completed arrival.
          preview.state.entities[request.actor_id].mapId = `scene-${request.id}`;
          const prepared = prepareSceneMedia(
            preview.state,
            request.actor_id,
            source.source_version_id,
            { kind: 'background' },
          );
          const imageInput = generationRequestSchema.parse({
            requestPolicyVersion: 2,
            ...(mode === 'external' ? { automaticKnownCostPolicy: 'known-cost-v1' } : {}),
            adventureId: source.adventure_id,
            travelContext: { preparationId: request.id },
            prompt: prepared.prompt,
            title: scene.name,
            kind: prepared.spec.kind,
            camera: prepared.spec.camera,
            tags: prepared.spec.tags,
            background: prepared.spec.background,
            referenceRevisionIds: prepared.spec.referenceRevisionIds,
            framingVersion: prepared.spec.framingVersion,
            imageFraming: prepared.spec.imageFraming,
            mode,
            declineReuse: true,
            rights: {
              basis: 'generated',
              licenseLabel: 'AI-generated original',
              attribution: '',
              allowAuthorReuse: false,
              attested: true,
            },
          });
          const stored = (
            await c.query(
              `INSERT INTO game_location_travel_preparations
          (id,campaign_id,owner_id,actor_id,source_version_id,source_checksum,origin_map_id,canon_revision,turn_fence,scene,input_hash,image_input,canon_snapshot)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
              [
                request.id,
                campaignId,
                userId,
                request.actor_id,
                source.source_version_id,
                source.source_checksum,
                state.entities[request.actor_id].mapId,
                state.narrativeCanon?.revision ?? 0,
                JSON.stringify(turnFence(state)),
                JSON.stringify(scene),
                digest(imageInput),
                JSON.stringify(imageInput),
                JSON.stringify(state.narrativeCanon ?? { revision: 0, turns: [] }),
              ],
            )
          ).rows[0];
          return stored;
        });
        connections.add(`${row.origin_map_id}:${row.scene.connection.x}:${row.scene.connection.y}`);
        if (
          !row.image_quote ||
          (row.state === 'prepared' && Date.parse(row.image_quote.expiresAt) <= Date.now())
        ) {
          const quoted = await this.images.quote(userId, row.image_input);
          const nativeQuote =
            quoted.decision === 'quote' && 'quote' in quoted
              ? quoted.quote
              : fail(409, 'LOCATION_MEDIA_UNAVAILABLE', 'LOCATION_MEDIA_UNAVAILABLE');
          await this.db.query(
            "UPDATE game_location_travel_preparations SET image_quote=$2 WHERE id=$1 AND state='prepared' AND image_job_id IS NULL",
            [row.id, JSON.stringify(nativeQuote)],
          );
        }
        await this.grounding!.prepare(userId, row.id);
        // Exact scene name/template and pre-priced media input must survive the model unchanged.
        await this.db.query(
          `UPDATE game_npc_decision_requests SET context=context||jsonb_build_object('travelSceneSpec',$2::jsonb)||CASE WHEN context->'mockProposal'->'narrative'->'newScene' IS NOT NULL AND context->'mockProposal'->'narrative'->'newScene'<>'null'::jsonb THEN jsonb_build_object('mockProposal',jsonb_set(context->'mockProposal','{narrative,newScene}',$3::jsonb)) ELSE '{}'::jsonb END
        WHERE id=$1 AND status='queued' AND job_id IS NULL`,
          [
            request.id,
            JSON.stringify({
              scene: row.scene,
              imagePrompt: row.image_input.prompt,
            }),
            JSON.stringify(row.scene),
          ],
        );
      } catch (error) {
        const code = (error as { getResponse?: () => { code?: string } }).getResponse?.().code;
        if (
          code &&
          [
            'PATH_BLOCKED',
            'LOCATION_GENERATION_UNAVAILABLE',
            'LOCATION_PREPARATION_STALE',
            'MEDIA_CONTEXT_TOO_LARGE',
          ].includes(code) &&
          (await this.failUnspent(campaignId, request.id, code))
        )
          continue;
        throw error;
      }
    }
  }
  async quotes(
    c: PoolClient,
    userId: string,
    campaignId: string,
    requestIds: string[],
  ): Promise<TravelMediaEntry[]> {
    const rows = (
      await c.query(
        "SELECT * FROM game_location_travel_preparations WHERE campaign_id=$1 AND id=ANY($2::uuid[]) AND state='prepared' ORDER BY id",
        [campaignId, requestIds],
      )
    ).rows;
    const result: TravelMediaEntry[] = [];
    for (const row of rows) {
      await this.validate(c, userId, row);
      const q = row.image_quote;
      if (!q || Date.parse(q.expiresAt) <= Date.now() || !q.sparks?.reserveSubunits)
        fail(409, 'GENERATION_QUOTE_STALE', 'GENERATION_QUOTE_STALE');
      result.push({
        preparationId: row.id,
        imageQuoteId: q.id,
        ...(q.automaticKnownCostSettlement
          ? { automaticKnownCostPolicyHash: q.automaticKnownCostSettlement.fingerprint }
          : {}),
        grounding: await this.grounding!.entry(c, row.id),
        quote: {
          id: q.id,
          ...(q.automaticKnownCostSettlement
            ? {
                automaticKnownCostPolicy: 'known-cost-v1' as const,
                automaticKnownCostPolicyHash: q.automaticKnownCostSettlement.fingerprint,
              }
            : {}),
          credits: 0,
          demo: false,
          external: true,
          requiresConsent: true,
          chargeUnit: 'sparks',
          sparkReservedSubunits: q.sparks.reserveSubunits,
          sparkRateVersion: q.sparks.rateVersion,
          ...(q.funding ? { funding: q.funding } : {}),
          providerUpperMicros: q.verifiedUpperMicros,
          providerReserveMicros: q.reserveMicros,
          estimatedTotalMicros: q.estimatedTotalMicros ?? q.reserveMicros,
          expiresAt: q.expiresAt,
          provider: 'image-generation',
          policyVersion: String(q.policyRevision ?? 'native-image'),
          providerEnforcesQuotedCap: false,
        },
      });
    }
    return result;
  }
  async accept(
    c: PoolClient,
    userId: string,
    batchId: string,
    entries: TravelMediaEntry[],
    riskConsent: boolean,
  ) {
    if (entries.length && !riskConsent)
      fail(409, 'IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED', 'IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED');
    for (const entry of entries) {
      const row = (
        await c.query('SELECT * FROM game_location_travel_preparations WHERE id=$1 FOR UPDATE', [
          entry.preparationId,
        ])
      ).rows[0];
      if (!row || row.image_quote?.id !== entry.imageQuoteId || row.state !== 'prepared')
        fail(409, 'GENERATION_QUOTE_STALE', 'GENERATION_QUOTE_STALE');
      await this.validate(c, userId, row);
      if (
        entry.automaticKnownCostPolicyHash !==
          row.image_quote.automaticKnownCostSettlement?.fingerprint ||
        entry.quote.automaticKnownCostPolicyHash !== entry.automaticKnownCostPolicyHash
      )
        fail(409, 'GENERATION_QUOTE_STALE', 'GENERATION_QUOTE_STALE');
      const grounding = await this.grounding!.entry(c, row.id);
      if (digest(grounding) !== digest(entry.grounding ?? null))
        fail(409, 'LOCATION_GROUNDING_QUOTE_STALE', 'LOCATION_GROUNDING_QUOTE_STALE');
      // Like native text entries, each exact child is admitted later in order.
      // The user accepted these immutable native quotes, not arbitrary future image requests.
      await c.query(
        "UPDATE game_location_travel_preparations SET batch_id=$2,state='accepted' WHERE id=$1",
        [entry.preparationId, batchId],
      );
    }
  }
  async advance(
    c: PoolClient,
    userId: string,
    campaignId: string,
    batchId: string,
    requestId: string,
  ) {
    const progress = await this.progress(c, campaignId);
    if (
      progress.rows.some(
        (row) =>
          ['queued', 'dispatched', 'generated', 'unknown'].includes(row.status) ||
          row.hold_status === 'pending',
      )
    )
      return;
    const row = (
      await c.query(
        `SELECT p.* FROM game_location_travel_preparations p
      JOIN game_world_generation_batches b ON b.id=p.batch_id
      WHERE p.campaign_id=$1 AND p.batch_id=$2 AND p.id=$3 AND p.state='accepted' AND p.image_job_id IS NULL
      AND b.accepted_at IS NOT NULL AND b.state='accepted' ORDER BY p.created_at,p.id LIMIT 1 FOR UPDATE OF p`,
        [campaignId, batchId, requestId],
      )
    ).rows[0];
    if (!row) return;
    // There are no network calls in enqueueTx. A failed admission can be rolled back
    // completely; an uncertain provider dispatch is handled only by the native job.
    await c.query('SAVEPOINT travel_image_admission');
    try {
      const source = await this.validate(c, userId, row);
      const request = (
        await c.query('SELECT context FROM game_npc_decision_requests WHERE id=$1', [row.id])
      ).rows[0];
      const aliases = storedPresentationAliases(request?.context);
      if (request)
        await assertPresentationAliasAuthority(
          c,
          campaignId,
          String(request.context.worldRequesterId ?? userId),
          row.actor_id,
          aliases,
          request.context.worldInput?.text,
        );
      if (
        !request ||
        digest(request.context.travelSceneSpec?.scene ?? null) !== digest(row.scene) ||
        !buildStoryTurnContext(
          source.state,
          row.actor_id,
          {
            ...request.context.worldInput,
            expectedCanonRevision: source.state.narrativeCanon?.revision ?? 0,
          },
          row.id,
          aliases,
        ).travelRequests.some(
          (intent) =>
            !intent.mapId &&
            !intent.ambiguous &&
            normalizeLocationName(intent.destinationName) === normalizeLocationName(row.scene.name),
        )
      )
        fail(409, 'LOCATION_PREPARATION_STALE', 'LOCATION_PREPARATION_STALE');
      // Check the exact future cut before buying its art. Sibling arrivals may have consumed
      // a scene slot, connection tile or safe actor anchor since the shared quote.
      const previewInput = {
        ...request.context.worldInput,
        expectedCanonRevision: source.state.narrativeCanon?.revision ?? 0,
      };
      const previewProposal = createMockStoryTurnProposal(
        source.state,
        row.actor_id,
        previewInput,
        row.id,
        aliases,
      );
      if (!previewProposal.narrative)
        fail(409, 'LOCATION_GENERATION_UNAVAILABLE', 'LOCATION_GENERATION_UNAVAILABLE');
      previewProposal.narrative!.newScene = row.scene;
      previewProposal.narrative!.newNpc = null;
      const feasibility = applyStoryTurnProposal(
        source.state,
        row.actor_id,
        previewInput,
        row.id,
        previewProposal,
        { presentationAliases: aliases },
      );
      if (feasibility.error || feasibility.clarification)
        fail(409, 'LOCATION_GENERATION_UNAVAILABLE', 'LOCATION_GENERATION_UNAVAILABLE');
      const job = await this.images.enqueueTx(
        c,
        userId,
        {
          quoteId: row.image_quote.id,
          operationId: row.id,
          consent: true,
          estimateRiskConsent: true,
        },
        { batchId, preparationId: row.id, nativeQuoteId: row.image_quote.id },
      );
      await c.query('UPDATE game_location_travel_preparations SET image_job_id=$2 WHERE id=$1', [
        row.id,
        job.id,
      ]);
      await c.query('RELEASE SAVEPOINT travel_image_admission');
    } catch (error) {
      await c.query('ROLLBACK TO SAVEPOINT travel_image_admission');
      await c.query('RELEASE SAVEPOINT travel_image_admission');
      const code =
        (error as { getResponse?: () => { code?: string } }).getResponse?.().code ??
        (error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
          ? error.message
          : undefined);
      if (code === 'GENERATION_OUTSTANDING_REQUEST' || code === 'LIVE_OUTCOME_UNRESOLVED') return;
      if (!code) throw error;
      await c.query("UPDATE game_location_travel_preparations SET state='failed' WHERE id=$1", [
        row.id,
      ]);
      await c.query(
        "UPDATE game_npc_decision_requests SET status='failed',result_code=$2 WHERE id=$1 AND status='queued' AND job_id IS NULL",
        [row.id, code],
      );
    }
  }
  async workGrounding(campaignId: string, requestId: string) {
    await this.grounding?.work(campaignId, requestId);
  }
  async reconcile(campaignId: string) {
    await this.db.tx((c) => reconcileTerminalTravelGrounding(c, campaignId));
  }
  async progress(c: Pick<PoolClient, 'query'>, campaignId: string) {
    const resolved = await resolvedTerminalTravelGroundings(c, campaignId);
    const rows = (
      await c.query(
        `SELECT p.id,p.batch_id,j.status,h.status AS hold_status,g.status AS grounding_status,(g.status='unknown' AND g.job_id IS NULL AND g.error_code='STORY_MAP_COUNT_UNAVAILABLE' AND gc.status='succeeded') AS grounding_recoverable,gj.status AS grounding_job_status,gh.status AS grounding_hold_status FROM game_location_travel_preparations p
      LEFT JOIN image_generation_jobs j ON j.id=p.image_job_id LEFT JOIN spark_holds h ON h.id=j.spark_quote_id
      LEFT JOIN game_travel_map_groundings g ON g.preparation_id=p.id LEFT JOIN runtime_map_token_counts gc ON gc.id=g.count_id
      LEFT JOIN live_authoring_text_jobs gj ON gj.id=g.job_id LEFT JOIN spark_holds gh ON gh.id=gj.spark_quote_id
      WHERE p.campaign_id=$1 AND (p.state='accepted' OR j.status IN ('queued','dispatched','generated','unknown') OR h.status='pending')`,
        [campaignId],
      )
    ).rows.map((row) => (resolved.has(row.id) ? { ...row, grounding_status: 'failed' } : row));
    return {
      rows,
      active: rows.some(
        (r) =>
          ['queued', 'dispatched', 'generated'].includes(r.status) ||
          (r.status === 'admitted' &&
            (r.grounding_recoverable ||
              ['prepared', 'bound', 'queued'].includes(r.grounding_status))),
      ),
      unknown: rows.some(
        (r) =>
          r.status === 'unknown' ||
          r.hold_status === 'pending' ||
          (r.grounding_status === 'unknown' && !r.grounding_recoverable) ||
          r.grounding_hold_status === 'pending',
      ),
    };
  }
  async canUseFrozen(campaignId: string, turnId: string) {
    return this.db.tx(async (c) => {
      const row = (
        await c.query(
          "SELECT * FROM game_location_travel_preparations WHERE id=$1 AND campaign_id=$2 AND state='accepted'",
          [turnId, campaignId],
        )
      ).rows[0];
      if (!row) return false;
      try {
        await this.validate(c, row.owner_id, row);
        return true;
      } catch (error) {
        if (((error as { getStatus?: () => number }).getStatus?.() ?? 500) < 500) return false;
        throw error;
      }
    });
  }
  async rebase(
    campaignId: string,
    turnId: string,
    state: GameState,
    input: import('@dreamwalk/contracts').StoryTurnInput,
    proposal: unknown,
    aliases?: PresentationAliases,
  ) {
    const row = (
      await this.db.query(
        "SELECT * FROM game_location_travel_preparations WHERE id=$1 AND campaign_id=$2 AND state='accepted'",
        [turnId, campaignId],
      )
    )[0];
    const parsed = storyTurnProposalSchema.safeParse(proposal);
    if (!row || !parsed.success || !(await this.canUseFrozen(campaignId, turnId))) return null;
    const value = parsed.data;
    if (
      value.travelIntent ||
      !value.narrative ||
      digest(value.narrative.newScene) !== digest(row.scene) ||
      value.narrative.newNpc ||
      value.narrative.newItem ||
      value.narrative.evidenceIds.some(
        (id) => !(row.canon_snapshot?.turns ?? []).some((turn: { id: string }) => turn.id === id),
      ) ||
      value.steps.filter(
        (step) => step.action?.kind === 'travel' && step.action.targetId === 'new_scene',
      ).length !== 1 ||
      value.steps.some(
        (step) =>
          (step.action &&
            (step.action.kind !== 'travel' || step.action.targetId !== 'new_scene')) ||
          step.narrativeImpact ||
          step.reply ||
          step.replyNpcId ||
          step.replyContextHash,
      )
    )
      return null;
    const nextInput = { ...input, expectedCanonRevision: state.narrativeCanon?.revision ?? 0 };
    const context = buildStoryTurnContext(state, row.actor_id, nextInput, turnId, aliases);
    return { input: nextInput, proposal: { ...value, contextHash: context.contextHash } };
  }
  async admitted(campaignId: string, turnId: string, proposal: StoryTurnProposal) {
    const row = (
      await this.db.query(
        `SELECT p.*,j.status AS image_status,j.admitted_revision_id FROM game_location_travel_preparations p
      LEFT JOIN image_generation_jobs j ON j.id=p.image_job_id WHERE p.id=$1 AND p.campaign_id=$2`,
        [turnId, campaignId],
      )
    )[0];
    if (
      !row ||
      row.state !== 'accepted' ||
      row.image_status !== 'admitted' ||
      !row.admitted_revision_id
    )
      fail(409, 'LOCATION_MEDIA_NOT_READY', 'LOCATION_MEDIA_NOT_READY');
    if (
      proposal.travelIntent ||
      !proposal.narrative?.newScene ||
      digest(proposal.narrative.newScene) !== digest(row.scene) ||
      proposal.narrative.newNpc ||
      proposal.narrative.newItem ||
      proposal.steps?.some(
        (step) =>
          step.narrativeImpact != null ||
          (step.action && (step.action.kind !== 'travel' || step.action.targetId !== 'new_scene')),
      ) ||
      proposal.steps?.filter(
        (step) => step.action?.kind === 'travel' && step.action.targetId === 'new_scene',
      ).length !== 1
    )
      fail(409, 'LOCATION_PLAN_CHANGED', 'LOCATION_PLAN_CHANGED');
    if (!this.grounding)
      fail(409, 'LOCATION_GROUNDING_UNAVAILABLE', 'LOCATION_GROUNDING_UNAVAILABLE');
    const preparePlacement = await this.grounding!.preparePlacement(row.owner_id, row);
    const commit = async (c: PoolClient, state: GameState) => {
      await this.validate(c, row.owner_id, row);
      const binding = await this.art.pinCampaignArtTx(
        c,
        row.owner_id,
        campaignId,
        state,
        `map:scene-${turnId}:background`,
        row.admitted_revision_id,
      );
      if (!this.grounding)
        fail(409, 'LOCATION_GROUNDING_UNAVAILABLE', 'LOCATION_GROUNDING_UNAVAILABLE');
      const next = await this.grounding!.apply(c, row.owner_id, row, state);
      next.artBindings = [
        ...(next.artBindings ?? []).filter((b) => b.slot !== binding.slot),
        binding,
      ];
      if (next.artBindings.length > 128) fail(409, 'ART_LIMIT', 'ART_LIMIT');
      await c.query(
        "UPDATE game_location_travel_preparations SET state='committed',committed_at=now() WHERE id=$1 AND state='accepted'",
        [turnId],
      );
      return next;
    };
    return Object.assign(commit, { preparePlacement });
  }
}
