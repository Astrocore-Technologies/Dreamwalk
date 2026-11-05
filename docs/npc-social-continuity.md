# Conversational relationship continuity

The existing NPC decision request can now propose a small subjective reaction to an
exact identified utterance in its admitted memory. Affinity, respect and fear can move
by at most one point per actor per decision and simulation tick/round, remaining within
the existing bounds. This works for legacy characters as well as explicit profiles.
The model interprets the exchange through the character, rather than a keyword or
sentiment classifier deciding that every compliment deserves a reward.

A depth-zero `said` observation means that this NPC actually heard an identified speaker.
Its existing `reported` confidence correctly leaves the content unverified. Secondhand
retellings, unknown speakers, self-quotes, unprovided evidence and action claims are not
eligible. Hearing an apology can alter feelings, but cannot verify a rescue, fulfill a
promise, create items, clear debt, increase mechanically earned trust or authorize lore.

The reaction is admitted atomically with the existing plan and knowledge/round/actor
fences. Invalid actions do not smuggle relationship updates through the blocked-plan
fallback. Physical-event deduplication remains independent. Empty/zero reactions are
no-ops. Older evidence, repeated evidence, a second same-round appraisal and recent
case/punctuation-normalized repeated text do not award another step. The bounded text
fingerprint window is not semantic paraphrase detection; the provider is instructed to
leave repeated flattery and routine chatter unchanged.

Relationship evidence is retained with private memory and its social significance enters
existing retrieval. The latest conversational beat is kept ahead of old relationship
memories. Both context packers identify the newest record by its supplied chronological
metadata instead of mistaking the last relevance-ranked item for the latest question.
Public speech receives only a categorical conversation tone when every listener is
allowed by its cumulative source audience. Speech-only axes keep that cue separate
from mixed physical/social state. Raw scores, fingerprints and private reasons remain
private; combined character axes cannot change the public stance through the old hostile-stage
shortcut, even before the first social appraisal. Existing earned-trust rules remain. A cumulative whisper audience survives evidence-window trimming and restricts
future fictional thought reading. Account erasure removes the speaker's derived relation.

No extra provider request, summary pass, paid evaluation or data migration is added.
Existing saves acquire this optional state on future admitted decisions, not by rewriting
past events. Tests cover core admission, injected provider output, packing, privacy and
erasure. Natural dialogue quality and actual long-running provider behavior still need
separately authorized live acceptance; test fixtures do not establish literary quality.
