# Ordinary turn admission

The turn-based interaction is one Send followed by End turn. Send prepares and commits a free `local-turn-resolver` post under the same UI lock, with the captured input and operation ID retained for uncertain-response recovery. Mechanical input still uses the server's immutable action hash. Malformed or stale input fails rather than being invented or turned into an extra clarification step.

End turn carries `ordinaryGeneration: true`. Only a successful command by the campaign owner in the player phase can persist an allowance in `game_ordinary_round_consents`. The allowance is unique to that campaign and round, with the original command operation ID. In co-op it survives until the other players finish that same round. Guests, legacy commands, rejected fences, read-only polling and later rounds cannot authorize the owner's spending.

The world worker prepares the complete finite roster, obtains the existing exact native quote, and accepts it against that allowance. It uses the existing access checks, immutable quote/request/context identities, Dreams-first balance checks, native holds and job idempotency. Native map token preflight runs outside the campaign serial lock. Consent and the server-only `ordinaryTurnConsentVersion: end-turn-v1` batch marker commit atomically. No new paid generator or retry mechanism exists.

A definitive pricing, balance or preflight failure blocks that round's unpaid generation and is shown as an informational error. It never discards a native job, hold, permit or uncertain liability. Connection uncertainty retries the same durable identity. A finished round without paid work clears its pending allowance. Existing unknown charges are not retroactively authorized or settled.

New-location image generation is excluded: nonzero `generatedLocationImages`, `estimateRiskConsentRequired`, or nonempty persisted `media_entries` require the explicit combined text+image confirmation. The travel implementation must expose its media flags in world status and keep this server guard when rebasing.

Cost shown while composing remains an estimate before full map/context analysis, not a provider-enforced cap. The existing native settlement rules remain authoritative. A verified failed response may settle once within its original reservation only when the new server-marked exact batch proof is valid; old pending or unverified/overrun charges stay closed.

Targeted verification is in `ordinary-round-admission.test.cjs`, the two ordinary-round cases in `integration-world-generation-batch.test.mjs`, and the changed composer/world-status cases in `story-confirmation-safety.test.mjs`. Tests use disposable state and injected synthetic providers, not real campaigns or paid calls.
