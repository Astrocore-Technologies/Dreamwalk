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
