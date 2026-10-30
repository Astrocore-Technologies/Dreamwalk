# Reusable drawn assets

## Product and rights boundaries

An upload is an owner-controlled sanitized raster blob. A library family has immutable
numbered revisions. Metadata edits produce another revision while retaining the same
blob when appropriate. Metadata records drawn 2D style, camera, dimensions, tags, variant,
provenance and the author's attestation of rights. This attestation is not independent
legal verification. Pixel-art styles are not accepted. Uploads remain static raster images; a `sprite`
revision is a reusable visual image, not a claim of an implemented directional animation
pack or video-generation pipeline.

The owner may reuse their own revisions across stories. A public story grants display
through that story, not discovery in another author's library and not reuse rights.
Cross-author reuse requires an explicit grant to an account/handle, with confirmation
that existing version pins remain displayable after future-use revocation. This is a
product permission, not a claim of an irrevocable legal licence. Takedown or confirmed
erasure masks displays, including already pinned versions. Reuse is not a marketplace.

Private original upload URLs and upload IDs are not included in library revision DTOs.
The legacy upload route independently checks owner, approved public cover/portrait/avatar,
accepted private invitation, or exact moderator access. Its public display permission
never implies library discovery or reuse permission. Both legacy and library delivery
now consult withdrawn blobs; a withdrawn shared upload cannot be re-registered as a new
revision to bypass that restriction.

## Immutable publication

Story art bindings have their own optimistic revision, independent of map revisions.
The author saves only slot/revision selections; the server resolves actual authorized
immutable metadata. It validates slots against the saved playable package and checks
kind/style/camera compatibility:

- `map:<id>:background`;
- `entity:<npc-id>:sprite|portrait`;
- `entity:<item-or-door-id>:object:<default|open|closed>`.

Top-down gameplay accepts top-down/unrestricted images; portraits accept
portrait/unrestricted images. Isometric content is not silently treated as a top-down
scene. The library can retain metadata for other future scene formats, but incompatible
bindings fail validation.

`prepareManifestTx` resolves one locked snapshot before the compiled package checksum and
previous-version lookup. Exact canonical slot/revision/hash/mime/size descriptors become
part of that package. `pinPrepared` checks the package checksum and stores those same
resolved rows, including immutable rights snapshots, in the same transaction. An art-only
edit therefore creates a different playable version. Old campaigns retain their frozen
images and independent game states. Normal duplicate publication reuses an identical
version instead of generating/charging again. `expectedArtRevision` optionally binds a
playtest request to the editor's just-saved art revision.

Full manifests, including descriptive metadata, are available only to the source author
or moderator reviewing the exact pending version. Players receive only current-map and
visible-entity bindings, plus their own inventory where applicable. Hidden entities,
other maps, unselected door variants, private provenance and titles are not included.
The campaign file route recomputes current authoritative visibility and exact pin
membership; knowing an ID or belonging to the campaign does not reveal hidden artwork.

## Rendering and withdrawal

`GET /api/v1/asset-library/campaigns/:id/manifest` returns minimal visible bindings with
same-origin authorized URLs and public attribution/license labels from pinned rights.
It requests a five-second refresh. Runtime snapshots also omit withdrawn revisions;
active campaigns check availability at most once per second without mutating game state.
The renderer removes absent textures on authoritative updates. All bytes are SHA-256
verified before library delivery, with private/no-store and nosniff headers.

These controls block future delivery and remove artwork from the cooperative UI. They
cannot recall bytes already downloaded by a client. An ordinary reuse-grant revocation
does not remove an explicitly retained pin; takedown is the separate withdrawal operation.

## Search before generation

`POST /api/v1/asset-library/resolve` accepts kind, drawn style, camera, tags, minimum size
and optional variant. A specific camera request accepts that camera or universal
(`unrestricted`) artwork; an unrestricted request applies no camera filter. It returns
an authorized compatible existing revision, or a typed
`generation_proposal` requiring separate explicit approval. Catalog results are the newest 200 revisions and search returns at most 50 matches,
not an exhaustive listing. Responses include `X-Result-Limit` and
`X-Results-May-Be-Truncated`; the UI prompts refinement when the limit is reached.
Authorized direct revision lookup and already pinned images remain available outside
this listing window. No provider is invoked,
no new image is stored, no price is invented and no wallet is charged. Reuse is free.

