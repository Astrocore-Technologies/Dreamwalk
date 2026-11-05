import {
  acceptedWorldKnownCostPolicyMatches,
  worldKnownCostPolicyRequired,
} from '../generation/known-cost-policy';
import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  providerMicrosToSparkSubunits,
  frozenArtBindingSchema,
  type GameState,
  type StoryQuote,
} from '@dreamwalk/contracts';
import { Db } from '../db';
import { digest } from '../ai/context';
import { fail } from '../errors';
import { AuthoringTextEngine, type AuthoringTextBinding } from '../live-test/authoring-text';
import { quoteSparks, sparkTariff, sparkQuoteView } from '../generation/sparks-hooks';
import {
  assertTravelGroundingSnapshot,
  travelGroundingEnvelope,
  travelGroundingConsentHash,
  type TravelGroundingEnvelope,
} from '../generation/travel-grounding-envelope';
import { verifyAcceptedTravelGrounding } from '../generation/travel-grounding-consent';
import { AssetReuseService } from '../assets/reuse.service';
import { prepareStoryMapImages } from './story-map-images';
import {
  travelArrivalRoster,
  applyTravelMapPlacement,
  validateTravelMapPlan,
  type TravelMapContext,
} from './travel-map-plan';
export type TravelGroundingEntry = { envelope: TravelGroundingEnvelope; quote: StoryQuote };
type Authorize = (c: PoolClient, userId: string, row: QueryResultRow) => Promise<QueryResultRow>;
/** A finite native text child of the accepted image+vision tranche. Network work
 * happens outside campaign/SQL locks; native jobs own uncertainty and settlement. */
