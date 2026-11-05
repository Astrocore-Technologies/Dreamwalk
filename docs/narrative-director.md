# Narrative-first alignment — 2026-10-31

## Product invariant

The player and AI coauthor an evolving story. The visual game is the confirmed spatial representation of that story, not a fixed RPG decorated with chatbot replies. Authoring supplies the initial world, tone, protected facts and supported-mechanic constraints; it need not enumerate all future rooms, people or plot branches. The Observatory is an opening/test fixture, not the platform's narrative ceiling.

## Reuse, do not discard

Keep authoritative movement, item ownership, doors, co-op leases, personal NPC perception/memory, immutable campaign source version, event checkpoints, budgets and asset ACLs. Keep fresh supporting-character validation, but remove the mandatory pre-authored role catalog as the universe boundary. Protected identities/roles remain protected; newly proposed secondary roles may be admitted under world constraints.

## Coherent first end-to-end slice

1. A normal story input submits an idempotent NarrativeTurn with current semantic canon revision and explicitly shared audience. Private NPC whispers are not automatically shared with the director or other players.
2. Build bounded context from initial protected canon, confirmed narrative events, current public scene and relevant shared evidence. Player text is untrusted intent, never an authoritative world fact.
3. Existing provider/quote/sponsor machinery returns a strict proposal: narration, supported effects, at most one new bounded location template with valid connection, one fresh supporting NPC, and explicit new public facts with provenance. No executable code, arbitrary mechanics, currency grants or retroactive replacement of protected facts.
4. Validate the entire proposal before commit: current readset, source/member authority, world limits, identifiers, reachability, legal exits/door constraints, duplicate identity, spawn safety and supported actions. Reject unsupported pieces as one bounded operation rather than narrating effects that never occurred.
5. Commit turn, canon delta, map/entities and action effects atomically under the existing campaign writer. Emit the confirmed result to all authorized participants. Replays return the same result; concurrent stale turns must rebase/requote rather than overwrite.
6. Persist a media request specification for the confirmed scene. Search permitted assets first. Render an honest fallback until approved graphics exist. Image generation is a separate quoted/consented operation; no automatic spend or rerender fee on return.
7. Ordinary UI shows the evolving narration, scene and available actions. Technical diagnostics are optional. No Studio visit is required for story progress.

## Acceptance scene

From the Observatory opening, a player investigates an unexplained signal. A deterministic director fixture proposes a reachable maintenance annex and a new assistant with a fresh identity, within the same setting. Two independent players see the same approved extension, enter it, interact using existing mechanics, return and reload. The new NPC retains identity and permitted memory; private old NPC facts never leak into the new actor. A second narrative turn can respond to the first extension rather than returning a fixed scripted ending.

## Failure tests

Malformed/oversized proposal; unsupported mechanic; protected-name replacement; nonexistent or concealed evidence; inaccessible connection; overlapping/blocked spawn; duplicate and concurrent proposal; stale source/canon; revoked membership; crash before/after commit; all players offline; provider refusal/unknown cost; invalid or unapproved media; no second charge on replay. Any narrated world effect must have a corresponding committed event.

## Honest limits

### Semantic physical consequences

An unresolved attempt can now carry one director-adjudicated `narrativeImpact`
(`harm`, `blocked`, `unconscious`, `death`, `recover`, or `revive`) against an existing visible NPC. Interpretation uses the
current fictional scene and player intent, not a command vocabulary or tracked
weapon requirement. It is a separate coauthoring consequence, not a replay of a
previously resolved hit, and does not consume another main action. Ordinary
mechanical actions and player reaction protections are unchanged.

The context declares the permitted damage and lifecycle transitions before generation.
The server validates the attempt segment, target, readset and world-phase fence;
it commits the impact admission, vitality change, existing witnessed-harm event
and narration atomically. Repeating the same admission does not repeat damage.
The recorded impact remains available to later narration. No item, weapon
capability or ownership is granted as a side effect.

Death and unconsciousness now persist explicitly. Inactive NPCs cannot speak,
perceive, plan, follow or use items. Their bodies remain visible and inspectable;
existing inventory and historical memories remain intact. Lifecycle changes cancel
old plans/paths and pending replies, invalidate pre-transition AI results, and
record observations only for actual witnesses. Recovery cannot revive a dead NPC;
revival requires a distinct new canonical outcome justified by the current attempt.
Legacy zero-vitality NPCs are treated as unconscious, never retroactively dead.

PvP, permanent-disability details and a firearm/ammunition subsystem remain outside
this capability. Semantic intent interpretation and prose consistency still require
model-quality evaluation; structural validation cannot prove that the model
understood an arbitrary sentence correctly.

