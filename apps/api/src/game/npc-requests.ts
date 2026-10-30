import type { PoolClient } from 'pg';
import type { DecisionContext, AiPurpose } from '../ai/types';
export interface NpcDecisionRequest {
  id: string;
  npcId: string;
  purpose: AiPurpose;
  causeKey: string;
  requesterUserId?: string;
  recipientActorId?: string;
  context: DecisionContext;
}
export async function insertNpcRequest(c: PoolClient, campaignId: string, r: NpcDecisionRequest) {
  await c.query(
    `INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,requester_user_id,recipient_actor_id,context)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(campaign_id,npc_id,purpose,cause_key) DO NOTHING`,
    [
      r.id,
      campaignId,
      r.npcId,
      r.purpose,
      r.causeKey,
      r.requesterUserId ?? null,
      r.recipientActorId ?? null,
      JSON.stringify(r.context),
    ],
  );
}
