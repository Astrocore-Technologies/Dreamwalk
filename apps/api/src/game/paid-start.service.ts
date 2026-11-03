import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { Db } from '../db';
import { PlayableService } from './playable.service';
import { readOwnedHero } from './hero-selection';
import { AuthoringTextEngine, type AuthoringTextBinding } from '../live-test/authoring-text';
import { visualDigest as digest } from '../visual-authoring/fingerprint';
import { fail } from '../errors';
const operation = z.object({ operationId: z.uuid() }).strict();
@Injectable()
export class PaidStartService {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(PlayableService) private playable: PlayableService,
    @Optional() @Inject('STORY_BUILD_ENGINE') private engine?: AuthoringTextEngine,
  ) {}
  private configured() {
    return this.engine ?? fail(409, 'STORY_PLANNER_UNAVAILABLE', 'STORY_PLANNER_UNAVAILABLE');
  }
  private async lock(c: PoolClient, actor: string) {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['art-owner:' + actor]);
  }
  private async own(c: PoolClient, actor: string, id: string) {
    const row = (
      await c.query(
        'SELECT s.*,p.status AS project_status,p.revision AS project_revision FROM game_start_preparations s JOIN visual_authoring_projects p ON p.id=s.id WHERE s.id=$1 AND s.actor_id=$2 FOR UPDATE OF s,p',
        [z.uuid().parse(id), actor],
      )
    ).rows[0];
    return row ?? fail(404, 'NOT_FOUND', 'NOT_FOUND');
  }
  private async validate(c: PoolClient, actor: string, row: QueryResultRow) {
    const source = await this.playable.sourceForStart(c, actor, row.source_version_id);
    if (
      source.checksum !== row.source_checksum ||
      digest(await readOwnedHero(c, actor, row.hero_id ?? undefined)) !== digest(row.hero_snapshot)
    )
      fail(409, 'START_SOURCE_CHANGED', 'START_SOURCE_CHANGED');
    return source;
  }
  async prepare(actor: string, input: unknown) {
    const body = operation
      .extend({ playableVersionId: z.uuid(), heroId: z.uuid().optional() })
      .parse(input);
    return this.db.tx(async (c) => {
      await this.lock(c, actor);
      const requestHash = digest(body);
      const prior = (
        await c.query(
          'SELECT * FROM game_start_preparations WHERE actor_id=$1 AND operation_id=$2',
          [actor, body.operationId],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash)
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        if (prior.status === 'started')
          await this.playable.sourceForStart(c, actor, prior.source_version_id);
        else await this.validate(c, actor, prior);
        return this.dto(prior);
      }
      const source = await this.playable.sourceForStart(c, actor, body.playableVersionId);
      const hero = await readOwnedHero(c, actor, body.heroId),
        id = randomUUID();
      if (!source.package.compiled && source.package.kind !== 'launch-source')
        fail(409, 'NOT_PLAYABLE', 'NOT_PLAYABLE');
      const cached = !source.package.compiled
        ? (
            await c.query(
              "SELECT id,compiled FROM game_start_preparations WHERE actor_id=$1 AND source_version_id=$2 AND source_checksum=$3 AND hero_id IS NOT DISTINCT FROM $4::uuid AND hero_snapshot=$5::jsonb AND status IN ('ready','started') AND compiled IS NOT NULL ORDER BY created_at LIMIT 1",
              [actor, source.id, source.checksum, body.heroId ?? null, JSON.stringify(hero)],
            )
          ).rows[0]
        : null;
      const reused = Boolean(source.package.compiled || cached);
      const count = (
        await c.query(
          "SELECT count(*)::int AS n FROM game_start_preparations WHERE actor_id=$1 AND status<>'started'",
          [actor],
        )
      ).rows[0];
      if (count.n >= 100) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
      await c.query(
        "INSERT INTO visual_authoring_projects(id,owner_id,kind,adventure_id,brief,source_hash,status,generation_mode,plan_origin,project_purpose) VALUES($1,$2,'location',$3,$4,$5,'concept','external','manual','game-start')",
        [
          id,
          actor,
          source.adventure_id,
          JSON.stringify({ name: 'Player start preparation' }),
          source.checksum,
        ],
      );
      const row = (
        await c.query(
          'INSERT INTO game_start_preparations(id,actor_id,operation_id,request_hash,source_version_id,source_checksum,hero_id,hero_snapshot,status,reused,compiled,reused_from_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
          [
            id,
            actor,
            body.operationId,
            requestHash,
            source.id,
            source.checksum,
            body.heroId ?? null,
            JSON.stringify(hero),
            reused ? 'ready' : 'prepared',
            reused,
            cached ? JSON.stringify(cached.compiled) : null,
            cached?.id ?? null,
          ],
        )
      ).rows[0];
      return this.dto(row);
    });
  }
  private dto(row: QueryResultRow) {
    return {
      id: row.id,
      status: row.status,
      reused: row.reused,
      preparationRequired: !row.reused,
      campaignId: row.campaign_id ?? null,
      playableVersionId: row.source_version_id,
    };
  }
  async state(actor: string, id: string) {
    return this.db.tx(async (c) => {
      const row = await this.own(c, actor, id);
      await this.playable.sourceForStart(c, actor, row.source_version_id);
      const jobs = (
        await c.query(
          'SELECT j.id,j.status,j.error_code,h.status AS "sparkStatus",h.reserved_subunits AS "sparkReservedSubunits",h.captured_subunits AS "sparkCapturedSubunits" FROM live_authoring_text_jobs j LEFT JOIN spark_holds h ON h.id=j.spark_quote_id WHERE j.project_id=$1 AND j.actor_id=$2 ORDER BY j.created_at DESC LIMIT 1',
          [id, actor],
        )
      ).rows;
      return { ...this.dto(row), jobs };
    });
  }
  private guard(actor: string, jobId?: string) {
    return async (c: PoolClient, b: AuthoringTextBinding) => {
      const row = await this.own(c, actor, b.projectId),
        source = await this.validate(c, actor, row);
      if (
        row.project_status === 'cancelled' ||
        Number(row.project_revision) !== 1 ||
        row.status !== 'prepared' ||
        row.reused ||
        b.projectRevision !== 1 ||
        b.sourceHash !== row.source_checksum ||
        b.readsetHash !== digest(source.package.plannerSource)
      )
        fail(409, 'START_SOURCE_CHANGED', 'START_SOURCE_CHANGED');
      const jobs = (
        await c.query('SELECT id FROM live_authoring_text_jobs WHERE project_id=$1', [row.id])
      ).rows;
      if (jobs.some((j) => j.id !== jobId))
        fail(409, 'START_ALREADY_DISPATCHED', 'START_ALREADY_DISPATCHED');
    };
  }
  async quote(actor: string, id: string, input: unknown) {
    const body = operation.parse(input);
    const binding = await this.db.tx(async (c) => {
      const row = await this.own(c, actor, id),
        source = await this.validate(c, actor, row);
      if (row.status !== 'prepared' || row.reused) fail(409, 'STATE_CONFLICT', 'STATE_CONFLICT');
      return {
        ...body,
        projectId: id,
        projectRevision: 1,
        sourceHash: row.source_checksum,
        readsetHash: digest(source.package.plannerSource),
        context: source.package.plannerSource,
      };
    });
    return this.configured().quote(actor, binding, this.guard(actor));
  }
  async dispatch(actor: string, id: string, input: unknown) {
    const body = operation.extend({ quoteId: z.uuid(), consent: z.literal(true) }).parse(input),
      engine = this.configured();
    const quote = (
      await this.db.query(
        'SELECT project_id FROM live_authoring_text_quotes WHERE id=$1 AND actor_id=$2',
        [body.quoteId, actor],
      )
    )[0];
    if (quote?.project_id !== id) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    const job = await engine.enqueue(actor, body, this.guard(actor));
    await engine.run(actor, job.id, this.guard(actor, job.id), async (c, b, value) => {
      const row = await this.own(c, actor, id),
        source = await this.validate(c, actor, row);
      const compiled = this.playable.compileLaunchPlan(source.package, value);
      await c.query("UPDATE game_start_preparations SET status='ready',compiled=$2 WHERE id=$1", [
        id,
        JSON.stringify(compiled),
      ]);
      return { preparationId: id, ready: true };
    });
    return this.state(actor, id);
  }
}
