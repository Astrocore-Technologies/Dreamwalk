# Cloud authoring checkpoint — 2026-11-01

Independent implementation integrated with verified main `77098c2a`, including merged
PR 28 and its focus-boundary and authorized NPC portrait fixes. No original story, save, invitation, paid provider request, live database,
credential, payment processor or deployment is changed by this work.
This continuation is prepared as a separate draft PR after merged PR 28.
Migration 043 is inherited unchanged from current main, not introduced by this continuation.

## Implemented authoring path

- Story NPC creation/editing is inline. Import creates an independent story-owned copy;
  optional export creates an independent library template. Original template IDs are
  retained as ancestry, not aliases that can be edited through another story.
- Saves use story/NPC revision fences and durable operation identities. Global library
  endpoints cannot edit or enumerate scoped NPC rows. Duplicating a story copies its NPCs.
- The existing general AI story-plan builder replaces the ordinary manual grid controls
  in Studio. It saves author edits first, restores its durable latest build, distinguishes
  stale and unresolved results, and requires explicit quote consent and plan review.
  Supported opening remains 1–4 locations and at most 8 NPCs; no bespoke tavern repair.
- Applying an assembled plan is NOT publication. An explicit private-release action
  validates current source IDs, compiles/pins an immutable playable package and saves
  a separate frozen release. The personal library has a playable-release tab.
- Invitees see the current released snapshot, not the draft or private test packages.
  New starts use the current release; existing saves retain their released version while
  invitation access remains valid. Raw images, invitation metadata, notifications,
  package access and history respect the same boundary. Owners retain Studio test access.
- Saved NPC/hero forms include the existing drawn static-sprite controls with explicit
  reference permission, quote/consent and unchanged pinned campaign appearances.
- RU/UK/EN closed-test About/Rules/Privacy drafts are integrated exactly as reviewed;
  content-policy shares the draft Rules. Unknown operator/contact/age/provider details
  remain explicit. This is not a claim of final legal readiness or acceptance terms.

## Map presentation and generation framing

The planning schema has never forced every room to 8×8: its existing bound is 8–24,
and accepted model dimensions are copied unchanged. Previously locations exposed only
prose, and synopsis was absent from the planning source. Newly prepared sources include
synopsis; an older preparation omitting a nonempty synopsis must be prepared again,
without rewriting its immutable snapshot or automatically dispatching a paid request.

Locations now optionally carry validated exact dimensions or a feasible rational aspect.
The normal authoring form saves that intent; source/quote identities include it, the
versioned prompt prioritizes it over previous geometry, and compilation rejects mismatch
rather than silently resizing. Rejection is clearly labelled and retains existing actual
cost/pending-charge semantics. Without explicit intent, prose remains model interpretation,
not a promise that every requested shape will be followed. No model fault is inferred
without checking the actual authored source supplied to that request.

The entire map now uses an aspect-preserving contain-fit camera, with user zoom relative
to that fit and reset/recenter returning to the full world. Viewport resize preserves
the chosen relative zoom. Backgrounds, entities and pointer hit testing share the world
transform. Existing unversioned/pinned backgrounds retain their original full-world mapping;
only newly admitted versioned framing, validated against the current map and raster, opts
into containment. Old square artwork on rectangular worlds is not silently repositioned.
Square worlds retain margins in widescreen viewports. No visible grid, grid toggle or
movement/turn rule change is introduced.

New background preparations derive pixel dimensions from authoritative map bounds, never
from the user's screen. The versioned resolver selects an exact aspect on the pinned
model's supported 16-pixel lattice near one megapixel; impossible/extreme ratios use a
clearly labelled contain fallback. New quotes freeze framing version, map/source identity,
resolved dimensions, policy and cost evidence; result dimensions must match before admission.
Old unversioned quotes/jobs retain their prior hash and interpretation.

Legacy fixed-size policy remains unchanged by default. A separately reviewed bounded
custom-size policy can permit different resolved map aspects under one approval, with
explicit pixel/edge/aspect/quality limits, operator-supplied conservative output-token
assumption and provenance. This is `approved_estimate`, not a provider-enforced invoice
ceiling or an invented per-pixel tariff. Actual token rates remain frozen per quote and
actual usage is settled; overruns and uncertainty retain existing stop/reconciliation
behavior. Incompatible range bounds reject explicitly rather than silently repricing or
choosing a different resolution. No policy is activated or existing artwork regenerated.
Preparation intentionally uses a deterministic model-based resolution without operator
state reads; a narrower reviewed range may reject that resolution even if another size
would fit the range. Illustrations without an authoritative map are labelled as such.

## Sparks: implemented and deliberately not activated

Approved design: $5 = 200 Sparks; one API-cost cent = one Spark, with no second markup.
The exact representation is 10,000 integer subunits/Spark, equivalent to one USD micro
per subunit. Pure immutable tariff snapshots support cache-aware rates, conservative
reservation, tiny amounts, overflow checks and exact four-decimal detail.

Migration 042 introduces separate zero/disabled wallets, immutable quotes, holds and
an append-only ledger. Transactional accounting supports reserve, actual capture,
surplus release, idempotency, concurrency and pending unknown/failure liabilities.
Existing demo balances are not converted. Existing provider-dollar limits remain separate.
Cached-input usage evidence is validated and stored; legacy quotes are NOT repriced
with an invented cache rate.