export class TravelMapGrounding {
  private running = new Map<string, Promise<void>>();
  constructor(
    private db: Db,
    private art: AssetReuseService,
    private engine: AuthoringTextEngine,
    private authorize: Authorize,
  ) {}
  private profile() {
    return (
      this.engine.provider.profile ??
      fail(409, 'MAP_VISION_POLICY_REQUIRED', 'MAP_VISION_POLICY_REQUIRED')
    );
  }
  async prepare(ownerId: string, preparationId: string) {
    return this.db.tx(async (c) => {
      const p = (
        await c.query('SELECT * FROM game_location_travel_preparations WHERE id=$1 FOR UPDATE', [
          preparationId,
        ])
      ).rows[0];
      const source = await this.authorize(c, ownerId, p);
      const old = (
        await c.query('SELECT * FROM game_travel_map_groundings WHERE preparation_id=$1', [p.id])
      ).rows[0];
      if (old && (old.status !== 'prepared' || Date.parse(old.quote.expiresAt) > Date.now()))
        return;
      if (p.state !== 'prepared' || p.image_job_id) throw Error('TRAVEL_GROUNDING_CONSENT_STALE');
      const profile = this.profile();
      const sessionId = await this.engine.live.resolveAuthorizationId(c, ownerId);
      await this.engine.live.authorizeText(c, ownerId, sessionId);
      const policy = await this.engine.live.assertActivePolicy(c, sessionId);
      const envelope = travelGroundingEnvelope(profile, this.engine.provider.version, {
        preparationId: p.id,
        sourceChecksum: p.source_checksum,
        imageRequestHash: p.input_hash,
        authorizationId: sessionId,
        policyRevision: policy.revision,
        policyHash: policy.hash,
      });
      const arrivals = travelArrivalRoster(source.state, p.actor_id);
      if (arrivals.length > 9) throw Error('LOCATION_ARRIVAL_ROSTER_CHANGED');
      const id = randomUUID(),
        expiresAt = new Date(
          Math.min(Date.now() + 60000, Date.parse(p.image_quote.expiresAt)),
        ).toISOString();
      const sparkId = await quoteSparks(
        c,
        {
          ownerId,
          operationId: id,
          sourceKind: 'text',
          sourceId: id,
          reserveSubunits: providerMicrosToSparkSubunits(String(envelope.reserveMicros)),
          expiresAt,
          tariff: sparkTariff(profile, 'openai', this.engine.provider.version),
          providerQuote: { kind: 'future-travel-raster-allowance', envelope },
        },
        { required: true },
      );
      const view = await sparkQuoteView(c, sparkId);
      const quote: StoryQuote = {
        id,
        credits: 0,
        demo: false,
        external: true,
        requiresConsent: true,
        chargeUnit: 'sparks',
        sparkReservedSubunits: view.sparks!.reserveSubunits,
        sparkRateVersion: view.sparks!.rateVersion,
        ...(view.funding ? { funding: view.funding } : {}),
        providerReserveMicros: envelope.reserveMicros,
        estimatedTotalMicros: envelope.estimatedTotalMicros,
        providerUpperMicros: null,
        providerEnforcesQuotedCap: false,
        expiresAt,
        provider: 'travel-map-grounding',
        policyVersion: envelope.fingerprint,
      };
      if (old) {
        await c.query(
          "UPDATE game_travel_map_groundings SET envelope=$2,quote=$3,spark_quote_id=$4,arrivals=$5,updated_at=now() WHERE preparation_id=$1 AND status='prepared'",
          [
            p.id,
            JSON.stringify(envelope),
            JSON.stringify(quote),
            sparkId,
            JSON.stringify(arrivals),
          ],
        );
      } else {
        await c.query(
          "INSERT INTO visual_authoring_projects(id,owner_id,kind,adventure_id,brief,source_hash,status,generation_mode,plan_origin,project_purpose) VALUES($1,$2,'location',$3,$4,$5,'concept','external','manual','travel-map')",
          [
            p.id,
            ownerId,
            source.adventure_id,
            JSON.stringify({ name: 'Travel map validation' }),
            p.source_checksum,
          ],
        );
        await c.query(
          'INSERT INTO game_travel_map_groundings(preparation_id,project_id,envelope,quote,spark_quote_id,quote_operation_id,job_operation_id,arrivals) VALUES($1,$1,$2,$3,$4,$5,$6,$7)',
          [
            p.id,
            JSON.stringify(envelope),
            JSON.stringify(quote),
            sparkId,
            randomUUID(),
            randomUUID(),
            JSON.stringify(arrivals),
          ],
        );
      }
    });
  }
  async entry(c: PoolClient, id: string): Promise<TravelGroundingEntry> {
    const row = (
      await c.query(
        'SELECT envelope,quote,status FROM game_travel_map_groundings WHERE preparation_id=$1',
        [id],
      )
    ).rows[0];
    if (!row || row.status !== 'prepared' || Date.parse(row.quote.expiresAt) <= Date.now())
      fail(409, 'LOCATION_GROUNDING_QUOTE_STALE', 'LOCATION_GROUNDING_QUOTE_STALE');
    return { envelope: row.envelope, quote: row.quote };
  }
  private async accepted(
    c: PoolClient,
    ownerId: string,
    p: QueryResultRow,
    g: QueryResultRow,
    beforeText = true,
  ) {
    const fresh = (
      await c.query('SELECT * FROM game_location_travel_preparations WHERE id=$1', [p.id])
    ).rows[0];
    if (!fresh || fresh.state !== 'accepted' || fresh.batch_id !== p.batch_id)
      throw Error('TRAVEL_GROUNDING_CONSENT_STALE');
    const source = await this.authorize(c, ownerId, fresh),
      batch = (
        await c.query('SELECT * FROM game_world_generation_batches WHERE id=$1', [p.batch_id])
      ).rows[0];
    const request = (await c.query('SELECT * FROM game_npc_decision_requests WHERE id=$1', [p.id]))
      .rows[0];
    const textEntries = (batch?.entries ?? []).filter(
      (e: { requestId: string }) => e.requestId === p.id,
    );
    if (
      !request ||
      request.requester_user_id !== ownerId ||
      request.campaign_id !== p.campaign_id ||
      textEntries.length !== 1 ||
      textEntries[0].contextDigest !== digest(request.context) ||
      (beforeText && (request.status !== 'queued' || request.job_id))
    )
      throw Error('TRAVEL_GROUNDING_CONSENT_STALE');
    const entries = (batch?.media_entries ?? []).filter(
      (e: { preparationId: string }) => e.preparationId === p.id,
    );
    if (
      p.state !== 'accepted' ||
      !batch ||
      batch.state !== 'accepted' ||
      (worldKnownCostPolicyRequired(batch) && !acceptedWorldKnownCostPolicyMatches(batch)) ||
      batch.quote?.travelGroundingPolicyHash !==
        travelGroundingConsentHash(batch.entries, batch.media_entries) ||
      batch.owner_id !== ownerId ||
      entries.length !== 1 ||
      digest(entries[0].grounding) !== digest({ envelope: g.envelope, quote: g.quote }) ||
      !batch.accepted_at ||
      Date.parse(batch.accepted_at) >= Date.parse(g.quote.expiresAt) ||
      digest(travelArrivalRoster(source.state, p.actor_id)) !== digest(g.arrivals)
    )
      throw Error('TRAVEL_GROUNDING_CONSENT_STALE');
    const policy = await this.engine.live.assertActivePolicy(c, g.envelope.authorizationId);
    const expected = travelGroundingEnvelope(this.profile(), this.engine.provider.version, {
      preparationId: p.id,
      sourceChecksum: p.source_checksum,
      imageRequestHash: p.input_hash,
      authorizationId: g.envelope.authorizationId,
      policyRevision: policy.revision,
      policyHash: policy.hash,
    });
    if (digest(expected) !== digest(g.envelope)) throw Error('GENERATION_POLICY_CHANGED');
    return source;
  }
  private guard(ownerId: string, id: string) {
    return async (c: PoolClient, b: AuthoringTextBinding) => {
      const p = (await c.query('SELECT * FROM game_location_travel_preparations WHERE id=$1', [id]))
        .rows[0];
      const g = (
        await c.query('SELECT * FROM game_travel_map_groundings WHERE preparation_id=$1', [id])
      ).rows[0];
      if (!p || !g || !['bound', 'queued'].includes(g.status))
        throw Error('TRAVEL_GROUNDING_CONSENT_STALE');
      await this.accepted(c, ownerId, p, g);
      if (
        b.projectId !== g.project_id ||
        b.projectRevision !== 1 ||
        b.sourceHash !== p.source_checksum ||
        b.readsetHash !== g.context_hash ||
        g.context_hash !== digest(g.context)
      )
        throw Error('TRAVEL_GROUNDING_CONSENT_STALE');
      const image = (
        await c.query('SELECT status,admitted_revision_id FROM image_generation_jobs WHERE id=$1', [
          p.image_job_id,
        ])
      ).rows[0];
      if (image?.status !== 'admitted' || image.admitted_revision_id !== g.image_revision_id)
        throw Error('MAP_IMAGE_SOURCE_MISMATCH');
      const { row } = await this.art.reusableRevisionTx(c, ownerId, g.image_revision_id);
      if (row.sha256 !== g.image_sha256) throw Error('MAP_IMAGE_SOURCE_MISMATCH');
    };
  }
  async work(campaignId: string, id: string) {
    const existing = this.running.get(id);
    if (existing) return existing;
    const work = this.workOnce(campaignId, id);
    this.running.set(id, work);
    try {
      await work;
    } finally {
      this.running.delete(id);
    }
  }
  private async workOnce(campaignId: string, id: string) {
    const rows = await this.db.query(
      `SELECT p.*,j.status AS image_status,j.admitted_revision_id FROM game_location_travel_preparations p JOIN image_generation_jobs j ON j.id=p.image_job_id JOIN game_travel_map_groundings g ON g.preparation_id=p.id WHERE p.id=$1 AND p.campaign_id=$2 AND p.state='accepted' AND j.status='admitted' AND (g.status IN ('prepared','bound','queued') OR (g.status='unknown' AND g.job_id IS NULL AND g.error_code='STORY_MAP_COUNT_UNAVAILABLE' AND EXISTS (SELECT 1 FROM runtime_map_token_counts c WHERE c.id=g.count_id AND c.status='succeeded')))`,
      [id, campaignId],
    );
    const p = rows[0];
    if (!p) return;
    try {
      let g = await this.db.tx(async (c) => {
        const current = (
          await c.query(
            'SELECT * FROM game_travel_map_groundings WHERE preparation_id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0];
        await this.accepted(c, p.owner_id, p, current);
        if (current.status === 'unknown') {
          const recovered = await c.query(
            `UPDATE game_travel_map_groundings g SET status='bound',error_code=NULL,updated_at=now() WHERE preparation_id=$1 AND status='unknown' AND job_id IS NULL AND error_code='STORY_MAP_COUNT_UNAVAILABLE' AND EXISTS (SELECT 1 FROM runtime_map_token_counts receipt WHERE receipt.id=g.count_id AND receipt.status='succeeded') RETURNING g.*`,
            [id],
          );
          if (recovered.rowCount !== 1) throw Error('STORY_MAP_COUNT_UNRESOLVED');
          // Native quote rebuilding below independently verifies the exact receipt body.
          return recovered.rows[0];
        }
        if (current.status !== 'prepared') return current;
        const images = await prepareStoryMapImages(c, this.art, p.owner_id, [
          { location_id: `scene-${id}`, revision_id: p.admitted_revision_id },
        ]);
        const context: TravelMapContext = {
          mapId: `scene-${id}`,
          name: p.scene.name,
          description: p.scene.description,
          sourceChecksum: p.source_checksum,
          arrivals: current.arrivals,
          mapImages: images,
        };
        return (
          await c.query(
            "UPDATE game_travel_map_groundings SET status='bound',context=$2,context_hash=$3,image_revision_id=$4,image_sha256=$5,updated_at=now() WHERE preparation_id=$1 RETURNING *",
            [id, JSON.stringify(context), digest(context), images[0].revisionId, images[0].sha256],
          )
        ).rows[0];
      });
      if (!g.job_id) {
        const quote = await this.engine.quoteAcceptedTravelGrounding(
          p.owner_id,
          {
            projectId: g.project_id,
            projectRevision: 1,
            sourceHash: p.source_checksum,
            readsetHash: g.context_hash,
            operationId: g.quote_operation_id,
            context: g.context,
          },
          { preparationId: id, batchId: p.batch_id },
          this.guard(p.owner_id, id),
        );
        const native = (
          await this.db.query('SELECT * FROM live_authoring_text_quotes WHERE id=$1', [quote.id])
        )[0];
        assertTravelGroundingSnapshot(
          g.envelope,
          native.request_snapshot,
          this.profile(),
          this.engine.provider.version,
        );
        await this.db.tx(async (c) => {
          const current = (
            await c.query(
              'SELECT * FROM game_travel_map_groundings WHERE preparation_id=$1 FOR UPDATE',
              [id],
            )
          ).rows[0];
          await this.accepted(c, p.owner_id, p, current);
          if (current.native_quote_id && current.native_quote_id !== quote.id)
            throw Error('TRAVEL_GROUNDING_CONSENT_STALE');
          await c.query(
            'UPDATE game_travel_map_groundings SET native_quote_id=$2 WHERE preparation_id=$1',
            [id, quote.id],
          );
        });
        const job = await this.engine.enqueueAcceptedTravelGrounding(
          p.owner_id,
          { quoteId: quote.id, operationId: g.job_operation_id },
          { preparationId: id, batchId: p.batch_id, nativeQuoteId: quote.id },
          this.guard(p.owner_id, id),
        );
        g = { ...g, job_id: job.id };
      }
      const job = await this.engine.run(
        p.owner_id,
        g.job_id,
        this.guard(p.owner_id, id),
        async (c, b, proposal) => {
          const current = (
            await c.query(
              'SELECT * FROM game_travel_map_groundings WHERE preparation_id=$1 FOR UPDATE',
              [id],
            )
          ).rows[0];
          const plan = validateTravelMapPlan(current.context, proposal);
          await verifyAcceptedTravelGrounding(
            c,
            p.owner_id,
            { preparationId: id, batchId: p.batch_id, nativeQuoteId: current.native_quote_id },
            this.profile(),
            this.engine.provider.version,
          );
          await c.query(
            "UPDATE game_travel_map_groundings SET status='ready',result=$2,updated_at=now() WHERE preparation_id=$1 AND job_id=$3",
            [id, JSON.stringify(plan), g.job_id],
          );
          return { preparationId: id, imageRevisionId: plan.spatialGrounding.imageRevisionId };
        },
      );
      if (['unknown', 'failed', 'stale', 'cancelled'].includes(job.status))
        await this.db.query(
          "UPDATE game_travel_map_groundings SET status=$2,error_code=$3,updated_at=now() WHERE preparation_id=$1 AND status<>'ready'",
          [
            id,
            job.status === 'unknown' ? 'unknown' : 'failed',
            job.errorCode ?? 'LOCATION_GROUNDING_FAILED',
          ],
        );
    } catch (error) {
      const code =
        (error as { getResponse?: () => { code?: string } }).getResponse?.().code ??
        (error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
          ? error.message
          : 'LOCATION_GROUNDING_FAILED');
      // Never turn an uncertain native dispatch into an unpaid failure or retry.
      const g = (
        await this.db.query(
          'SELECT g.job_id,j.status FROM game_travel_map_groundings g LEFT JOIN live_authoring_text_jobs j ON j.id=g.job_id WHERE g.preparation_id=$1',
          [id],
        )
      )[0];
      if (['queued', 'dispatched', 'unknown', 'generated'].includes(g?.status)) return;
      await this.db.query(
        "UPDATE game_travel_map_groundings SET status=$2,error_code=$3,updated_at=now() WHERE preparation_id=$1 AND status<>'ready'",
        [id, code.includes('COUNT_UN') ? 'unknown' : 'failed', code],
      );
    }
  }
  async preparePlacement(ownerId: string, p: QueryResultRow) {
    return this.db.tx(async (c) => {
      const g = (
        await c.query('SELECT * FROM game_travel_map_groundings WHERE preparation_id=$1', [p.id])
      ).rows[0];
      if (!g || g.status !== 'ready') throw Error('LOCATION_GROUNDING_NOT_READY');
      await this.accepted(c, ownerId, p, g, false);
      const plan = validateTravelMapPlan(g.context, g.result);
      const { row } = await this.art.reusableRevisionTx(c, ownerId, g.image_revision_id);
      if (row.sha256 !== g.image_sha256 || p.admitted_revision_id !== g.image_revision_id)
        throw Error('MAP_IMAGE_SOURCE_MISMATCH');
      const mapId = `scene-${p.id}`;
      const binding = frozenArtBindingSchema.parse({
        slot: `map:${mapId}:background`,
        revisionId: g.image_revision_id,
        sha256: row.sha256,
        mime: row.mime,
        width: row.width,
        height: row.height,
      });
      return (state: GameState) => {
        const next = applyTravelMapPlacement(state, mapId, plan);
        next.artBindings = [
          ...(next.artBindings ?? []).filter((b) => b.slot !== binding.slot),
          binding,
        ];
        return next;
      };
    });
  }
  async apply(c: PoolClient, ownerId: string, p: QueryResultRow, state: GameState) {
    const g = (
      await c.query('SELECT * FROM game_travel_map_groundings WHERE preparation_id=$1 FOR SHARE', [
        p.id,
      ])
    ).rows[0];
    if (!g || g.status !== 'ready') throw Error('LOCATION_GROUNDING_NOT_READY');
    await this.accepted(c, ownerId, p, g, false);
    const plan = validateTravelMapPlan(g.context, g.result),
      mapId = `scene-${p.id}`,
      map = state.maps[mapId];
    if (
      !map ||
      map.spatialMode === 'location_only' ||
      plan.spatialGrounding.imageRevisionId !== p.admitted_revision_id
    )
      throw Error('MAP_IMAGE_SOURCE_MISMATCH');
    const { row } = await this.art.reusableRevisionTx(c, ownerId, g.image_revision_id);
    if (row.sha256 !== g.image_sha256) throw Error('MAP_IMAGE_SOURCE_MISMATCH');
    return applyTravelMapPlacement(state, mapId, plan);
  }
}
