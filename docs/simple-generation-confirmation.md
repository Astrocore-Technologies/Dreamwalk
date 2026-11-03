# Single-confirmation gameplay generation

The ordinary story composer replaces the sidebar's technical generation controls:
write a message, click Send, review the approximate Sparks cost and planned reserve,
then confirm or cancel. Editing the message, recipient, scene or turn invalidates the
estimate. Cancel does not submit the message, reserve Sparks or call a provider.

The turn-based composer quotes the exact anticipated deferred speech/director
contexts without advancing the actual turn. Confirmation binds only those snapshots;
it does not end the player's turn, approve future requests or change multiplayer
rules. The existing native queue retains membership, policy, pricing, quote,
request-body, wallet and idempotency checks. A changed world requires a new compact
estimate for the unpaid response, without resending the player's message.

Existing unpaid requests can use that recovery flow only when no job, permit,
reservation or hold exists. Already dispatched or uncertain operations are never
reconstructed as fresh paid requests.

Unrelated autonomous world work uses a separate compact aggregate estimate for the
campaign owner. Migration 050 stores the exact request identities, context digests,
native quote references and aggregate quote, not copies of private NPC/message
context. One explicit batch consent binds the immutable list; dispatch remains
sequential through the existing financial primitives. Changed/failed/unknown work
must not authorize the remaining requests or a new list implicitly.

Unrecognized asterisk emotes remain attributed roleplay attempts in message order,
not a reason to reject the entire message or a source of inventory, money, damage
or movement grants. Supported mechanical actions still use server validation.
NPCs may narrate incidental food, coins or service without a physical item record;
that narration does not create an inventory item or a map entity. Optional physical
item interactions remain available when deliberately used and valid.

The displayed amount is an estimate, not a provider-enforced invoice ceiling.
Financial holds and settled receipts remain distinct; confirmed actual usage is
captured once and unused holds released, while unknown costs remain for reconciliation.
No model, provider configuration, production wallet or deployment is changed here.

## Verification

- `npm run test:game` includes executable component-handler tests for cancellation,
  double clicks, quote expiry, context changes, immutable uncertain retry and Sparks
  estimate/hold presentation. These are not browser-layout tests.
- `npm run test:game:integration` discovers the new composer and world-batch real
  disposable PostgreSQL suites, using injected synthetic providers only.
- `tests/e2e/simple-generation-confirmation.spec.ts` covers the composer and stale
  reply UI using intercepted quotes/consents, without real provider calls.
- Exact-head CI must execute browser assertions: local Chromium was blocked by
  sandbox socket restrictions, and managed CUA could not reach the isolated local
  server namespace. Local test source collection is not a browser pass.
