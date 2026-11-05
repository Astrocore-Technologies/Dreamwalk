# Release NPC communication

## Separate intention, speech, and delivery

A planned `communicate` action is an intention, not public speech. Release orchestration must obtain an admitted real speech result before publishing an utterance or propagating a reported observation. The core delivery boundary is checked after resolving no-op movement, so a later communication cannot fall through to fixture rendering. Offline and mock execution retain their deterministic fixture path.

Each future utterance is tied to the original committed plan request, round, NPC generation, and action cursor. A queued or terminal request is durable across reloads. New native utterance IDs include the immutable admitted delivery identity, so repeated words in another admitted job do not merge with an earlier line; replay of the same delivery remains idempotent and old IDs are unchanged. Exact same-round speech may satisfy the intention only when recipient, channel, source evidence, and actual audience all match. A different target or channel is not a duplicate. Delivery uses the ordinary action budget and consumes the cursor once. Failed, declined, silent, or uncertain work never produces substitute words or an automatic retry. The autonomous speech response schema admits speech or silence, not additional item, movement, or companionship intents; ordinary player replies keep their existing supported intents. The same contextual contract is used for quote, count, and dispatch.

## One bounded round consent

New round consent explicitly includes at most one optional autonomous speech request per planned NPC. The forecast separates existing work from this optional configured ceiling. The ceiling uses the configured context and transport limits, output limit, reviewed tariff, and normal reserve margins; it is not a prediction of the final charge. No images or operational count calls are included in this speech allowance.

Original batch entries remain unchanged. A separate immutable binding admits one exact native speech quote after the committed plan selects communication. Admission and known-cost settlement verify the source plan and action, original payer, turn, context, tariff, and native quote. Reload or a lost response cannot authorize a second child. Unknown liability blocks replacement spending. An unused allowance creates no provider charge. If that ordinary round allowance is exhausted or cannot still be safely used, the unspent request is skipped with an owner-visible reason and the round continues. It does not ask for another confirmation or silently expand the allowance.

Old consent does not gain new permissions. Unspent autonomous speech outside that historical consent is skipped without a new confirmation, charge, or invented speech; the round can finish. Separately accepted exact legacy speech and its existing liability remain valid and are settled under their original proof. Account erasure and quote cleanup must preserve this boundary without leaving foreign-key failures or deleting a still-needed bound quote.

## Durable delivery and receipts

Accepted autonomous dialogue is stored atomically as a native-job-origin feed entry, without inventing a player turn. It survives the bounded hot utterance window, keeps the original audience and speaker recognition, and is removed by approved privacy erasure. Replay cannot create another line. Silence does not create a feed line.

The owner receives a separate paginated history of durable cost metadata for admitted autonomous children, including legacy exact-consent work. Each read returns at most 20 entries; loading older receipts is read-only and does not change the current liability gate. This receipt does not depend on spoken text: silence, rejected output, uncertain liability, captures, and released reserves remain visible without exposing private planning or evidence.

## Existing companionship and private memory

Typed companion agreement already authorizes collision-safe following and observed cross-map continuation. Prose alone does not. Private planning now receives the current agreement and its current next action; the model may deliberately continue, pause, or revoke rather than following a stale coordinate blindly. Public dialogue receives only agreement information safe for its entire audience.

Audience filtering is not memory loss. A private conversation remains available to the NPC's private planning while being excluded from speech heard by unauthorized listeners. General dialogue guidance must not turn that absence into an unsupported claim that the NPC never heard it, and must not reveal the existence or contents of hidden observations.

## Canonical evidence in director responses

The response schema restricts narrative evidence to the request's canonical evidence allowlist. An empty allowlist permits only an empty citation array. History message IDs and NPC observation IDs are not promoted to canonical evidence. Quoting, counting, and restarted dispatch use the same body; source changes invalidate the old body. Invalid provider citations retain their known usage receipt and do not trigger an automatic retry.

## Verification boundaries

Synthetic tests cover delivery, deduplication, replay, no-op prefixes, private-memory noninterference, companion continuation, exact response bodies, and financial admission. Real PostgreSQL tests cover binding rollback/concurrency, native settlement, legacy decline, unknown outcomes, cleanup, and erasure order. Required CI and independent review remain release gates. Synthetic transports are not evidence of real model dialogue quality.