Dispatch is now wired behind an explicit enabled-wallet policy: NPC generation, manual
NPC permits, authoring text and image jobs bind immutable quotes, reserve before dispatch,
and capture verified actual cost only after successful semantic/image acceptance. NPC
legacy credit charging is replaced, not co-charged, in enabled mode. Application cache
hits and confirmed pre-dispatch cancellations release reservations; replay cannot charge
twice. Unknown, unpriced cache usage, technical failure and overrun outcomes remain pending
for explicit reconciliation. Provider-dollar limits and kill switches remain independent.
The separately priced provider counting path has its own quote/reservation.

No wallet is funded or activated by this implementation, and no purchase fulfillment
exists. Missing wallets remain disabled. Failure-charge policy remains unresolved;
post-dispatch failure holds are not invented zero charges. Unsupported sponsor charging
fails closed in enabled mode. UI distinguishes actual wallet reserves/captures from
provider-cost equivalents and demo history, including receipts and exact small amounts.
The wallet endpoint is read-only and exposes the current owner's accounting only.

## Verification and limits

- Enabled-mode synthetic accounting: real PostgreSQL concurrent admission/replay, insufficient
  balance, exact micro-capture, cache/cancellation release, unknown retention, semantic
  finalization and image acceptance. NPC adapter/engine tests also cover cache evidence,
  stale commits and mode changes; no live funding or billing activation.
- Real isolated PostgreSQL: release CAS/replay/immutability, frozen NPC metadata, raw
  image ACLs, private-test exclusion, cross-story rejection and invitation revocation.
- Real synthetic HTTP/cookie journey: scoped create/replay/import/edit/export, builder
  preparation without dispatch, deterministic source-ID fixture assembly, private
  release/replay, personal library, hero selection, campaign start and API restart.
- Focused pure/provider/UI-source tests, API build, web type checking, ESLint,
  localization coverage and production web build passed at the checkpoint.
- Public homepage inspected in the provided cloud Chromium preview. Authenticated
  Studio browser checks remain unverified: shell Chromium failed at OS socket launch;
  cloud browser auth rules prohibit reusable-secret entry through model-visible tools.
  No denied path was accessed, and no authentication bypass was added.
- No real model quality, paid image/sprite generation or invoice behavior was tested.
  A synthetic playable fixture proves wiring and persistence, not AI output quality.
  Generated furniture artwork is not proven to align with collision geometry; temporary
  character visuals remain. Playable launch does not establish final art/geometry quality.

Relevant commands (fresh disposable data only):

```
npm run build -w @dreamwalk/contracts
npm run build -w @dreamwalk/game-core
npm run build -w @dreamwalk/api
npm run typecheck -w @dreamwalk/web
node --test tests/game/private-release.integration.test.cjs tests/game/story-local-npcs.test.cjs
node --test packages/contracts/test/sparks.test.cjs tests/game/sparks-accounting.test.cjs
STORY_AUTHORING_HTTP=1 node scripts/test-story-authoring.mjs
```

041 and 042 are new additive migrations; historical migrations, including gameplay
040, are unchanged. Account export includes new private authoring and Sparks records;
account erasure clears private release pointers and private authoring snapshots before
normal content tombstoning, retaining existing financial-record policy.

## Inherited bounded-test integration boundary

Current main already contains migration 043 and its bounded-provider-test receipts and
financial fences. This continuation must preserve that implementation unchanged in the
base, while composing Sparks hooks in these shared files:

- `apps/api/src/generation/service.ts`
- `apps/api/src/live-test/authoring-text.ts`
- `apps/api/src/image-generation/budget.ts`
- `apps/api/src/main.ts`

Do not deploy by replacing older baseline files over an installed bounded test. Preserve
its aggregate/purpose caps, retained liabilities, replay handling and global admission
and settlement fences. Combined tests must use migrations 001–043 and cover consistent
financial-scope/global-fence/wallet ordering as well as direct NPC provider-budget/wallet
ordering. Reconciliation is separate from normal settlement; source integration cannot
release unknown holds, raise independent limits or authorize new spending. Runtime rollout,
provider calls, wallet activation and payment fulfillment remain separately controlled.

Final independent read-only review identified and re-reviewed two corrected edge cases:
unsupported mixed requester/sponsor wallet modes now fail closed (19 focused engine/adapter
tests), and invited administrators receive only frozen private releases/NPC snapshots
(8 disposable-PostgreSQL release/access tests, including unpublished edits and revocation).
No remaining scoped blocker was identified. This does not establish authenticated-browser
coverage, live provider quality, or permission to merge/deploy/activate wallets.

Custom image-size constraints were checked against the official [Images API reference](https://developers.openai.com/api/reference/resources/images/methods/generate)
and [image generation guide](https://developers.openai.com/api/docs/guides/image-generation).
They describe supported request geometry, not a guarantee about output-token cost or
artwork/collision alignment.

The integrated financial order and operation-by-operation checklist are documented in
[sparks-lock-order.md](sparks-lock-order.md). Seven real opposing-transaction PostgreSQL
scenarios cover shared, direct/wrapped NPC, batch and operator-erasure boundaries; the
existing owner, accounting and data-request regressions also passed. These checks use
synthetic disposable data, not existing accounts or live balances.
