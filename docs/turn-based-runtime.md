# Dreamwalk sequential turns — local implementation

This mode is an explicit versioned opt-in. A pinned authored `turnRules` preset initializes a new campaign; legacy campaigns retain their existing hybrid mechanics. A source-free compatibility template may be started with `turnBased: true` as the current authored Observatory acceptance fixture. Requesting that flag for an authored pre-v3 package without a turn preset returns `TURN_RULESET_UPGRADE_REQUIRED`; it never substitutes a different map or silently migrates an existing save.

## Supported rules and timing

The pinned `dreamwalk-base` version 1 preset controls movement, main/additional/reaction resources, vitality, hit damage, push distance, finite world/NPC action limits and addressed-message limits. Defaults are six movement steps, one main action, one additional action, one reaction, six vitality, one hit damage and one push step. This is a small Dreamwalk ruleset, not a complete D&D edition or an executable author scripting system.

Accepted players act in stable join order. During a player turn, mouse movement and supported physical actions commit immediately. Text `*attempts*` use the same strict action resolver and resources. Speech is free, bounded separately, and never asserts mechanical success. Invalid input does not spend resources; a supported blocked push can spend the configured main action while reporting its actual blocked outcome. Public inspection is read-only and free. Disconnection does not silently skip the active actor.

An eligible player reaction durably interrupts a player or NPC world attack. Defend or decline resolves the pending attempt once and resumes its original phase. This does not impose an immediate scripted personality response on an NPC. Reactions have a bounded depth and consume the same persisted reaction resource.

Wall-clock transport, authorization, quote expiry and provider accounting continue independently. Gameplay no longer advances from the 50 ms timer in this mode: no NPC patrol, path follower or autonomous routine moves while a player reads or composes a message. Logical movement/action time advances only through committed mechanics.

## Ordered dialogue and finite world phase

One player may walk to NPC A, submit a message, walk to NPC B, submit another message and then end their turn. Each message stores its own exact admitted observation, recipient, order, channel, original audience and permitted knowledge references. Its displayed player post commits immediately, and its NPC response waits for the world phase after all player turns. A whisper does not become a shared director input.

Deferred replies use the explicitly stored dialogue audience even if the speaker has since walked to another NPC. This is the turn-based dialogue delivery rule; it is not a new global NPC mind. Normal non-deferred speech retains its existing distance/hearing checks. Retention protects pending source observations, and erasure invalidates affected pending work.

The finite world phase drains addressed messages in order, admits bounded personality/context provider decisions for significant perceived events and continues already validated plans through the same world-action rules. Click or text hit/push creates perceived harmed/pushed evidence. At most one new autonomous plan decision is selected per NPC per world round; deduplicated causes are not retried automatically. The world pauses at a persisted reaction and resumes after its response. No model is called once per idle tick or indiscriminately for every NPC.

The default and all acceptance providers are deterministic mocks. Their response content is not proof of live model personality, naturalness or tactical quality. Existing NPC provider/sponsorship/ledger controls remain required for any future external decision. The free local mechanical quote never authorizes a paid world director: deferred director generation in this implementation permits only the zero-price mock provider. Provider uncertainty remains in the existing financial ledger and cannot be converted into a free retry.

## Persistence and API boundaries

`GameState.turnController` is part of the same campaign/checkpoint/event transaction as mechanics. Its pinned rules, round ID, phase epoch, actor order, remaining resources, pending resolution/reaction and private addressed-message references restore after restart. Public projections expose only safe turn status, the viewer's resources and permitted pending-reply counts.

The phase fence is `{ roundId, phaseEpoch, rulesetVersion: 1 }`; it is separate from socket `connectionEpoch`. New-mode move requests additionally carry a UUID `operationId`. Committed movement stores its receipt, input sequence, confirmed path and budget atomically; retries after reconnect recover the same logical operation. Existing commands add `turnFence`, `type: 'turn.end'`, or `type: 'turn.reaction'` with `decision: 'defend' | 'decline'`. Repeated End Turn cannot skip a second player. Explicit member revocation removes their turn participation; mere absence does not.

Unified story quote/submit endpoints remain the ordinary player flow. They preview local mechanics, commit supported attempts and queue distinct addressed speech in one writer transaction. NPC replies are written to the same audience-filtered chronological feed with their original channel and authoritative commit order. The old advanced narrative/AI mutation routes are blocked in this mode so they cannot bypass its turn budget.

NPC jobs are checked against the persisted round/phase/ruleset at queue, claim and immediately before dispatch, then checked again before game commit. A stale result cannot change another turn. External request receipts, actual cost and unknown liability remain governed by the existing ledger rather than by gameplay success.

## Verification commands

`GAME_TEST_FILE=integration-turns.test.mjs npm run test:game:integration` covers immediate committed walking, budgets shared by click/text, two private/public NPC addresses, no player-phase autonomy, ordering, End Turn replay, restart, explicit legacy-map gating, perceived click harm and player/NPC world reactions. `integration-turn-provider-fences.test.mjs` adds real PostgreSQL queue/dispatch fence checks with a controlled zero-network provider. Test commands and actual outcomes are recorded in the final progress entry; this document does not claim an unrun browser or production/provider pass.
