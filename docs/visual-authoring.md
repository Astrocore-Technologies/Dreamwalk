# Visual authoring and reusable packages

The workshop at `/studio/visuals` implements a fixture acceptance pipeline and a separately gated external pipeline. It is
available to both players and authors; a saved adventure opens the location workflow
from Studio → Locations. It does not replace the manual Studio editor.

## What actually runs

Fixture mode uses **original code-drawn fixture art**, rasterized on this machine.
It makes no AI request and costs zero. The current ranger and alchemist atelier are
fixed acceptance examples, not an AI interpretation of arbitrary text or photographs.
The UI says this before creation. External mode creates an incomplete project without
fixture fallback. Live photographic likeness and painted-art quality remain unverified.

A character brief accepts text or an owned sanitized raster photo, plus outfit,
appearance and drawn-2D style. Photo use requires separate explicit source permission.
Output reuse is a separate opt-in enabling later explicit grants; nobody receives a
grant automatically. The source photo is never a portrait, output asset, campaign pin,
public package field or shared library item by implication. Fixture mode does not send it
anywhere. Source ownership/availability is checked again at approval and assembly.

The full-body concept must be approved before assembling the portrait and transparent
sprite sheet. The sheet has four directions, two idle poses and four walk poses per
direction (24 frames). A portrait alone is never a ready walking package. Hero/NPC
creation plus equipment is one idempotent transaction; existing characters can select
an owned complete package. NPC source personalities and public appearance reach the
compiled runtime through separate private/public projections; secrets stay excluded.

## Locations and the engine

The bounded fixture supplies a 16×12 atelier and reachable 8×7 annex, entrances/spawns,
a glass door, NPC, worktable/counter/shelves/plant/rug and a recoverable journal. A short
objective resolves from the existing authoritative item mechanics; the narrative may
continue afterwards. This is an acceptance scene, not a ceiling on the evolving story.

The spatial plan precedes artwork. Solid layer footprints must also be blocked cells;
compilation checks bounds, overlap, spawns, door/key conditions and reachable exits.
The author can reposition or replace an element before approving the plan. Background,
furniture and interactive door variants are separate raster revisions. Shared depth
sorting places actors in front of or behind solid scenery. No pixel determines collision
or authorizes an action.

The actual `GameCanvas` previews a server-owned sandbox using the same pure rules.
Walking/opening a door/transitions/items affect only that sandbox. Server-confirmed
movement frames animate on the client. Saving a package does not mutate shared canon.
Applying it requires an explicit playable-draft replacement confirmation and current
source fingerprint. Concurrent/stale source changes reject the mutation. Replaying the
same operation returns the same result. Unchanged saved packages can be selected again
without generation or billing.

## AI spatial planning

The model supplies room dimensions, furniture/door/NPC/item positions and public
scene/objective descriptions. Server checks bounds, collisions, cooperative spawns
and reachability with NPC occupancy. Whitelisted public story context grounds the
request; private author authority remains server-side. The proposal cannot change
shared canon. Applying it requires explicit author action and fresh source/revision
fences. Free sandbox walking does not spend the saved campaign's movement budget.
Complete package reuse preserves the destination author's rules and rejects scene/role
conflicts. See [ai-spatial-planner.md](ai-spatial-planner.md) for the finite schema,
manual intent, durability, privacy and verification boundaries.

## Persistence and rights

Migration030 separates private projects, operation receipts and immutable package
versions. Package checksums cover canonical manifest/plan JSON. Every admitted part is
an immutable existing-library raster revision with SHA-256 and explicit rights metadata.
The existing upload/metadata quotas and bounded rate limits apply. Failed fixture
transactions clean only their newly assigned UUID files.

Adventure versions and per-member heroes pin exact revisions and rights through the
existing library mechanisms. Existing campaigns do not silently upgrade. Takedown masks
future delivery and active rendering, including previously pinned graphics; ordinary
future-use grant revocation retains the existing pin contract. Reuse is free. Library
search marks type/camera compatibility separately from unverified semantic suitability.

Project lists and unfinished states are owner-only. Cancelling prevents later approval;
failed assembly leaves an explicit incomplete project. Confirmed erasure removes private
briefs/receipts/packages before existing raster erasure; own export includes these records.
No source photo or private NPC/hero notes become shared narration or media prompts.

## Provider boundary

The existing image engine owns search, quote, explicit consent, durable reservation,
unknown-charge retention and raster admission. Production uses a server-configured
provider factory; capability responses expose effective mode, model, request options,
pricing evidence and blockers without credentials. Each external workshop role is
quoted and dispatched individually. Completed jobs are normalized/validated before
package assembly, with separate human visual review. No automatic paid retry or
regeneration occurs. A cancelled/stale project cannot admit a late part. Source photo
permission is separate from output reuse and is revalidated at dispatch/admission.

Migrations031 and034 store private generation stages and durable AI spatial proposals.
New external locations default to the [AI spatial planner](ai-spatial-planner.md):
explicit quote/dispatch, strict layout validation, inert preview and separate author
Apply. A clearly labelled manual template remains available as an explicit choice.
There is no automatic template fallback after an invalid model response. Character concept, portrait and sheet, or all location roles, must be complete;
a single image does not become a finished playable package. Structural alpha/frame
validation does not prove artistic consistency.

The manual provider mode has a configured combined cap and per-request consent. Its text
request boundary, expiry, shared ledger and secure loader are described in
[manual-live-test.md](manual-live-test.md). Image dispatch remains disabled until its
full request cost bound is defensible under the approved scope. Official calculator
estimates are presented as estimates. Unknown-cost or denied-provider liabilities are not retried or cleared.
Automated checks use fixture/injected providers and do not establish live-model quality.

## Verification

`npm run local -- npm run test:visuals:integration` owns a fresh PostgreSQL cluster and
raster directory. Browser scenarios are in `tests/e2e/visual-authoring.spec.ts` and
`tests/e2e/game-turns.spec.ts`. Test source is not a claimed browser pass; actual results
and captures are recorded in `docs/progress.md` at handoff.
