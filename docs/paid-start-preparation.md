# Player-funded initial plan

Authors publish immutable source content without paying for a spatial plan. The
existing private invitations and public moderation/approval boundaries still apply.
Source-only versions freeze narrative/NPC input and reusable image rights; they are
not silently represented as ready maps. Existing compatible authored game versions
continue to work without any preparation charge. A previously paid initial plan is also
reused for the same player, source version and unchanged hero snapshot; ongoing
campaign state is never reused as an initial plan.

A player presses Start on the story page. Preparation is bound server-side to that
authenticated player, immutable source version/checksum, chosen hero snapshot and a
durable operation ID. If a plan is missing, the server supplies a frozen Sparks
quote; only explicit confirmation admits the text request. It reuses the existing
provider accounting, reserve/capture and unknown-outcome rules. No image request is
made. The plan is compiled into this player's new campaign, never the author's draft.

One preparation links at most one campaign transactionally. Retries and simultaneous
requests return that campaign; resume and invitations do not run or charge planning.
Unknown jobs keep their reservations and cannot be regenerated automatically. A
known terminal failure permits an explicit new preparation and new confirmation.
The browser keeps only operation IDs in session storage to recover an interrupted
start. Home links to the story's shared launch flow; existing resume links are unchanged.

Internal start projects are excluded from normal visual editors and spatial-planner
endpoints. Player status/export does not return foreign author NPC definitions or
private compiled brains. Confirmed erasure scrubs source text and deletes preparation
snapshots while preserving financial receipt history and uncertain reservations.

Migration 052 is additive. There are no backfills, balance grants, model changes or
production activation in this feature. Tests use disposable PostgreSQL and injected
providers only. Real provider access is not tested by the assistant.
