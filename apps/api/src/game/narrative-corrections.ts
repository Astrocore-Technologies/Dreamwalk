import {
  narrativePreferencesUpdateSchema,
  readNarrativePreferences,
  type GameState,
  type NarrativePreferences,
} from '@dreamwalk/contracts';
import type { PoolClient } from 'pg';
import type { Request } from 'express';
import { Db } from '../db';
import { digest } from '../ai/context';
import { fail } from '../errors';
import { sourceAccessSql } from './source-access';

interface Port<Live extends { state: GameState }> {
  access(req: Request, id: string): Promise<{ user: { id: string }; actorId: string }>;
  serial<T>(id: string, work: () => Promise<T>): Promise<T>;
  load(id: string): Promise<Live>;
  persist(
    id: string,
    live: Live,
    state: GameState,
    extra: (c: PoolClient) => Promise<void>,
    preflight: (c: PoolClient) => Promise<void>,
  ): Promise<void>;
}
/** No world actions, provider dispatch, spend, or arbitrary instruction text is accepted here. */
export class NarrativeCorrections<Live extends { state: GameState }> {
  constructor(
    private db: Db,
    private port: Port<Live>,
  ) {}
  private async authorize(c: PoolClient, id: string, userId: string) {
    // Match erasure's user-before-source/campaign order; no provider or wallet locks.
    await c.query(
      `SELECT u.id FROM users u WHERE u.id=$2 OR u.id IN (SELECT m.user_id FROM game_members m WHERE m.campaign_id=$1) OR u.id IN (SELECT a.owner_id FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id JOIN adventures a ON a.id=v.adventure_id WHERE c.id=$1) ORDER BY u.id FOR SHARE OF u`,
      [id, userId],
    );
    await c.query(
      'SELECT a.id FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id JOIN adventures a ON a.id=v.adventure_id WHERE c.id=$1 FOR SHARE OF a',
      [id],
    );
    await c.query(
      "SELECT i.id FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id JOIN adventure_invitations i ON i.adventure_id=v.adventure_id WHERE c.id=$1 AND i.recipient_id=$2 AND i.status='accepted' FOR SHARE OF i",
      [id, userId],
    );
    const active = await c.query(
      `SELECT m.actor_id FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id JOIN users u ON u.id=m.user_id WHERE c.id=$1 AND m.user_id=$2 AND m.status='accepted' AND u.deleted_at IS NULL AND c.status='active' AND ${sourceAccessSql('$2')} FOR SHARE OF u,m`,
      [id, userId],
    );
    if (!active.rowCount) fail(403, 'FORBIDDEN', 'FORBIDDEN');
  }
  async preferences(req: Request, id: string, body?: unknown): Promise<NarrativePreferences> {
    const input = body === undefined ? undefined : narrativePreferencesUpdateSchema.parse(body);
    return this.port.serial(id, async () => {
      const access = await this.port.access(req, id),
        live = await this.port.load(id);
      if (live.state.entities[access.actorId]?.kind !== 'player')
        fail(403, 'FORBIDDEN', 'FORBIDDEN');
      const current = readNarrativePreferences(live.state, access.actorId);
      if (!input) return current;
      const requestHash = digest(input);
      const previous = (
        await this.db.query(
          'SELECT request_hash,result FROM game_narrative_preference_operations WHERE campaign_id=$1 AND requester_user_id=$2 AND operation_id=$3',
          [id, access.user.id, input.operationId],
        )
      )[0];
      if (previous) {
        if (previous.request_hash !== requestHash)
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return previous.result as NarrativePreferences;
      }
      if (current.revision !== input.expectedRevision) fail(409, 'STALE_STATE', 'STALE_STATE');
      const result = { revision: current.revision + 1, settings: input.settings };
      const next = structuredClone(live.state);
      next.narrativePreferences ??= {};
      next.narrativePreferences[access.actorId] = result;
      await this.port.persist(
        id,
        live,
        next,
        async (c) => {
          const count = (
            await c.query(
              `SELECT count(*) AS total,count(*) FILTER(WHERE created_at>now()-interval '1 minute') AS recent FROM game_narrative_preference_operations WHERE campaign_id=$1 AND requester_user_id=$2`,
              [id, access.user.id],
            )
          ).rows[0];
          if (Number(count.total) >= 256 || Number(count.recent) >= 20)
            fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
          await c.query(
            'INSERT INTO game_narrative_preference_operations(campaign_id,requester_user_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4,$5)',
            [id, access.user.id, input.operationId, requestHash, JSON.stringify(result)],
          );
        },
        (c) => this.authorize(c, id, access.user.id),
      );
      return result;
    });
  }
}