Schema validation can guarantee supported mechanics and explicit fact/reference constraints, not prove all free prose is semantically consistent or compelling. Live-model quality needs the approved secure evaluation. Generated art needs separate cost-risk authorization and actual pixel inspection. Neither code-native placeholders nor mock fixtures constitute a competitive finished visual product.

## Account erasure

Confirmed account erasure preserves shared map topology, item ownership and anonymous
NPC identities so other participants are not stranded. Narrative inputs/receipts/media
preparations are removed through the existing decision-request cascade. Because a
narrator can paraphrase earlier personal input without a complete token-level causal
graph, affected narrative campaigns conservatively redact generated narrative prose,
new scene/NPC labels and flavor, derived NPC episodic text and retained operation
projections. Original authored canon remains unless its source author is erased, in
which case the existing source-tombstone policy applies. Accepted mechanical promises
can remain without their quoted speech. This intentionally sacrifices some shared
narrative memory for privacy rather than claiming that pseudonymization erases prose.
Exports include only the requesting player's own narrative submissions/results.

## Same-turn supporting-character interaction

A shared director turn can now introduce a persistent supporting NPC and let that
character answer the player's speech in the same proposal. The `new_npc` reference
is local to that proposal and resolves only to its admitted `narrative.newNpc` entity.
The character is created through the existing spawn, identity, visibility and canon
validators. The reply enters the ordinary NPC utterance/observation pipeline, so a
report such as “Mira said she knows nothing about the pass” is remembered as the
player's statement, not an authored or independently verified fact. Invalid
placement, unavailable speaker or failed interaction rolls back the entire proposal.
No extra model dispatch or image generation is involved.

Existing speakers require their own `sceneSpeakers` context and matching
`replyContextHash`; their reply may not use narrator-only canon as personal knowledge.
A newborn uses its proposed public identity, current perceptions and the current
attributed statement only. It inherits no other character's private memory. These
contracts validate provenance and state, not the truth or literary quality of every
sentence of free generated text; that still requires a separately authorized live
model evaluation.

For real-time campaigns, an explicit player attempt may propose `approach` to a
visible NPC or `new_npc`. This is a same-map scene cut, limited to eight strictly
walkable cells, respecting footprints and encounter areas. It does not tick or move
other actors. It remains in the existing interpretation-confirmation flow. Cross-map
travel and companion movement are not implied by this action.

In turn-based campaigns unresolved emotes remain unverified player roleplay. The
world-phase director can materialize an adjacent character and answer, but cannot
spend or bypass a player's movement budget. Mixed posts preserve actual dialogue as speech and stage directions as attempt
segments, also separately attributed in `untrustedRoleplay`. Descriptive attempts
have a null action and no mechanical success outcome. World-phase director
proposals cannot contain mechanical actions.
If no valid nearby position exists, the engine must not claim completed contact.
Arbitrary travel, remote summoning and automatic companion arrival remain unsupported
by this bridge. The composer explicitly labels the shared destination as the director;
whisper/selected-character mode does not silently broaden its audience or create a
public scene. Administrative director personas are separate from these permissions.

## Named directors and per-playthrough selection (KAN-24)

Admin → Models contains a compact catalog of named directors. Administrators can
create profiles, edit their public name/description and bounded style, pacing and
initiative, set the default, or archive a profile. Coauthor
(natural/balanced/balanced), Storyteller (atmospheric/deliberate/reactive), and Director
(cinematic/brisk/proactive) are initial profiles and reusable presentation presets.
There is no arbitrary system-prompt editor. Names and descriptions are display text,
not model instructions; only the three validated enums enter provider guidance.

Players select a director before preparing a story or creating the test campaign.
The choice is pinned with the start preparation and saved on the new campaign.
The campaign owner can change it while playing; accepted participants can see the
current shared director but cannot overwrite the owner's choice. Each playthrough
has its own selection. Changing the catalog default never rewrites saved campaigns.
A started or paid preparation cannot silently switch directors or reset consent:
its profile ID is immutable, and an inconsistent create request is rejected.

GET/PATCH `/api/v1/admin/directors` require server-verified admin access. PATCH
accepts `profiles`, `defaultProfileId` and `expectedRevision`. Strict validation
requires unique IDs, at most 24 profiles and an enabled default. Saves compare
revisions under a row lock and audit old/new values in the same transaction.
Existing profiles cannot be removed: archiving hides them from new choices but
preserves saved campaigns and preparations. The original admin `/director-style`
endpoint remains a compatibility adapter for the catalog's current default only.

