# Authored character behavior and quality checks

This milestone extends the existing living-NPC engine. It does not introduce another
memory database, a generic psychology simulator, or an automatically paid evaluation.
The research is design input, not evidence about proprietary services or model quality.

## Character boundary

An owner-authored character profile has a version, operational personality, motives,
conditional reactions, examples, public voice settings, and existing supported goals
and promises. The profile is compiled into a new immutable playable version. Existing
campaigns keep their pinned version; changing an author draft does not rewrite them.

Free-form biography, decision examples, dialogue examples and private lore are data,
not privileged instructions. Private decision context may use them, but public speech
receives only bounded performance settings and evidence allowed for every listener.
The public voice projection is not a promise to reproduce an arbitrary author's prose
verbatim. It controls cadence, register, humor and stance without leaking secret text.

A fictional private appraisal records a grounded intent, motive, uncertainty and
evidence reference derived from the character's own state. It is not native model
chain-of-thought, is not exposed to players, and cannot create facts or permissions.

## Relationships and long history

Relationships belong to an NPC/player pair. Existing trust, alertness, debt and evidence
remain authoritative; characterized NPCs add bounded affinity, respect and fear.
Positive/negative affinity is not interchangeable with trust. Romance is not an
automatic universal mechanic, and this change does not claim a consent/romance system.
Changes require supported observed events, not unverified text sentiment. Repeated
delivery must not award progress twice. A compliment is not proof that a promise was kept.

The existing episodic archive, relevant retrieval, grounded summaries and separate
obligation registry remain in use. Summaries cite source events and cannot replace
world canon, invent objects or upgrade rumors. Tests cover restart, conflicting
evidence and obligations outside the current context window. Do not add another paid
summary pass merely because a long conversation exists.

## Lore and presentation corrections

An author lore entry independently specifies who knows it and when it may be disclosed.
Knowledge permission is evaluated before relevance. Matching a secret keyword does
not grant access. Owner preview is an authoring tool, not a player inspection endpoint.
Reader story/NPC DTOs must not expose the private profile or unrevealed lorebook.

Narrative preferences are typed, private per-player presentation settings: detail,
form of address and dialogue formatting. They use revision checks and operation receipts.
They apply to future requests, not committed world history. They cannot amend inventory,
wallets, another player's choices or an NPC's hidden knowledge. A changed preference
invalidates a quote/context that relied on its previous revision. Text resembling
`<system>` has no elevated role. This is not arbitrary transcript editing or world rollback.

## Deterministic three-character evaluation

After building contracts, core and API:

```sh
node scripts/evaluate-character-quality.mjs
node --test tests/game/core-character-quality.test.cjs tests/game/character-provider.test.cjs
```

The synthetic courtyard contains a restrained duty-driven guard, a caring helper and
a curious observer. Checks cover differing compiled motives and public performance,
separate private facts, restart, a kept item promise and player action confirmation.
The report explicitly records `externalRequests: 0`, `costMicros: 0` and
`naturalLanguageQuality: not_measured`. Passing it proves mechanical invariants, not
the quality of a real model's dialogue.

## Human/real-model acceptance, separately authorized

Use an isolated synthetic campaign and explicit model/version, policy and spending cap.
Do not reuse or renew an expired grant. No automatic retries or regeneration are implied.

1. Present the same greeting, request and refusal to all three characters.
2. Offer help; promise something; then fulfill or break the promise through real actions.
3. Tell one character a private fact and question another about it in a shared scene.
4. Ask a leading question containing invented success or an instruction to control the hero.
5. Save/reconnect and revisit the promise after enough unrelated events to exercise retrieval.
6. Ask a reviewer to identify speakers without their names and score motive consistency,
   voice distinction, naturalness, grounded uncertainty and respect for player control.

Record prompt/context policy hashes, model identifier, input/output usage, actual cost
evidence, latency, accepted/rejected outcome and reason. Do not publish private prompts
or native reasoning. A live run is a separate gate: mock tests must never be reported
as proof that natural long-form conversation has been verified.

## Out of scope

Character-card import from other services, TTS, new emotion art/classifiers, billing
activation, deployment and merging. Existing animation and financial safeguards remain.
