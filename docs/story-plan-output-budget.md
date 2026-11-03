# Story-plan output budget

`text.storyPlanMaxOutputTokens` is an optional operator-reviewed override for the
opening story-plan authoring request only. Other text operations continue using
`text.maxOutputTokens`. Omitting it preserves existing limits; deployment does
not silently increase an approved provider cap. The override requires per-request
estimation and must fit the configured context window and financial caps.

For a structured plan that exhausts 2,048 output tokens, 8,192 is a proposed
starting ceiling, not a proven model-quality guarantee or an approved live setting.
Review the configured rates and reserve margin before applying it. Its output
reserve increases by 6,144 tokens times the reviewed output rate, with the existing
estimate margin applied. Input estimates can also change when the prompt changes.

The effective cap is included in the exact request body, provider version, request
snapshot, estimate and policy receipt. A cap change invalidates old consent; obtain
a fresh quote and consent before any new request. Never retry a dispatched job or
reuse its reservation under a larger cap. The compact prompt limits decorative
surfaces, collision cells and optional item/stock output without dropping required
source locations or NPCs. Existing semantic validators still apply.

## Incomplete response and pending hold

A provider response with known usage but an incomplete or invalid plan records
actual provider cost and a terminal failed job. It does not mean successful player
preparation. The current accounting contract uses `failure_policy_pending`, leaves
the player's hold pending, and does not capture or release it automatically. A
refresh is read-only reconciliation, not a new attempt.

Pending holds require a separately approved failure disposition and explicit
reconciliation through the accounting boundary. Do not label an incomplete result
as successful in order to capture it, treat a dispatched request as not dispatched
to release it, delete ledger history, or issue a replacement charge while hiding
the pending hold. This change introduces no production reconciliation or refund.

## Applying an explicitly approved release change

After the code is merged and deployed, read the current nonsecret
`GENERATION_CONFIG_JSON` through the authorized operator configuration path. Parse
that exact JSON and change only `text.storyPlanMaxOutputTokens` to `8192`. Assert
that `text.maxOutputTokens` remains `2048`; preserve all other fields, including
model, rates, cache pricing, context/input limits, estimate assumptions, caps,
allowance, image settings, and both pricing review and expiry timestamps. Do not
renew expired pricing or introduce estimation as an incidental part of this change.
If existing estimation is absent, pricing has expired, or validation fails, stop
and report the specific additional review needed.

Validate the candidate locally with `readGenerationConfig` in release mode and
the actual current time before applying it. Compare parsed before/after objects
to ensure the override is the sole raw configuration change. The validator derives
a new `configFingerprint`; do not inject or manually patch this derived field.
Safe policy receipts include the explicit override. Existing stored job snapshots,
receipts, financial scope identifiers and pending holds must remain unchanged.
Verify the deployed version and effective runtime setting through authorized
metadata after application. A new estimate and explicit player consent are still
required before any subsequent paid dispatch; do not use verification to generate
a paid test request. Changing policy is not settlement of the earlier failed job.
