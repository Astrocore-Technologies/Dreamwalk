import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { GameState, TurnRules } from '@dreamwalk/contracts';
import { initializeTurnController } from '@dreamwalk/game-core';
import { digest } from '../ai/context';
import { sourceLiveSql } from './source-access';

export class TurnConversionError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
const reject = (code: string): never => {
  throw new TurnConversionError(code);
};
export const turnConversionInputSchema = z
  .object({
    campaignId: z.uuid(),
    ownerHandle: z.string().regex(/^[a-z0-9_]{3,30}$/),
    expectedRevision: z.number().int().nonnegative(),
    operationId: z.uuid(),
  })
  .strict();
export type TurnConversionInput = z.infer<typeof turnConversionInputSchema>;
export interface TurnConversionReceipt {
  status: 'converted' | 'already_turn_based';
  campaignId: string;
  revision: number;
  sequence: number;
  stateRevision: number;
  participants: number;
}

/** Stop only uncommitted legacy paths; keep positions, inventory, canon, plans and memories. */
export function prepareLegacyTurnState(
  state: GameState,
  actorIds: string[],
  rules: Partial<TurnRules> = {},
): GameState {
  if (state.rulesetVersion !== 'hybrid-v3') reject('TURN_RULESET_UPGRADE_REQUIRED');
  if (state.turnController) reject('TURN_ALREADY_INITIALIZED');
  if (Object.values(state.encounters).some((encounter) => encounter.phase === 'planning'))
    reject('TURN_CONVERSION_ENCOUNTER_ACTIVE');
  const prepared = structuredClone(state);
  for (const entity of Object.values(prepared.entities)) {
    if (entity.kind !== 'player' && entity.kind !== 'npc') continue;
    if (entity.path?.length) entity.path = [];
    delete entity.movementTrace;
    entity.movementGeneration = (entity.movementGeneration ?? 0) + 1;
    const brain = prepared.npcBrains?.[entity.id];
    if (brain) {
      brain.waitingForPath = false;
      brain.movementGeneration = entity.movementGeneration;
    }
  }
  const initialized = initializeTurnController(prepared, actorIds, rules);
  if (initialized.error) reject('TURN_CONVERSION_' + initialized.error);
  return initialized.state;
}

/**
 * Explicit operator conversion, called inside one transaction while the runtime is stopped/paused.
 * No generation, provider, financial reservation, receipt settlement or source-version rewrite.
 */
