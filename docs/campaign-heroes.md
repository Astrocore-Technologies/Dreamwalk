# Campaign heroes and delayed NPC decisions

## Hero selection

A saved hero is an owned preparation template, not the mutable game actor. Creation,
Studio playtest and invitation acceptance may specify an owned `heroId`. The server
pins the validated template into a separate immutable per-member row. Choosing the
legacy traveler also locks that choice; old saves remain usable without a hero row.
Later template edits or template deletion do not rewrite an existing campaign.
Reinvitation restores the original choice rather than silently replacing it.

Only the selecting player can read the full campaign snapshot. Other players receive
the actor's public name and may fetch its portrait only while authorized for the
campaign and able to see that actor. This does not make the source upload public.
Backstory, notes and traits are not automatically disclosed to the group or NPCs.
Portraits are presentation resources, not directional sprites or invented statistics.

Confirmed account erasure deletes the personal selection and removes public hero
identity from retained game projections/history. Ordinary template deletion is not an
account-erasure request. Owner export includes only that owner's selected snapshots.

## Delayed decisions

The NPC decision context excludes only `affect.lastUpdatedTick`: it is the scheduler's
bookkeeping timestamp, not a meaningful change when all affect values remain equal.
Mood, attention, fatigue, alertness, knowledge, object revisions, positions and hearing
audience remain dependencies. A genuinely changed context still rejects delayed work.
The planner receives the current public audience and explicit disclosure restrictions;
these are guidance only. Server audience/evidence validation remains authoritative,
including rejection of a public retelling of private whispered evidence.

## Verification status

Focused local checks are recorded in `docs/progress.md`. Actual browser verification
requires the new exact-head CI. No paid calls, user-computer restart or deployment is
part of this repair. The separate live evaluation revealed the stale-timestamp defect;
these regressions use synthetic data and injected providers, not a live model.
