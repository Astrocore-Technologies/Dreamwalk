# One-off isolated authoring test

Prepared code only: applying migration 043 does not activate a grant or dispatch a provider.
Baseline: 2051a2d52650f694f5ac4085133d2d895edc9b82. Migration 043 is standalone after baseline 040; 041/042 are not dependencies.

## Admission and financial evidence

The configured generation owner can explicitly POST `/generation/bounded-authoring-tests` with:

```json
{
  "operationId": "<fresh UUID retained for replay>",
  "adventureId": "<new owned PRIVATE synthetic draft UUID>",
  "candidateFingerprint": "<existing reviewed owner configuration fingerprint>",
  "consent": true,
  "isolatedSyntheticStory": true,
  "lifetimeMinutes": 120
}
```

This is activation, not a read-only preflight. Do not POST until the local runner has reviewed the actual stored evidence, provider parameters and applicable estimate-risk approval. The two-hour lifetime starts at this explicit activation. Replaying exactly the same body returns the original receipt and does not extend its life. A different body cannot create another allowance for the same legacy grant.

Required inherited acknowledgement: original grant's immutable current policy revision must contain `image.estimateRiskAccepted: true`, `costBasis: approved_estimate`, and `providerEnforcesQuotedCap: false`; its fingerprint and complete safe profile must match current configuration, with unexpired pricing. Missing evidence returns `BOUNDED_PRIOR_RISK_ACK_REQUIRED`; changed policy returns `BOUNDED_PRIOR_POLICY_MISMATCH`. These are not silently replaced with new assent. The actual old job must retain the exact request ID, model, model-access 403 diagnostic, null actual cost and 66,900-micro hold. No history is reconciled by this feature.

The immutable new-session ledger ceiling is 500,000 USD micros, including concurrent held reserves and settled actuals across text and images. The parent ceiling freezes **all evidenced prior settled spend + retained 66,900 + 500,000**, deduplicating legacy provider spend already represented by shared reservations. Other unresolved/unaccounted liabilities reject admission. A smaller independently configured total cap rejects activation; it is never raised. Existing configured text/image caps also bound cumulative historical plus new usage of that kind; child scope purpose caps are clamped to the smaller configured cap. Existing legacy-scope admissions (including retained-rejection image exceptions) cannot escape the new aggregate fence once activated. Mock activity remains non-monetary.

**A ledger ceiling is not an invoice guarantee.** Existing approved-estimate evidence and risk flags remain unchanged. Request estimates are not relabeled provider-enforced caps. Before any live dispatch, the runner must verify actual configured models/rates/request parameters and resolve any newly identified unbounded pricing term with the owner. In particular, an image output-token calculator estimate alone does not establish a maximum. This patch makes no provider request and introduces no paid token-count preflight.

## Test isolation and use

Never use the original story/save/image collection. Create a new private synthetic draft with no published snapshot or playable versions, created after the approval. Bind its UUID at activation. Only story-plan projects belonging to that target and owner can use text generation. Only studio location-background images on that target can use image generation. NPC automatic queues are outside this allowance.

Pass the returned `authorizationId` explicitly as `sessionId` to existing quote/consent/dispatch endpoints. Every quote remains separately reviewed; this receipt does not automatically quote, dispatch, retry or regenerate. Existing provider kill switches, source/version fences and monetary controls remain in force.

GET `/generation/bounded-authoring-tests/:authorizationId` reports receipt, usage, outstanding held amount, remaining allowance and blocking state. New unknown outcomes retain their holds and block further calls; expiration likewise blocks new dispatch. Actual overrun is recorded honestly and blocks subsequent admission rather than truncating cost to the estimate. No old request is assigned zero cost or released.

## Validation

`npm run build -w @dreamwalk/api`

`node --test tests/game/bounded-authoring-test.test.cjs`

The latter creates its own disposable local PostgreSQL cluster and synthetic records only. It does not use an existing application database or a provider. It covers exact legacy evidence, missing acknowledgement, altered policy, owner/target restrictions, immutable receipts, concurrent activation replay, cross-kind reservation concurrency, aggregate prior spend/global-cap conflict, expiration, legacy admission escape, next-unknown stopping and preservation of old financial rows.
