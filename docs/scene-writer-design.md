# Scene writer: one reply call for everyone who answers a message

Status: implemented behind `ENSEMBLE_REPLIES=true` (default off). The cheap parts shipped first
(reply written before the inner thought, names of co-responders, craft rules, prose metrics).
This document records what the change preserves in the paid request path.

## As built

- `planEnsembleGroups` (`game/ensemble-replies.ts`) groups the queued public `say` replies of one
  message (2–4 requests; a whisper, an all-optional group or a bigger one never merges).
- `prepareWorldRequests` (before pricing) writes the lead's context with `ensemble.members`
  (each member's public speech context only, no history or private memory) and every other
  request with `ensembleFollowerOf`. The lead's quote therefore prices the real combined body.
- The speech schema/instructions for the lead add `ensembleLines [{speakerId, text}]`; the provider
  accepts only speakers listed in the ensemble, each at most once.
- A follower job is served from the lead's stored proposal through the existing application-cache
  settlement (hold released, zero cost, `CACHE_REUSED`). If the lead is still running the follower
  waits; if the lead failed or wrote no line, the follower makes its own call as before.
- Not verified here: the DB paths run only with the flag on; enable it for a rehearsal first.

## Problem

A player message to several characters creates one independent `speech` request per
character (`prepareAreaTurnSpeech` → `simulateTurnPost`), all prepared from the same state
snapshot (`prepareWorldRequests`, before pricing). They cannot read each other's lines, so they
mirror each other (see `tests/game/prose-metrics.test.cjs`), and the cost is 1 director call + N
reply calls per message.

## Why it is not a small change

Each request is bound end to end and must stay idempotent and unspent-safe:

- the body is quoted and (with exact counting) hash-bound to its text-count evidence;
- `game.service.ts` re-checks `contextHash`, frozen contexts, `digest(bound.context)` and the world
  admission before dispatch, and fails an unspent request (`failUnspent`) on any drift;
- `world-generation-batch.ts` prices and reserves every queued `world-batch-v1` request in one
  batch; settlement, holds and the append-only Sparks ledger are per request.

So the combined call must be ONE request (one quote, one reservation, one settlement), never a
chain of dependent quotes.

## Design

1. **One request, one lead.** After `simulateTurnPost` collects N speech requests for the same
   turn and segment (public `say` channel only; never whispers), keep the first as the lead and
   add `context.ensemble = [npcIds]`; drop the others before they are persisted. The reservation
   is the lead's, sized for the ensemble.
2. **Public cards only.** The ensemble context holds, per character: label, public profile,
   goal and the shared public scene history. No secrets, no private memory, no whisper content: a
   single prompt must never hold two characters' private knowledge (AGENTS.md: never expose NPC
   secrets). Characters keep their private depth in single-reply mode.
3. **Free text output.** The reply is a list of `{speakerId, text}` lines in the output language,
   no per-character intents (actions stay in the voluntary world-round `plan` requests).
4. **Commit splits the lines.** The lead's result is applied as one speech event per speaker
   through the same recording path as a single reply (observations, memory, feed entries, audience
   checks). Speaker ids outside the ensemble are rejected.
5. **Flag.** `ENSEMBLE_REPLIES=true` enables it; default off, so shipping the code changes nothing.

## Tests required before enabling

- unit: line splitting, unknown speaker rejected, secret/whisper content never in the context;
- mock provider: ordering and audience filtering;
- DB integration: one quote/reservation/settlement for N speakers, replay is idempotent, a stale
  context fails unspent, nothing is charged twice.

## Related, deliberately separate

- Output cap: replies are capped at 2048 tokens; Isekai Zero shows tokens for story, context and
  message instead. Showing the quote's token breakdown is possible, but a cap change changes the
  cost ceiling and must go through the same quote path.
- Provider (OpenRouter) and file splitting are unchanged here.
