# One coherent visual-story journey: validation boundaries

Current scope is the player/AI/visual loop and one small opening adventure. It does
not include translation, Discord, real purchases or public deployment.

| Player outcome                            | Implemented path                                                                                                              | Evidence / remaining gate                                                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choose a story without losing it at login | Allowlisted story-return intent through signin, signup, onboarding and hero preparation; explicit launch remains required     | Public cloud-browser navigation checked; authenticated return/Continue scenarios are in `story-auth-return.spec.ts`, pending exact-head CI for this change |
| Play as an owned hero                     | Server-authorized immutable per-member hero snapshot                                                                          | Existing exact-head browser/API tests cover selection, privacy and reload; later hero edits do not mutate the campaign                                     |
| Continue a saved adventure                | Durable commands, world checkpoints, shared story and Home Continue                                                           | Baseline co-op/browser tests passed; the new journey also checks logout/login and the same campaign/hero via Home Continue                                 |
| Coauthor a changing world                 | Ordinary story composer, typed proposal, validated atomic new scene/NPC and shared canon                                      | Baseline two-player three-turn browser scenario passed; deterministic fixture behavior is not proof of natural storytelling                                |
| Talk to a character who remembers         | Ordinary speech through audience-filtered context, personal memory and provider boundary                                      | Actual application pipeline rehearsed with a fake Responses transport; new live evaluation records quality separately from mechanical success              |
| See story-grounded artwork                | Current confirmed canon → permitted asset search → explicit quote/consent → raster admission → authoritative attachment/reuse | Actual library-raster scene rendering and persistence tested; no newly generated final paintings or artistic-quality acceptance claimed                    |
| Spend only within the authorized test     | Carried text debit, bounded requests, durable reservation and unknown-cost stop                                               | Deterministic guard tests and isolated rehearsal; fresh secure key and verified permitted execution route still required                                   |

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
  never through chat, command arguments, source or a saved environment file.
- Verify the selected runtime's provider egress and rehearse the exact evaluation
  kit there without network dispatch before enabling the one-time paid test.
- Keep the original text allowance and prior receipts; workspace replacement is
  not a new budget. Do not reset an unresolved ledger to retry.
- Resolve image-price upper-bound versus estimate-risk consent before an actual
  image request. Do not silently use a text allowance for images.

The development preview is mock-only. Neither a green pipeline nor a merged change
authorizes production activation, deployment, payments or a user-machine restart.
