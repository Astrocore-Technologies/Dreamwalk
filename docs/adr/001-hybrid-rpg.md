# ADR 001: Hybrid, server-authoritative RPG

Status: accepted for local G0–G3 implementation, 2026-10-30.

The owner approved real top-down movement, independent player locations and local
simultaneous-intent encounters. This supersedes the earlier point-and-click-only
game queue, without replacing the existing platform or its publication controls.

## Decision

- Keep Next.js, NestJS, PostgreSQL and the single npm workspace lockfile.
- Put deterministic rules, navigation, visibility and encounter resolution in a
  pure game-core package. Pixi renders committed projections, not authoritative rules.
- One campaign writer serializes all changes, including movement checkpoints,
  asynchronous NPC results and round deadlines. PostgreSQL CAS is the final guard.
- Persist significant actions before acknowledgement. Intermediate movement may
  roll back to its most recent checkpoint after a crash; confirmed inventory may not.
- Project only the viewer's permitted location, visible entities and own inventory.
  Public source content never means publicly readable campaign saves.
- Affected encounter areas freeze, not the entire group. New movement generations
  reject delayed input; deterministic order resolves competing item/cell claims.
- Mock NPCs propose supported actions. Unknown, stale or unauthorized proposals
  fail safely. No game text can change account permissions or service credits.
- Start with an explicit immutable observatory fixture. Stories without validated
  playable maps remain unavailable for play; author map tooling belongs to G5.

## Boundaries

G0–G3 are a local prototype. No real AI, image provider, purchases, Discord integration,
public deployment or new repository publication is included. G4 needs separate
provider/data/budget approval. Four-player/load/production claims need measured evidence.

## Verification

Core unit tests, real isolated PostgreSQL/socket checks and two independently
authenticated browser contexts form complementary evidence. Shared-cookie tabs
are not evidence of two users. Record passed, failed and unrun checks separately.

The full design and acceptance criteria are in
[the hybrid architecture](../hybrid-rpg-architecture.ru.md).
