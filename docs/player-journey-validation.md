# One coherent visual-story journey: validation boundaries

Current scope is the player/AI/visual loop and one small opening adventure. It does
not include translation, Discord, real purchases or public deployment.

| Player outcome                            | Implemented path                                                                                                              | Evidence / remaining gate                                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choose a story without losing it at login | Allowlisted story-return intent through signin, signup, onboarding and hero preparation; explicit launch remains required     | Public cloud-browser navigation checked; four authenticated return/Continue/cancel/mode-change scenarios passed in both 24-scenario CI runs on `4f0513c` |
| Play as an owned hero                     | Server-authorized immutable per-member hero snapshot                                                                          | Existing exact-head browser/API tests cover selection, privacy and reload; later hero edits do not mutate the campaign                                   |
| Continue a saved adventure                | Durable commands, world checkpoints, shared story and Home Continue                                                           | Baseline co-op/browser tests passed; the new journey also checks logout/login and the same campaign/hero via Home Continue                               |
| Coauthor a changing world                 | Ordinary story composer, typed proposal, validated atomic new scene/NPC and shared canon                                      | Baseline two-player three-turn browser scenario passed; deterministic fixture behavior is not proof of natural storytelling                              |
| Talk to a character who remembers         | Ordinary speech through audience-filtered context, personal memory and provider boundary                                      | Actual application pipeline rehearsed with a fake Responses transport; new live evaluation records quality separately from mechanical success            |
| See story-grounded artwork                | Current confirmed canon → permitted asset search → explicit quote/consent → raster admission → authoritative attachment/reuse | Actual library-raster scene rendering and persistence tested; no newly generated final paintings or artistic-quality acceptance claimed                  |
| Spend only within the authorized test     | Carried text debit, bounded requests, durable reservation and unknown-cost stop                                               | Deterministic guard tests and isolated rehearsal; fresh secure key and verified permitted execution route still required                                 |

## Product acceptance, not just test counts

A successful live check must show the first story beat becoming a real reachable
scene, a newly introduced NPC responding in character, a second beat referring to
confirmed earlier events, and both participants seeing the same saved continuation.
Generic safe replies do not pass the quality rubric merely because JSON is valid.
Server validation protects mechanics and access; it cannot prove every prose claim
is coherent, interesting or free of hallucination.

Actual art acceptance requires inspection of the generated pixels in the real scene:
correct location/character identity and perspective, legible player and object layers,
no invented interactive objects baked into the background, and no generation charge
on return. Prototype vectors and reuse-test rasters are explicitly not final art.

## External actions still requiring a safe execution handoff

- Supply a fresh provider credential only through the approved secure entry path;
  never through chat, command arguments or source. The owner subsequently authorized a specific user-created, ACL-restricted local file; only the explicitly approved local loader may read it into a transient child environment. The evaluator itself never discovers or loads credential files.
- Verify the selected runtime's provider egress and rehearse the exact evaluation
  kit there without network dispatch before enabling the one-time paid test.
- Keep the original text allowance and prior receipts; workspace replacement is
  not a new budget. Do not reset an unresolved ledger to retry.
- Resolve image-price upper-bound versus estimate-risk consent before an actual
  image request. Do not silently use a text allowance for images.

The development preview is mock-only. Neither a green pipeline nor a merged change
authorizes production activation, deployment, payments or a user-machine restart.

## First real evolving-story evaluation (2026-10-31)

Exact source `4f0513c5976d2365268b66e468bbc2c076fe57b5` completed two
director and two ordinary NPC requests, with no retries. The server admitted a real
10×8 restoration room, reciprocal transitions and a new named restorer. Two
players entered it; a real API restart preserved their shared continuation. All
four jobs committed without schema or compare-and-swap rejection.

This was **partial semantic success**, not product-quality acceptance. The NPC
kept its identity but failed to recall a player-chosen signal name even though the
public prior utterance was present in both persistent memory and supplied claims.
The second director turn maintained continuity but supplied atmosphere rather than
a concrete actionable lead. This is evidence of poor use of available context,
not evidence that the memory disappeared. Sanitized excerpts, rather than complete
raw HTTP bodies, were retained; missing fields must not be reconstructed as fact.

The offline repair binds ordinary speech to its exact audience-authorized current
utterance, separates purpose-specific instructions and records exact per-turn
questions and new replies. Fixtures verify provenance, privacy, context packing
and transport contracts; they **cannot establish improved live model behavior**.
That semantic check remains pending separate authorization. The completed run's
four-dispatch allowance is exhausted and must not be reset for this repair.

Conservative configured cost was 5212 micro-USD (not a provider invoice), with
6754 input and 1812 output tokens. Original text allowance remaining: 984019
micro-USD after the retained conservative carried reserve; unknown/reserved
exposure was zero. This does not authorize further requests. Image evaluation is
a separate, explicitly approved one-shot workflow, not part of this text result.
