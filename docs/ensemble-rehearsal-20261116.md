# Ensemble reply rehearsal on the live model (2026-11-16)

Owner-approved ceiling: USD 0.50, no automatic retries. Script: `scripts/ensemble-live-rehearsal.mjs`
(default prints the plan; `--execute` needs `ENSEMBLE_REHEARSAL_APPROVED=usd-0.50-hard-cap-no-retry`).
Synthetic content only, model `gpt-6-luna`, rates 0.25/0.75 USD per million tokens.
Six speech requests, **total USD 0.0088** (1.8% of the ceiling). One earlier attempt failed before
leaving the machine (Node's fetch ignored the sandbox proxy); it reached no provider and was re-run
once after fixing `NODE_USE_ENV_PROXY=1`.

| Request                                      | In tokens | Out tokens | Cost (US cents) | Seconds |
| -------------------------------------------- | --------- | ---------- | --------------- | ------- |
| ensemble greeting (Paul leads, Roxy follows) | 4525      | 439        | 0.146           | 6.4     |
| single Roxy                                  | 3946      | 396        | 0.128           | 5.2     |
| single Paul                                  | 3935      | 662        | 0.148           | 7.9     |
| single Hitogami                              | 3922      | 528        | 0.138           | 7.4     |
| ensemble with a knife at Paul's throat       | 4555      | 543        | 0.155           | 7.2     |
| ensemble, calm remark                        | 4516      | 654        | 0.162           | 8.2     |

- Three separate replies cost about 0.41 cents; one ensemble request about 0.15 cents (-63%).
- No mirrored pairs and no question-endings in any ensemble output; the knife scene made both characters
  react in their own voices.
- Hitogami (optional responder) stayed silent in every ensemble, as intended for a god who speaks rarely.
- Replies came back in English because the synthetic context lacked the real language field; the real
  runtime passes it, so this is a rehearsal artifact, not a finding. Re-check in a full game turn.
- Not covered: director/narrator `story_turn` requests (larger), the database cache-settlement path for
  followers, and long histories. Measure those with the admin "Turn cost" tab on a real game.
