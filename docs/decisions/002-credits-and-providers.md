# ADR 002: credits and provider boundaries

**Status:** demo accounting implemented; real spending deferred.

Credits (Искры) are a single future consumable currency, separate from narrative coins/items and provider costs. Integers only. Append-only ledger with unique source keys and transactional wallet locks prevents double grant and concurrent negative balances. Compensation adds a new entry. No public balance setter, cash-out, transfers or subscriptions.

At this milestone all balances are explicitly demo and non-purchasable. Real AI/payment/Discord execution and nonzero spend caps fail configuration validation. Runtime configuration is not provider integration. Endpoint identifiers are allowlisted to avoid arbitrary URL requests; keys never enter UI.

Behavioral style (Green Apple/Cookie), character identity (NPC), and RuntimeProfile remain separate. Future text, image, identity, payment and storage adapters will be added at the appropriate authorized milestone. No implicit fallback from mock to paid providers.
