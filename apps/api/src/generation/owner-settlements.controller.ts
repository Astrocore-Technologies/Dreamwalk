import { Controller, Get, Header, Inject, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { Auth } from '../auth';
import { Db } from '../db';
import { KnownNpcSettlement } from '../game/known-npc-settlement';
import { KnownAuthoringSettlement } from '../live-test/known-authoring-settlement';

/** Read-only owner discovery. Merely listing reservations never authorizes settlement. */
@Controller('api/v1/sparks')
export class OwnerSettlementsController {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(Auth) private auth: Auth,
    @Inject(KnownNpcSettlement) private npc: KnownNpcSettlement,
    @Inject(KnownAuthoringSettlement) private authoring: KnownAuthoringSettlement,
  ) {}
  @Get('settlements')
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: Request, @Query('after') after?: string) {
    const owner = await this.auth.require(req);
    const cursor = after === undefined ? null : z.uuid().parse(after);
    const rows = await this.db.query(
      `SELECT h.id,h.status,h.reason,h.reserved_subunits,h.source_kind,
        (SELECT jsonb_agg(j) FROM (
          SELECT id AS "jobId",NULL::uuid AS "campaignId",'authoring'::text AS kind
          FROM live_authoring_text_jobs WHERE spark_quote_id=h.id AND actor_id=h.owner_id
          ORDER BY id LIMIT 2
        ) j) AS authoring_jobs,
        (SELECT jsonb_agg(j) FROM (
          SELECT id AS "jobId",campaign_id AS "campaignId",'npc'::text AS kind
          FROM npc_ai_jobs WHERE spark_hold_id=h.id AND payer_user_id=h.owner_id
          ORDER BY id LIMIT 2
        ) j) AS npc_jobs
       FROM spark_holds h WHERE h.owner_id=$1 AND h.status IN ('held','pending')
         AND ($2::uuid IS NULL OR h.id>$2::uuid)
       ORDER BY h.id LIMIT 11`,
      [owner.id, cursor],
    );
    const entries = [];
    for (const row of rows.slice(0, 10)) {
      const base = { holdId: String(row.id), reservedSubunits: String(row.reserved_subunits) };
      const jobs = [...(row.authoring_jobs ?? []), ...(row.npc_jobs ?? [])];
      if (
        row.status !== 'pending' ||
        row.reason !== 'failure_policy_pending' ||
        jobs.length !== 1
      ) {
        entries.push({ ...base, state: row.status === 'held' ? 'active' : 'unavailable' });
        continue;
      }
      const job = jobs[0];
      try {
        const quote =
          job.kind === 'authoring'
            ? await this.authoring.handle(owner.id, job.jobId)
            : await this.npc.handle(req, job.campaignId, job.jobId);
        if (!quote || quote.holdId !== row.id) throw new Error('SETTLEMENT_DISCOVERY_MISMATCH');
        entries.push({ ...base, state: 'verified', ...job, quote });
      } catch (error) {
        const status = (error as { getStatus?: () => number }).getStatus?.();
        if (status !== 404 && status !== 409) throw error;
        entries.push({ ...base, state: 'unavailable' });
      }
    }
    return { ownerId: owner.id, entries, nextCursor: rows.length > 10 ? String(rows[9].id) : null };
  }
}
