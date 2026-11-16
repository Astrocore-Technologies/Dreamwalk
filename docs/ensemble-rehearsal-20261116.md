## Director turns on a synthetic story (same day, same ceiling)

Script: `scripts/director-live-rehearsal.mjs` (builds real `story_turn` contexts from a small synthetic
story: blacksmith Erik, cartographer Lira and the god Hitogami placed beyond the map). Five paid
requests in two runs, no adapter retries. Running total with the first rehearsal: **USD 0.0222** of 0.50.

| Turn                                    | In tokens | Out tokens | Cost (US cents) | Seconds |
| --------------------------------------- | --------- | ---------- | --------------- | ------- |
| look around (attempt only)              | 6995      | 651        | 0.224           | 8.4     |
| speech + action to Erik                 | 8145      | 1592       | 0.323           | 18.0    |
| stranger in the doorway (new character) | 7029      | 909        | 0.244           | 11.8    |
| address the god aloud                   | 7466      | 1537       | 0.302           | 18.6    |

- A director turn costs about 0.22–0.32 cents; with one 0.15-cent character reply a whole turn is roughly
  0.4–0.5 cents, so the 50-Dream starter grant (25 API cents) covers on the order of 50–60 turns.
- One further director request (the stranger turn, first attempt) came back with a response that failed
  schema validation (`PROVIDER_INVALID_RESULT`). The same input succeeded on a deliberate second run. The
  adapter never retries on its own, so a player would see a failed turn: roughly 1 in 5 here, too small a
  sample to quote as a rate but worth a bounded repair strategy.
- The new character was created with a sensible profile, but as `location_only` rather than on the map.
- Quality problems seen: the attempt-only turn just restated the action; when the player addressed Erik,
  Lira answered and then deflected to him; when the player addressed the god, nobody spoke for the god
  and Lira answered instead. These are prompt/routing issues to fix, not cost issues.