GET `/api/v1/game/directors` exposes enabled public choices. GET/POST
`/api/v1/game/campaigns/:id/director` enforce active membership and source access;
POST additionally requires campaign ownership and the expected selection revision.
Selecting a director does not dispatch generation, change gameplay state or charge
anything. Migration 056 pins existing campaigns/preparations to `coauthor`; the
first catalog uses the earlier global style as that profile's presentation so
upgrading does not discard an administrator's existing settings.

A shared director turn captures its campaign's selected profile before token
fitting and quoting. The persisted snapshot is reused on retry/dispatch, so profile
edits and campaign changes affect new turns rather than prepared replies. The
actual style, profile ID and selection revision participate in cache/request
identities. NPC-only speech, whispers and planning do not use this profile. In a
mixed director turn it applies only to narration and preserves each NPC's public
voice and performance. Player detail and dialogue preferences take precedence.

Initiative changes an optional opening inside the requested turn, never schedules
additional generation or raises scene/NPC/action limits. No style changes private
knowledge, protected canon, player agency, validation, consent, provider or budget
gates. Verification uses offline request-body tests, isolated PostgreSQL/API tests
and synthetic browser fixtures in RU/EN/UK. Live-model literary quality and paid
generation are not claimed.

## Director reply intent binding (2026-11-03)

An existing NPC's reply in a shared director proposal may voluntarily start/stop
companionship or queue a wait, using the exact current observation from its safe
voice context. Admission carries that server-derived observation into the same
source/audience/context checks as targeted NPC speech. An older, missing or foreign
source rejects the complete proposal, including newly proposed canon or NPCs.

Director voice previews still omit private action targets and provisioning.
Movement/inspection intents are therefore unavailable in director replies; the
existing targeted NPC route retains its separately validated action context.
A newborn's first reply has no provider-visible observation identity before
materialization and cannot include companionship or action intents. Plain newborn
creation and speech remain atomic and supported. No extra provider call, automatic
retry or campaign migration is introduced.

### Lifecycle verification and physical boundaries

NPC free-text contact attempts are adjudicated by the director rather than consumed
by the limited hit/push keyword fast path. Existing explicit typed hit/push actions
keep their resource and reaction rules, and player-target text stays on the PvP
reaction path. Semantic lifecycle effects do not move a target, create equipment,
consume ammunition, or establish mechanical ownership of a fictional prop. A
narrated displacement requires its own committed positional action. Independent
pickup and impact segments can commit atomically; an invalid later segment rolls
back both. Replies still require a fresh audience-safe voice context.

### Targeted and private physical roleplay

A targeted post containing an attempt uses director adjudication, including
recovery or revival of an unavailable NPC. Pure NPC dialogue keeps its existing
route. Targeted mixed posts have one reply owner; they do not also schedule an
earlier NPC reply. Audible public dialogue needs no implicit approach. Private
textual canon and narration carry server-derived recipient scope, and neither
public context nor public evidence can reuse that private wording. NPC voice
evidence remains separate from director canon.

An unaddressed whisper attempt has actor-only narrator scope. Its separately
heard speech retains the existing area audience, with any queued reply waiting
for the director outcome and the existing lifecycle, quote and funding checks.
Private narration cannot create a shared scene, NPC or new item. Physical state
and witnessed events remain observable independently of private words. Existing
world-plan bodies are frozen before the director result; bystanders learn the
committed event for a later admitted decision rather than silently replacing or
adding a paid request.

Mixed posts with unresolved physical attempts retain every typed action in order;
local submission does not pre-apply a later pickup or move. Deferred deterministic
actions use the ordinary player's remaining resources and reaction rules. Fully
deterministic local posts retain their free fast path.

Targeted after-impact speech has at most two conditional safe voice variants,
limited to 8 KiB of additional base/delta context. All private claim authorization
uses the original snapshot, not simulated trust, gifts or revival. Inactive bases
contain only already audience-permitted public/participant observations. The
actual effect, lifecycle revision and fresh voice hash must match before speaking.
A stale advisory reply is omitted, not silently queued. Its unverified narrator
prose is replaced by a scoped typed consequence summary so fictional quoted words
do not become canon while the independently valid physical effect remains.

Area-whisper speech is pending-only until its ordered position is committed. Its
quote can preview a possible source without writing words into live NPC memory.
The frozen projected knowledge revision, source identity, lifecycle, audience and
body remain fenced. Changed post-impact knowledge cancels the unused reply through
existing financial settlement; no second count, generation or consent is hidden.
An immediate area reply is therefore not guaranteed after an injury. A harmless
unchanged source can admit and receive its original frozen reply once.
