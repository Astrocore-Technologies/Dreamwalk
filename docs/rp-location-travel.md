# Roleplay location travel

Hybrid-v3 supports a scene cut with `travel`, separate from the existing door/exit `transition`. The public picker and a recognized explicit departure attempt can choose an existing map from any point. No walking path, adjacency or door check is used. Phase/fence, active-encounter and safe destination placement checks still apply. No main/additional action is charged. Only the requesting player and present, living NPCs with an existing voluntary companionship agreement move. Other players do not move.

Only public map IDs, labels and authored translations enter the picker/context. Remote actors, geometry, inventory and NPC memories do not. Name matching prefers exact public labels; bounded RU/UK inflection matching cannot choose among multiple candidates. Questions, negations, private whispers and ambiguous/multiple destination attempts cannot authorize travel.

## A missing destination

The free post queues its departure. At world entry, the runtime prepares a durable future scene specification, based on the world premise, current shared canon and requested place. The current bounded engine templates remain room/courtyard, with a 24×24 collision map. This does not invent new actors, inventory or secret knowledge. A native background-image request is fixed before pricing. The director receives the full frozen scene and image prompt; the completed proposal must retain that exact scene.

Ordinary Send → End turn does not authorize illustrated-location spending. The server detects the committed missing-location intent before automatic quoting, retains its queued request, and exposes read-only media flags so the UI shows the single explicit confirmation. Ordinary consent also rejects persisted media entries and risk/image flags. Explicit media acceptance atomically consumes any pending text-only authority for that same round, preventing a later automatic attempt from cancelling accepted siblings.

The owner can decline the exact pending location requests, including when pricing is unavailable. This cancels only demonstrably unpaid travel and invalidates unaccepted quotes; it preserves prior effects and resumes the already-authorized ordinary round. Accepted media, native jobs, permits, holds and uncertain outcomes cannot be cancelled this way. Repeating a lost cancellation response targets the same request IDs and never falls back to a generation call.

One world quote adds the exact native image quote to the exact text quotes, including Sparks/Dreams funding, provider reserve, expiry and estimate-risk notice. Quoting/cancelling does not dispatch or reserve money. One explicit consent accepts both; the free departure post and final mechanical arrival do not prompt again.

Native jobs serialize image and text admission. A new scene never enters campaign state until its raster has been admitted. Art pin, new map, canonical introduction and arrival share one transaction. A failed final pin rolls back the whole arrival and terminalizes the exact ready text job while retaining provider accounting.

Independent players may create different places in one batch. Their connections and aggregate capacity are reserved during preparation. A narrow rebase allows only unchanged original canon plus committed travel scenes from independent actors in that same batch. It preserves the original paid request and evidence boundary. Other narrative changes are not silently rebased. A repeated missing name or a second itinerary for the same actor is rejected before payment, rather than generating duplicate places or silently moving that actor twice.

The local departure parser is only a free fast path, not the limit of roleplay vocabulary. The ordinary director may semantically interpret a deliberate departure within arbitrary or mixed attempt prose via typed `travelIntent`. Other validated effects (including an item pickup) commit once in that original turn. A missing destination then creates a deterministic, unpaid continuation bound to the original actor, turn and provider result, with only the interpreted destination and public scene description. It does not replay the original actions or sell the original text job again. Its single explicit text+image quote follows after the original round's admitted work finishes. Existing unambiguous destinations use the same free scene-cut reducer after the original effects. Speech, whispers and other-player actions cannot independently authorize this field.

The semantic continuation uses its own native image and arrival-text jobs; these are separate new work included together in the visible quote, not a repeat charge for interpretation. It remains pending across restart without automatic image spending. The internal exact image/arrival operation still rejects mixed extra effects or another travel intent, so paid recovery cannot unexpectedly acquire an item, harm an NPC or start a second journey.

Legacy realtime saves can freely visit existing maps. New illustrated-location generation requires enabling turn-based play; it is rejected before a paid realtime text quote.

## Durable consent and failures

Migration 059 stores preparations and the world batch's finite media entries. After acceptance, a native image/Sparks quote may pass its original TTL only when the original owner, quote, operation, scene/input hash, immutable price/tariff snapshot, accepted batch and world authorization still verify. This is not a future spending allowance. Current provider/policy, source access, raster admission and native financial guards remain mandatory.

A pending/unknown image or text liability blocks new paid siblings. Recovery does not buy replacement work automatically. Known provider costs are not called refunds. Travel receipts expose image status and actual/reserved funding even if arrival fails. Deterministically impossible scenes fail unspent without trapping the world phase. Transient database failures retry rather than being recorded as successful or terminal outcomes. A terminal native text parsing/schema failure retires its exact travel request and preparation, so the receipt stops showing preparation while the original costs and holds remain unchanged.

The image and preparation remain private, and author reuse is disabled. Erasure removes scene, image input and the stored canon snapshot while retaining existing financial evidence and anti-replay records.

## Verification

- Core travel tests cover parsing, fences, free movement, NPC consent, safe placement, privacy and atomic state changes.
- Generation/consent unit tests cover exact input, immutable consent, unknown outcomes, forged/expired/changed evidence and independent scene rebasing.
- `integration-location-travel.test.mjs` uses disposable PostgreSQL, real native accounting and injected synthetic text/image transports. It covers restart, one combined consent, multiple players, impossible scenes, quote TTL, atomic pin failure, semantic mixed pickup→pending→consent→arrival without duplicate effects or jobs, and unknown image liability. No live paid provider calls are used.
- Component handler tests cover picker replay/disabled/map-change behavior and one explicit combined image-risk confirmation. These are not screenshot/browser tests.

Synthetic tests establish orchestration and accounting, not the literary or artistic quality of a real model response.

New v2 legacy-fixed image quotes reserve their actual quoted estimate, not the historical fixed 20-Sparks floor. Status advertises the same current baseline. Historical accepted quote/hold evidence remains immutable; actual provider usage may exceed an estimate and is never advertised as a guaranteed cap.