## Persistence and operational bounds

Migration 021 adds immutable families/revisions/manifests/pins, explicit grants, drafts,
idempotent operation receipts and takedowns. Mutations serialize per owner, enforce
60 new operations/minute, and cap metadata revisions at 2,000 per owner, independently of
the existing upload quota (200 raster images/100 MiB). Replays return the original result.
Publication holds relevant grant/blob locks; revocation cannot retroactively authorize a
new pin. SQL triggers reject revision and manifest rewrites except confirmed erasure.

The account export includes reusable-art metadata. Confirmed erasure tombstones owned
revisions, removes private metadata and pinned attribution, revokes related grants,
scrubs retained operation receipts and permits physical upload deletion. Unrelated game
progress and financial ledgers remain governed by their existing policies.

## Verification

Run `npm run test:assets:integration` (`node tests/assets/run.mjs`). The runner starts a
unique disposable PostgreSQL cluster and upload directory and forces mock/no-external
configuration. It never uses managed preview data.

Initial isolated service/SQL checkpoint: 9 scenarios / 10 Node tests passed, covering
registration/CAS/immutability, private search/legacy rejection, zero-cost resolution,
shared blobs with independent campaigns, explicit grants, retained pins, takedown and
erasure. Scoped backend ESLint and API typecheck passed after integration. The expanded
actual HTTP and renderer/browser acceptance is tracked separately; do not infer browser
or visual correctness from service tests. No live generation, payment, deployment or
legal-rights verification is claimed.

### Integrated HTTP checkpoint — 2026-10-30

The final combined asset suite passed **21/21 Node tests** (19 scenarios plus their
2 parent tests) against disposable PostgreSQL and an actual API process. It includes
real sanitized raster upload/download and matching bytes across independent campaigns;
art-only immutable version creation; hidden-map/entity and alternate-version-context
access denial; explicit grants and retained pins; pending-review invalidation; publication
versus art-CAS concurrency; withdrawn-art approval rejection; live WebSocket and cached
idempotent-replay withdrawal; legacy public-cover denial; and deterministic publication/
moderation versus confirmed-erasure lock barriers. No test assertion was relaxed to
accept deadlocks: the discovered user/story lock inversion was corrected and retained
as a regression case.

Mutations now serialize quotas with an owner advisory lock and acquire the active author's
shared user lock before story locks. Private compilation, public submission and moderation
use the same author-before-story order. Foreign asset owners are locked before their
revision/family rows. This ensures account deletion cannot slip between authorization
and publication and then miss newly committed pins during erasure. Active image delivery
uses the current live authoritative state when available, not a lagging movement checkpoint.

The full NPC/game regression and browser/visual acceptance run separately after this
checkpoint. Their status must be reported from actual final results, not inferred here.

The final recipient-erasure hardening also takes an active shared recipient lock before
creating a cross-author grant; a deleted recipient returns the same private 404 rather
than signing out the valid grantor. Confirmed erasure redacts grant receipts that name
that recipient, clears the erased author's mutable binding drafts, and replaces their
own immutable slot strings with deterministic SHA-256 tombstones. The trigger permits
this only with confirmed-erasure context and a deleted source author; normal pin edits
remain prohibited. Unrelated authors' slot strings and rights are not erased. This final
privacy bundle requires the affected asset/operator regression in addition to the earlier
21-test checkpoint.

Final affected asset regression: **23/23 Node tests passed** (6.24s), including the
recipient-erasure bundle and compatible unrestricted-camera reuse. The assets-integrated
full gameplay regression previously passed **115/115**; the later changes were confined
to asset recipient locking/redaction and camera selection, not NPC/game rules. Exact final
CI must still run the whole integrated source, including browser acceptance.
