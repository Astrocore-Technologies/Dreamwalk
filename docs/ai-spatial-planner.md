# AI spatial authoring

The external location workflow implements description → private model proposal →
server validation → explicit author Apply → walk/edit/approve → separate artwork jobs.
The existing Studio editor and clearly labelled free manual template remain available.

## What the model supplies

The compact schema allows exactly two connected rooms for this acceptance slice,
each 8–24 tiles wide and 8–20 tiles high, four safe cooperative spawns, at most eight
furniture elements, one unlocked door, one NPC and one recoverable quest item.
Room dimensions, extra walls, placements, names, public descriptions and the short
objective come from the proposal. Stable technical IDs are binding keys, not story
lore. No Rain room, Mira or journal narrative is silently substituted into AI output.
Future narrative scene creation keeps its independent existing director limits.

The request includes only the selected brief and whitelisted public world, opening
scene and location descriptions. Author authority is represented by a hash; private
rules, protected facts, NPC/hero notes and secrets are not sent as public scene prose.
The model cannot write executable rules or change the pinned Dreamwalk ruleset.
Server-side authority overlays retain the author's supported turn settings,
narrative constraints, supporting-NPC policy and round policy.

## Validation and authority

The server checks the exact room set, unique IDs, interior bounds, footprints,
nonoverlapping spawns/exits/door/NPC/item/furniture, adjacent door placement and
reachable connections. Every cooperative spawn and exit must remain connected with
NPC occupancy included; an NPC cannot occupy the sole usable choke point.
The NPC and item must be approachable. The normal game compiler validates the
resulting authored draft. Invalid or incomplete output fails; there is no success
fallback to the acceptance template.

A generated proposal is private and inert. It does not update the project plan,
adventure draft, published version or shared campaign. Apply is a separate author
action, with current source, revision and read-set checks. The engine preview is a
private free-walking sandbox; saved campaign turn rules remain pinned in the plan.

Applying a complete reusable package to another story preserves the destination
author's rules and rejects incompatible scene/role limits. The reusable geometry
cannot import the source author's private constraints into the destination.

## Manual request and durable accounting

The planner uses the same fixed, bounded direct Responses API profile and configured
combined manual session as NPC text. The conservative request reservation is
USD0.264036, output at most2048 tokens, request at most64,000 bytes, no tools and no
automatic retry. The session owner, immutable expiry, provider definition, source
hash, project revision and context hash are checked before dispatch and commit.
No model request occurs on project creation, quote, GET/poll, preview or Apply.

One explicit dispatch creates one durable job/attempt. Concurrent replay returns
that job without another reservation or provider call. A known paid result is
settled even when the source changes before admission. Cancellation or an unknown
provider outcome never invents zero cost; unknown/403 stops the session. A stored
validated result can resume local proposal admission after a crash, without calling
the provider again, subject to its saved completion and source/version fences.
No scheduler dispatches authoring jobs while idle.

Confirmed erasure removes private contexts/proposals while retaining financial
liabilities. Late completion may reconcile exact cost but cannot restore erased
content or provider metadata. Deletion preflights contendable campaign/job/financial
locks before file cleanup; busy work fails rather than waiting in an inverted order.
Erasing a participant does not erase another owner's unrelated private authoring.

## API

All routes are under /api/v1/visual-authoring and require the project owner:

- GET projects/:id/spatial-plan: quote/job state, validated inert proposal and safe
  engine projection; no paid request.
- POST projects/:id/spatial-plan/quote: operationId, expectedRevision, sessionId.
- POST projects/:id/spatial-plan/dispatch: operationId, expectedRevision, quoteId,
  consent:true.
- POST projects/:id/spatial-plan/apply: operationId, expectedRevision, proposalId,
  consent:true.
- POST projects/:id/spatial-plan/jobs/:jobId/cancel: operationId, expectedRevision.

Migration034 stores quote/job/proposal provenance and the server authority snapshot.
Manual template projects have a different explicit provenance.

## Verification boundary

The tests use synthetic fixtures and injected transport. The HTTP test runs the
actual controller, manual grant, fixed Responses request, parser, validator, proposal
and engine preview. Its test-only preload refuses all external HTTPS and supplies a
synthetic response; it does not load credentials. Geometry variants, duplicate
intent, stale canon, cancellation, unknown billing, private erasure, local recovery
and package/campaign reuse are covered by the relevant suites.

These checks establish implementation wiring and deterministic mechanics. They do
not establish actual model output quality or account access. Real image dispatch
remains separately blocked pending the cost consent; a text layout is not finished
painted art or a complete walking-character package.
