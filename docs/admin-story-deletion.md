# Administrative story removal

Administrators can delete a story from its existing authorized Content row. This is
recoverable removal, not physical erasure. It is separate from moderation quarantine.
The confirmation names the story and explains that catalog/Studio access, gameplay
and invitations close while immutable versions, saves, shared assets and accounting
remain stored. No real stories were removed during implementation.

The Deleted stories tab returns only an ID, title, deletion ID and timestamp. Admin
role alone does not grant access to foreign private drafts. Public removed releases
are visible to administrators; private removed stories are limited to the deleting
administrator and the author, who must also be an administrator to use this panel.
The retained title for a private recipient comes from its released snapshot, never
from later private draft edits.

Restoration creates an author draft. It clears public/private publication pointers
and the pending review pointer, and never reaccepts invitations or reinstates paid
generation consent or sponsorship. It does not restore a previous database snapshot.
Existing owner-private playtests can become accessible to the owner again; public
and invited play requires normal publication/access checks. Cancelled generation
jobs are not restarted. Shared art and independent character templates are retained.

Server protections include role checks, original visibility checks, an unchanged
state token, author-then-story locks, durable deletion operation identity, immutable
audit, a restore deletion-ID fence and a database tombstone/status invariant.
Owner read/save/duplicate/submit, playable draft and source access cannot resurrect
a removed story. Deleted authors cannot be restored. Existing archive/revocation
triggers fence queued jobs without inventing liability settlement or refunds.

Verification uses one fresh PostgreSQL fixture suite and intercepted browser tests
for RU/UK/EN, cancellation/focus, pending dismissal, repeat identity and restoration.
Local/CI outcomes are recorded in the PR; source existence alone is not a pass.

Local verification on 2026-11-05: contracts/core/API build, web TypeScript, focused
ESLint and formatting passed; 13 UI/locale checks and all seven PostgreSQL tests
passed. Four browser scenarios were discovered, but not executed locally. Full
exact-head CI and browser execution remain release gates.
