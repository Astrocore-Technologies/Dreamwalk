/** Game extension of the explicit account export/purge transaction. No external calls. */
import { createHash, randomUUID } from 'node:crypto';
import { redactNarrativeContent } from './narrative-data-requests.mjs';
import { exportNpcAiData, exportNpcAiSponsors, purgeNpcAiData } from './npc-ai-data-requests.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function replaceActor(value, previous, replacement) {
  if (value === previous) return replacement;
  if (Array.isArray(value)) return value.map((v) => replaceActor(v, previous, replacement));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k === previous ? replacement : k,
        replaceActor(v, previous, replacement),
      ]),
    );
  return value;
}
/** Remove erased-player cognition, not merely replace its identifier with a stable pseudonym. */
export function purgeLivingNpcReferences(state, actorId, archivedRoots = [], archivedIds = []) {
  if (!state || typeof state !== 'object') return state;
  // A retold observation can live in another NPC's journal without repeating the
  // original actor field. Erase the causal root across the campaign, not per NPC.
  const roots = new Set(archivedRoots);
  const erasedObservationIds = new Set(archivedIds);
  const allObservations = () => [
    ...Object.values(state.npcBrains ?? {}).flatMap((b) => b.living?.observations ?? []),
    ...(state.npcProvenance?.observations ?? []),
  ];
  const allUtterances = () => [
    ...(state.npcUtterances ?? []),
    ...(state.npcProvenance?.utterances ?? []),
  ];

  for (const observation of allObservations())
    if (
      [
        observation.actorId,
        observation.targetId,
        observation.sourceNpcId,
        observation.addressedNpcId,
      ].includes(actorId) ||
      (typeof observation.text === 'string' && observation.text.includes(actorId))
    )
      roots.add(observation.rootId);
  // A generated reply can paraphrase removed speech and itself be heard/retold.
  // Close the provenance graph before editing any journal or transcript.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const observation of allObservations())
      if (roots.has(observation.rootId) && !erasedObservationIds.has(observation.id)) {
        erasedObservationIds.add(observation.id);
        expanded = true;
      }
    for (const utterance of allUtterances())
      if (
        !roots.has(utterance.id) &&
        (utterance.speakerId === actorId ||
          (typeof utterance.text === 'string' && utterance.text.includes(actorId)) ||
          (utterance.sourceObservationIds ?? []).some((id) => erasedObservationIds.has(id)))
      ) {
        roots.add(utterance.id);
        expanded = true;
      }
  }
  if (state.npcProvenance) {
    state.npcProvenance.observations = (state.npcProvenance.observations ?? []).filter(
      (o) => !roots.has(o.rootId),
    );
    state.npcProvenance.utterances = (state.npcProvenance.utterances ?? []).filter(
      (u) => !roots.has(u.id),
    );
  }
  for (const [npcId, brain] of Object.entries(state.npcBrains ?? {})) {
    const memory = brain.living;
    if (!memory) continue;
    const removed = new Set();
    for (const observation of memory.observations ?? []) {
      if (
        [
          observation.actorId,
          observation.targetId,
          observation.sourceNpcId,
          observation.addressedNpcId,
        ].includes(actorId) ||
        (typeof observation.text === 'string' && observation.text.includes(actorId))
      ) {
        removed.add(observation.id);
        roots.add(observation.rootId);
      }
    }
    const before = (memory.observations ?? []).length;
    let audienceChanged = false;
    memory.observations = (memory.observations ?? []).filter((observation) => {
      if (removed.has(observation.id) || roots.has(observation.rootId)) {
        removed.add(observation.id);
        erasedObservationIds.add(observation.id);
        return false;
      }
      audienceChanged ||= (observation.audienceIds ?? []).includes(actorId);
      observation.audienceIds = (observation.audienceIds ?? []).filter((id) => id !== actorId);
      return true;
    });
    let changed = memory.observations.length !== before || audienceChanged;
    memory.beliefs = (memory.beliefs ?? []).filter((belief) => {
      const keep =
        belief.subjectId !== actorId && !(belief.evidenceIds ?? []).some((id) => removed.has(id));
      changed ||= !keep;
      return keep;
    });
    for (const [subject, relation] of Object.entries(memory.relationships ?? {})) {
      if (subject === actorId || (relation.evidenceIds ?? []).some((id) => removed.has(id))) {
        delete memory.relationships[subject];
        changed = true;
      }
    }
    memory.obligations = (memory.obligations ?? []).filter((obligation) => {
      if (obligation.toActorId === actorId || obligation.itemId === actorId) {
        changed = true;
        return false;
      }
      // Other participants retain their accepted commitments, without erased evidence.
      const priorEvidence = obligation.evidenceIds ?? [];
      obligation.evidenceIds = priorEvidence.filter((id) => !removed.has(id));
      if (
        priorEvidence.length !== obligation.evidenceIds.length ||
        roots.has(obligation.sourceUtteranceId) ||
        (typeof obligation.sourceUtterance === 'string' &&
          obligation.sourceUtterance.includes(actorId))
      ) {
        delete obligation.sourceUtterance;
        delete obligation.sourceUtteranceId;
        changed = true;
      }
      return true;
    });
    const causes = memory.causes ?? [];
    memory.causes = causes.filter((cause) => !removed.has(cause.observationId));
    changed ||= causes.length !== memory.causes.length || memory.goal?.targetId === actorId;
    if (changed) {
      delete memory.summary;
      memory.knowledgeRevision = (memory.knowledgeRevision ?? 0) + 1;
      memory.goal = { kind: 'patrol', revision: (memory.goal?.revision ?? 0) + 1, evidenceIds: [] };
      brain.plan = [];
      brain.cursor = 0;
      brain.waitingForPath = false;
      brain.generation = (brain.generation ?? 0) + 1;
      const npc = state.entities?.[npcId];
      if (npc) {
        npc.path = [];
        npc.movementGeneration = (npc.movementGeneration ?? 0) + 1;
        npc.revision = (npc.revision ?? 0) + 1;
      }
    }
  }
  if (state.npcNotices)
    state.npcNotices = state.npcNotices
      .map((notice) => ({
        ...notice,
        audienceIds: (notice.audienceIds ?? []).filter((id) => id !== actorId),
      }))
      .filter((notice) => notice.npcId !== actorId && notice.audienceIds.length > 0);
  if (state.npcUtterances)
    state.npcUtterances = state.npcUtterances
      .filter(
        (utterance) =>
          utterance.speakerId !== actorId &&
          !roots.has(utterance.id) &&
          !(utterance.sourceObservationIds ?? []).some((id) => erasedObservationIds.has(id)) &&
          !(typeof utterance.text === 'string' && utterance.text.includes(actorId)),
      )
      .map((utterance) => ({
        ...utterance,
        audienceIds: (utterance.audienceIds ?? []).filter((id) => id !== actorId),
        speakerKnownToIds: (utterance.speakerKnownToIds ?? []).filter((id) => id !== actorId),
      }))
      .filter((utterance) => utterance.audienceIds.length > 0);
  return state;
}
/** Retained idempotent responses are public projections, not private states. */
export function redactGameOperationSpeech(value, actorId, erasedUtteranceIds) {
  if (Array.isArray(value))
    return value.map((item) => redactGameOperationSpeech(item, actorId, erasedUtteranceIds));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === 'npcUtterances' && Array.isArray(child)
        ? child.filter(
            (utterance) =>
              !erasedUtteranceIds.has(utterance.id) &&
              utterance.speakerId !== actorId &&
              !(typeof utterance.text === 'string' && utterance.text.includes(actorId)),
          )
        : redactGameOperationSpeech(child, actorId, erasedUtteranceIds),
    ]),
  );
}
/** Remove an erased player's public hero identity from retained projections/history. */
export function redactGameHeroIdentity(value, actorId) {
  if (!value || typeof value !== 'object') return value;
  if (value.id === actorId && value.kind === 'player') {
    delete value.label;
    delete value.portraitUrl;
    delete value.portraitAssetId;
  }
  for (const child of Object.values(value)) redactGameHeroIdentity(child, actorId);
  return value;
}
export async function exportGameData(client, userId) {
  const rows = (
    await client.query(
      `SELECT c.id,c.playable_version,c.status,m.status AS membership,m.actor_id,c.state
    FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id WHERE m.user_id=$1`,
      [userId],
    )
  ).rows;
  const jobs = (
    await client.query(
      `SELECT j.id,j.campaign_id,j.npc_id,j.status,j.result_code,j.created_at,j.completed_at
     FROM game_npc_jobs j JOIN game_members m ON m.campaign_id=j.campaign_id AND m.actor_id=j.requester_actor_id
     WHERE m.user_id=$1`,
      [userId],
    )
  ).rows;
  const heroes = (
    await client.query(
      'SELECT campaign_id,hero_id,snapshot,selected_at FROM game_member_heroes WHERE user_id=$1',
      [userId],
    )
  ).rows;
  const aiJobs = await exportNpcAiData(client, userId);
  const sponsors = await exportNpcAiSponsors(client, userId);
  const decisions = (
    await client.query(
      'SELECT id,campaign_id,npc_id,purpose,status,result_code,created_at FROM game_npc_decision_requests WHERE requester_user_id=$1',
      [userId],
    )
  ).rows;
  const partyMessages = (
    await client.query(
      'SELECT id,campaign_id,text,created_at FROM game_party_chat WHERE sender_user_id=$1 ORDER BY created_at',
      [userId],
    )
  ).rows;
  const intents = (
    await client.query(
      'SELECT id,campaign_id,text,status,result_code,created_at FROM game_player_intent_proposals WHERE requester_user_id=$1 ORDER BY created_at',
      [userId],
    )
  ).rows;
  const narrativeTurns = (
    await client.query(
      'SELECT id,campaign_id,input_text,status,result,result_code,created_at,committed_at FROM game_narrative_turns WHERE requester_user_id=$1 ORDER BY created_at',
      [userId],
    )
  ).rows;
  // Account export is not permission to read other players' inventories or secret world state.
  return rows.map(({ state, actor_id, ...metadata }) => {
    const actor = state.entities?.[actor_id];
    return {
      ...metadata,
      ownNarrativeTurns: narrativeTurns.filter((turn) => turn.campaign_id === metadata.id),
      ownHero: heroes.find((hero) => hero.campaign_id === metadata.id) ?? null,
      npcRequests: jobs.filter((job) => job.campaign_id === metadata.id),
      npcDecisionRequests: decisions.filter((job) => job.campaign_id === metadata.id),
      aiSponsors: sponsors.filter((grant) => grant.campaign_id === metadata.id),
      ownIntentProposals: intents.filter((proposal) => proposal.campaign_id === metadata.id),
      ownPartyMessages: partyMessages.filter((message) => message.campaign_id === metadata.id),
      npcAiRequests: aiJobs.filter((job) => job.campaign_id === metadata.id),
      actor: actor ? { id: actor.id, mapId: actor.mapId, x: actor.x, y: actor.y } : null,
      inventory: (actor?.inventory ?? []).map((id) => ({ id })),
    };
  });
}
/** Author-owned packages are exported separately, never through another player's campaign. */
export async function exportPlayableData(client, userId) {
  const drafts = (
    await client.query(
      `SELECT d.* FROM adventure_game_drafts d JOIN adventures a ON a.id=d.adventure_id WHERE a.owner_id=$1`,
      [userId],
    )
  ).rows;
  const versions = (
    await client.query(
      `SELECT v.* FROM game_playable_versions v JOIN adventures a ON a.id=v.adventure_id WHERE a.owner_id=$1`,
      [userId],
    )
  ).rows;
  return { drafts, versions };
}
export async function purgeGameData(client, userId) {
  const campaigns = (
    await client.query(
      `SELECT c.*, EXISTS(SELECT 1 FROM game_playable_versions v JOIN adventures a ON a.id=v.adventure_id
      WHERE v.id=c.source_version_id AND a.owner_id=$1) AS source_owned FROM game_campaigns c
    WHERE c.owner_id=$1 OR EXISTS(SELECT 1 FROM game_playable_versions v JOIN adventures a ON a.id=v.adventure_id
      WHERE v.id=c.source_version_id AND a.owner_id=$1) OR EXISTS(SELECT 1 FROM game_members m WHERE m.campaign_id=c.id AND m.user_id=$1)
    ORDER BY c.id FOR UPDATE`,
      [userId],
    )
  ).rows;
  await purgeNpcAiData(client, userId, campaigns);
  for (const campaign of campaigns) {
    const hasNarrative = Boolean(campaign.state?.narrativeCanon?.turns?.length);
    if (hasNarrative) {
      // Generated retellings may contain paraphrased personal input. Preserve
      // topology and items, conservatively remove all derived narrative text.
      await client.query('DELETE FROM game_npc_episodes WHERE campaign_id=$1', [campaign.id]);
    }
    // A queued automatic decision can contain another member's erased evidence.
    // Cancel this private work rather than retaining or replaying stale context.
    await client.query('DELETE FROM game_npc_decision_requests WHERE campaign_id=$1', [
      campaign.id,
    ]);
    await client.query(
      'DELETE FROM game_party_chat WHERE campaign_id=$1 AND ($2::boolean OR sender_user_id=$3)',
      [campaign.id, campaign.source_owned, userId],
    );
    const erasedActorId = `player-${userId}`;
    const archivedRoots = (
      await client.query(
        `SELECT DISTINCT root_id FROM game_npc_episodes WHERE campaign_id=$1
        AND (actor_id=$2 OR target_id=$2 OR source_npc_id=$2 OR strpos(payload::text,$2)>0)`,
        [campaign.id, erasedActorId],
      )
    ).rows.map((row) => row.root_id);
    // Historical observations are immutable. A confirmed erasure deletes the
    // affected causal roots rather than leaving personal data in an old payload.
    const archivedIds = (
      await client.query(
        'DELETE FROM game_npc_episodes WHERE campaign_id=$1 AND ($2::boolean OR root_id=ANY($3::text[])) RETURNING observation_id',
        [campaign.id, campaign.source_owned, archivedRoots],
      )
    ).rows.map((row) => row.observation_id);
    // Pending/contextual mock plans can reference the erased actor even when another
    // participant requested them; cancellation is safer than retaining private context.
    await client.query('DELETE FROM game_npc_jobs WHERE campaign_id=$1', [campaign.id]);
    if (campaign.source_owned) {
      // A source author's erased text/maps/NPC definitions must not survive in other
      // owners' pinned saves or historical full-state payloads. Retain only tombstones.
      const erased = { erased: true };
      await client.query(
        "UPDATE game_campaigns SET state=$2,runtime_clock='{}'::jsonb,revision=revision+1,status='paused' WHERE id=$1",
        [campaign.id, erased],
      );
      await client.query('UPDATE game_events SET payload=$2 WHERE campaign_id=$1', [
        campaign.id,
        erased,
      ]);
      await client.query('DELETE FROM game_operations WHERE campaign_id=$1', [campaign.id]);
      await client.query('UPDATE game_snapshots SET state=$2,checksum=$3 WHERE campaign_id=$1', [
        campaign.id,
        erased,
        createHash('sha256').update(JSON.stringify(erased)).digest('hex'),
      ]);
      continue;
    }
    const actorId = `player-${userId}`,
      replacement = `erased-${randomUUID()}`;
    const erasedUtteranceIds = new Set();
    const deletedReplyRoots = new Set();
    const eraseDerivedArchive = async () => {
      const roots = [...new Set([...erasedUtteranceIds, ...archivedRoots])].filter(
        (id) => !deletedReplyRoots.has(id),
      );
      if (!roots.length) return;
      const deleted = await client.query(
        'DELETE FROM game_npc_episodes WHERE campaign_id=$1 AND root_id=ANY($2::text[]) RETURNING observation_id',
        [campaign.id, roots],
      );
      archivedIds.push(...deleted.rows.map((row) => row.observation_id));
      archivedRoots.push(...roots);
      for (const root of roots) deletedReplyRoots.add(root);
    };
    const cleanPrivateState = (original) => {
      if (hasNarrative) redactNarrativeContent(original);
      const observations = [
        ...Object.values(original?.npcBrains ?? {}).flatMap((b) => b.living?.observations ?? []),
        ...(original?.npcProvenance?.observations ?? []),
      ].map((o) => ({ id: o.id, rootId: o.rootId }));
      const speechIds = [
        ...(original?.npcUtterances ?? []),
        ...(original?.npcProvenance?.utterances ?? []),
      ].map((u) => u.id);
      const cleaned = purgeLivingNpcReferences(
        redactGameHeroIdentity(original, actorId),
        actorId,
        archivedRoots,
        archivedIds,
      );
      const retainedEvidence = new Set(
        [
          ...Object.values(cleaned?.npcBrains ?? {}).flatMap((b) => b.living?.observations ?? []),
          ...(cleaned?.npcProvenance?.observations ?? []),
        ].map((o) => o.id),
      );
      for (const observation of observations)
        if (!retainedEvidence.has(observation.id)) {
          if (!archivedIds.includes(observation.id)) archivedIds.push(observation.id);
          if (!archivedRoots.includes(observation.rootId)) archivedRoots.push(observation.rootId);
        }

      const retained = new Set(
        [...(cleaned?.npcUtterances ?? []), ...(cleaned?.npcProvenance?.utterances ?? [])].map(
          (u) => u.id,
        ),
      );
      for (const speechId of speechIds)
        if (!retained.has(speechId)) erasedUtteranceIds.add(speechId);
      return cleaned;
    };
    const state = replaceActor(
      cleanPrivateState(structuredClone(campaign.state)),
      actorId,
      replacement,
    );
    await eraseDerivedArchive();
    const actor = state.entities?.[replacement];
    if (actor) {
      for (const itemId of actor.inventory ?? []) {
        const item = state.entities[itemId];
        if (item?.ownerId === replacement) {
          delete item.ownerId;
          Object.assign(item, {
            mapId: actor.mapId,
            x: actor.x,
            y: actor.y,
            revision: item.revision + 1,
          });
        }
      }
      delete state.entities[replacement];
      for (const encounter of Object.values(state.encounters)) {
        encounter.participants = encounter.participants.filter((id) => id !== replacement);
        delete encounter.intents[replacement];
        if (encounter.pendingJoinIds)
          encounter.pendingJoinIds = encounter.pendingJoinIds.filter((id) => id !== replacement);
        if (encounter.coordinatorId === replacement) {
          if (encounter.participants.length) encounter.coordinatorId = encounter.participants[0];
          else delete encounter.coordinatorId;
        }
        if (!encounter.participants.length) {
          encounter.phase = 'completed';
          encounter.pendingJoinIds = [];
        }
        if (encounter.endVotes)
          encounter.endVotes = encounter.endVotes.filter((id) => id !== replacement);
      }
      for (const entity of Object.values(state.entities))
        if (entity.knownIds) entity.knownIds = entity.knownIds.filter((id) => id !== replacement);
      for (const [npcId, brain] of Object.entries(state.npcBrains ?? {})) {
        brain.facts = brain.facts.filter((fact) => fact.targetId !== replacement);
        if (
          brain.plan.some(
            (action) => action.targetId === replacement || action.itemId === replacement,
          )
        ) {
          brain.plan = [];
          brain.cursor = 0;
          brain.waitingForPath = false;
          brain.generation++;
          const npc = state.entities[npcId];
          if (npc) {
            npc.path = [];
            npc.movementGeneration = (npc.movementGeneration ?? 0) + 1;
            npc.revision++;
          }
        }
      }
      state.revision++;
    }
    // Immutable history has only fixture semantics in G0–G3; remove identifying actor IDs
    // while preserving other members' items and deterministic world outcomes.
    const events = (
      await client.query(
        'SELECT sequence,payload FROM game_events WHERE campaign_id=$1 ORDER BY sequence',
        [campaign.id],
      )
    ).rows;
    for (const event of events) {
      const original = structuredClone(event.payload);
      if (hasNarrative) redactNarrativeContent(original);
      if (original?.state) original.state = cleanPrivateState(original.state);
      await eraseDerivedArchive();
      const payload = replaceActor(original, actorId, replacement);
      await client.query('UPDATE game_events SET payload=$3 WHERE campaign_id=$1 AND sequence=$2', [
        campaign.id,
        event.sequence,
        payload,
      ]);
    }
    // Old reply provenance may have left the hot window. History is processed
    // chronologically above; apply its full closure to the current checkpoint too.
    cleanPrivateState(state);
    await eraseDerivedArchive();
    await client.query('DELETE FROM game_operations WHERE campaign_id=$1 AND actor_id=$2', [
      campaign.id,
      actorId,
    ]);
    const operations = (
      await client.query(
        'SELECT actor_id,operation_id,result FROM game_operations WHERE campaign_id=$1',
        [campaign.id],
      )
    ).rows;
    for (const operation of operations)
      await client.query(
        'UPDATE game_operations SET result=$4 WHERE campaign_id=$1 AND actor_id=$2 AND operation_id=$3',
        [
          campaign.id,
          operation.actor_id,
          operation.operation_id,
          replaceActor(
            redactGameHeroIdentity(
              redactGameOperationSpeech(
                hasNarrative ? redactNarrativeContent(operation.result) : operation.result,
                actorId,
                erasedUtteranceIds,
              ),
              actorId,
            ),
            actorId,
            replacement,
          ),
        ],
      );
    await client.query(
      "UPDATE game_campaigns SET state=$2,runtime_clock=jsonb_set(runtime_clock,'{jobs}','{}'::jsonb),revision=revision+1,status=CASE WHEN owner_id=$3 THEN 'paused' ELSE status END WHERE id=$1",
      [campaign.id, state, userId],
    );
    const checksum = createHash('sha256')
      .update(JSON.stringify(canonical(state)))
      .digest('hex');
    await client.query('UPDATE game_snapshots SET state=$2,checksum=$3 WHERE campaign_id=$1', [
      campaign.id,
      state,
      checksum,
    ]);
  }
  await client.query('DELETE FROM game_member_heroes WHERE user_id=$1', [userId]);
  await client.query('DELETE FROM game_members WHERE user_id=$1', [userId]);
  await client.query(
    'DELETE FROM adventure_game_drafts d USING adventures a WHERE a.id=d.adventure_id AND a.owner_id=$1',
    [userId],
  );
  await client.query(
    `UPDATE game_playable_versions v SET package='{"erased":true}' WHERE EXISTS(SELECT 1 FROM adventures a WHERE a.id=v.adventure_id AND a.owner_id=$1)`,
    [userId],
  );
}
