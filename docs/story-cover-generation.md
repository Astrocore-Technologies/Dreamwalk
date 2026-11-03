# AI story covers

The story editor's first step retains upload and media-library selection and adds
an AI cover dialog. Only the title and synopsis seed its editable description;
world rules, NPC notes and lore are not sent automatically. A cover is a private
`background` image with unrestricted camera and opaque background, not a map.

The existing image quote, Sparks reservation, confirmation, job, admission and
cancellation pipeline is reused. Estimation does not dispatch a provider request.
Each immutable quote has one explicit confirm/cancel decision. Closing the dialog
does not cancel a dispatched job or replace the selected cover. Results can be
recovered from authenticated job history after reopening or reloading, and selected
again without another charge. Selecting a result updates the normal story draft
cover field, using the same save/autosave and asset ACLs as uploads.

`storyCoverContext.draftId` identifies an authenticated actor's unsaved scope. It is
not an ownership claim. When `adventureId` is supplied, active story ownership is
rechecked at quote, enqueue, dispatch and admission. Contexts cannot be mixed,
author reuse must be disabled, and references obey the existing immutable rights
checks. Revision-to-upload selection verifies both family and upload ownership,
kind, archive and takedown status. Neither generation nor selection publishes a
story or makes the asset publicly reusable.

Verification uses mocked providers and isolated PostgreSQL only. Browser regression
source covers confirm/cancel, refresh recovery, selection retries, stale responses
after dismissal, preview and upload retention. No provider/configuration activation,
real paid calls or production mutation is part of this change.

## Character actions and pending images

The character's in-world appearance uses a compact generation view: **Estimate
cost** becomes **Generate** only for a current valid quote, alongside **Take from
library**. The displayed price and consent notice precede dispatch. Quote expiry,
project revisions, unavailable authorization and uncertain outcomes prevent reuse
of stale consent. Library selection uses owned compatible revisions and the
existing free, idempotent reuse endpoint without creating a paid quote first.
The full multi-stage workshop retains its separate controls.

Cover, hero, character and location surfaces show an accessible animation only
for queued, dispatched or generated-but-not-yet-admitted jobs. Unknown outcomes
remain a reconciliation message, never simulated progress or automatic retry.
The animation respects reduced-motion settings.
