# First complete small adventure

`createCompleteObservatoryDraft()` is a separate authored template. It does not replace `observatory-v1`, the generic observatory editor template, or any existing campaign.

The journal is on the roof. Players can find the brass key and open the main door, or speak with the keeper, explicitly accept the offered pass, receive the token, and use the side door. Both transitions are server-gated by the corresponding open/unlocked door. The journal is an actual uniquely owned item, not an illustration or a line of dialogue.

The `recover-journal` objective is a bounded authored condition over game state. Definitions are frozen in the playable package. The server evaluates them using currently accepted, active, source-authorized party members inside the normal campaign writer transaction. Achievement, checkpoint, event history and command replay result commit together. Movement-only conditions are evaluated at the existing durable checkpoint cadence. Offline simulation does not advance them.

The public projection contains objective text, status and achievement tick; the epilogue appears only after achievement. It does not disclose internal condition entity/map references. Moderators reviewing the exact submitted immutable version see the actual authored conditions. Completion grants no currency, creates no items, and does not freeze exploration or reset the world.

## Reachable bundled launch

The ordinary seed installs the complete template into the bundled `old-observatory` story only when it is still an unchanged first-party fixture owned by the disabled editorial account, has unedited original NPC definitions, and has no authored game draft or existing playable version. The seed creates an immutable package, editorial version and approval atomically, then binds the public snapshot. It records an audit marker. Repeated seeding does not add another version. Edited content is skipped rather than overwritten.

This is a first-party demo seed, not automatic moderation of user stories. User-authored versions still follow private playtest or explicit public submission/review. Hero selection and campaign creation use the normal routes. Existing saves remain pinned to their previous version.

## Art and limits

The bundled observatory scene profiles are code-native drawn presentation, with interactive geometry and entities rendered independently. They are not paid-generated imagery. The scene does not regenerate on return. Portraits, NPC responses, item ownership, door state and objective outcome remain distinct server contracts.

Two lawful paths are covered by core tests. Real PostgreSQL/co-op and browser execution results are recorded separately in `docs/progress.md`; authored test source alone is not execution evidence. This small adventure is not a general quest graph, combat system, death/rollback system, or an unrestricted AI-generated mechanics engine.