export async function convertSavedCampaignToTurns(
  client: PoolClient,
  value: TurnConversionInput,
): Promise<TurnConversionReceipt> {
  const input = turnConversionInputSchema.parse(value);
  const owner = (
    await client.query(
      'SELECT u.id FROM users u JOIN game_campaigns c ON c.owner_id=u.id WHERE c.id=$1 AND lower(u.handle)=lower($2) AND u.deleted_at IS NULL FOR SHARE OF u',
      [input.campaignId, input.ownerHandle],
    )
  ).rows[0];
  if (!owner) reject('TURN_CONVERSION_OWNER_REQUIRED');
  const campaign = (
    await client.query(
      'SELECT c.* FROM game_campaigns c WHERE c.id=$1 AND c.owner_id=$2 AND ' +
        sourceLiveSql() +
        ' FOR UPDATE OF c',
      [input.campaignId, owner.id],
    )
  ).rows[0];
  if (!campaign || campaign.status !== 'active') reject('TURN_CONVERSION_UNAVAILABLE');
  const members = (
    await client.query(
      "SELECT m.actor_id,m.user_id FROM game_members m JOIN users u ON u.id=m.user_id WHERE m.campaign_id=$1 AND m.status='accepted' AND u.deleted_at IS NULL ORDER BY (m.user_id=$2) DESC,m.created_at,m.actor_id FOR SHARE OF m,u",
      [input.campaignId, owner.id],
    )
  ).rows;
  const ownerActor = members.find((member) => member.user_id === owner.id)?.actor_id;
  if (!ownerActor) reject('TURN_CONVERSION_OWNER_REQUIRED');
  const requestHash = digest({ kind: 'turn.convert', ...input });
  const existing = (
    await client.query(
      'SELECT request_hash,result FROM game_operations WHERE campaign_id=$1 AND actor_id=$2 AND operation_id=$3',
      [input.campaignId, ownerActor, input.operationId],
    )
  ).rows[0];
  if (existing) {
    if (existing.request_hash !== requestHash) reject('IDEMPOTENCY_CONFLICT');
    return existing.result as TurnConversionReceipt;
  }
  if (Number(campaign.revision) !== input.expectedRevision) reject('STALE_STATE');
  const snapshot = (
    await client.query(
      'SELECT sequence,checksum,state FROM game_snapshots WHERE campaign_id=$1 FOR UPDATE',
      [input.campaignId],
    )
  ).rows[0];
  if (
    !snapshot ||
    Number(snapshot.sequence) !== Number(campaign.event_seq) ||
    digest(campaign.state) !== snapshot.checksum ||
    digest(snapshot.state) !== snapshot.checksum
  )
    reject('RECOVERY_REQUIRED');
  const state = campaign.state as GameState;
  const actorIds = members.map((member) => String(member.actor_id));
  const receipt = (
    status: TurnConversionReceipt['status'],
    next: GameState,
    revision: number,
    sequence: number,
  ): TurnConversionReceipt => ({
    status,
    campaignId: input.campaignId,
    revision,
    sequence,
    stateRevision: next.revision,
    participants: actorIds.length,
  });
  if (state.turnController) {
    const result = receipt(
      'already_turn_based',
      state,
      Number(campaign.revision),
      Number(campaign.event_seq),
    );
    await client.query(
      'INSERT INTO game_operations(campaign_id,actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4,$5)',
      [input.campaignId, ownerActor, input.operationId, requestHash, JSON.stringify(result)],
    );
    return result;
  }
  if (campaign.runtime_clock?.paused !== true) reject('TURN_CONVERSION_PAUSE_REQUIRED');
  const pending = (
    await client.query(
      "SELECT EXISTS(SELECT 1 FROM game_npc_jobs WHERE campaign_id=$1 AND status='queued') OR EXISTS(SELECT 1 FROM game_npc_decision_requests WHERE campaign_id=$1 AND status IN ('queued','scheduled')) OR EXISTS(SELECT 1 FROM npc_ai_jobs WHERE campaign_id=$1 AND (status NOT IN ('committed','stale','cancelled','failed') OR provider_budget_status='unknown' OR reservation_status='held')) OR EXISTS(SELECT 1 FROM game_story_turns WHERE campaign_id=$1 AND status IN ('quoted','queued','awaiting_confirmation')) AS pending",
      [input.campaignId],
    )
  ).rows[0]?.pending;
  if (pending) reject('TURN_CONVERSION_PENDING_WORK');
  const source = campaign.source_version_id
    ? (
        await client.query(
          "SELECT package->'compiled'->'turnRules' AS rules FROM game_playable_versions WHERE id=$1",
          [campaign.source_version_id],
        )
      ).rows[0]
    : undefined;
  const next = prepareLegacyTurnState(state, actorIds, source?.rules ?? {});
  const sequence = Number(campaign.event_seq) + 1;
  const clock = { ...campaign.runtime_clock, paused: true, capturedAtMs: Date.now() };
  const updated = (
    await client.query(
      'UPDATE game_campaigns SET state=$1,revision=revision+1,event_seq=$2,runtime_clock=$3,updated_at=clock_timestamp() WHERE id=$4 AND revision=$5 RETURNING revision',
      [
        JSON.stringify(next),
        sequence,
        JSON.stringify(clock),
        input.campaignId,
        input.expectedRevision,
      ],
    )
  ).rows[0];
  if (!updated) reject('STALE_STATE');
  const result = receipt('converted', next, Number(updated.revision), sequence);
  await client.query(
    "INSERT INTO game_events(campaign_id,sequence,kind,payload) VALUES($1,$2,'turn.converted',$3)",
    [
      input.campaignId,
      sequence,
      JSON.stringify({ state: next, serverTick: next.tick, operationId: input.operationId }),
    ],
  );
  await client.query(
    'UPDATE game_snapshots SET sequence=$2,checksum=$3,state=$4 WHERE campaign_id=$1',
    [input.campaignId, sequence, digest(next), JSON.stringify(next)],
  );
  await client.query('INSERT INTO game_outbox(campaign_id,sequence) VALUES($1,$2)', [
    input.campaignId,
    sequence,
  ]);
  await client.query(
    'INSERT INTO game_operations(campaign_id,actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4,$5)',
    [input.campaignId, ownerActor, input.operationId, requestHash, JSON.stringify(result)],
  );
  return result;
}
