# First-party small adventures

Two hand-authored, free-to-start adventures sit beside the Observatory so a first player has something
polished to open without any paid AI preparation. They use the same authored-draft primitives as the
Observatory (items, doors, two NPCs, one objective) and the temporary placeholder map art.

| Slug                | Story                | Goal                                                     | Two ways across the threshold                                                      |
| ------------------- | -------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `whispering-forest` | Там, где лес помнит  | find the **book of names** on the forest path            | rusty key by the well, or the elder Nara's memory leaf (offered, must be accepted) |
| `tidekeepers`       | Маяк на краю прилива | find the **letter without an address** in the lighthouse | brass key on the pier, or keeper Brina's token (offered, must be accepted)         |

Code: `packages/game-core/src/first-party-stories.ts` (drafts, ru/uk/en labels and objectives),
`apps/api/src/game/seed-first-party-stories.ts` (editorial seed). The seed upgrades a story only while it is
still an unchanged first-party fixture (published, public, no draft, no playable version, no NPCs yet) and is
idempotent. Tests: `tests/game/first-party-stories.test.cjs` (compiles, localization, reachability, objective)
and `tests/e2e/first-party-stories.spec.ts` (each bundled story starts free and shows its goal).

## Not done: production

`apps/api/src/seed.ts` refuses to run in production, so these stories exist in development and CI only.
Publishing them to the live catalog needs an owner-approved production path (for example an operator
import through the normal Studio, submission and review flow). Nothing was written to the production
database.
