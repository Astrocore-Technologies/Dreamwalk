# Owner policy review and request reserves

The combined budget belongs to the existing financial scope. It is not the hold
for every operation. Starting the server or reviewing a policy never dispatches a
provider request. Credentials stay in the API-only environment.

## Request planning

A quote records its planning policy, request hash, price evidence and reserve.
An image plan uses the actual UTF-8 prompt length and number of owned/private
references, the configured model/size/quality output-token assumption and rate
profile. Reference allowances and token heuristics are explicitly operator chosen;
there is no invented official tokenizer formula or guaranteed invoice maximum.
The margin is added to the plan, rather than taking the entire remaining balance.
Insufficient funds reject the request instead of silently shrinking its reserve.

Text planning includes the serialized provider envelope: instructions, roles,
context, output schema, flags and bounded output plan, with an explicit protocol
allowance. Model context capacity is distinct from the planned request and the
provider's reported usage. The UI calls the held amount a reserve.

The server admits one outstanding owner request at a time. A duplicate operation
reuses its receipt. Known final usage settles once and frees the unused reserve;
unknown outcomes retain their liability and stop further use. HTTP403, permanent
stops, overruns and late receipts survive restarts and profile changes. There is
no automatic regeneration or retry against a real provider.

## Changing a policy

Complete or cancel undispatched work under the currently accepted profile before
changing the server settings. Unknown charges require reconciliation. Then the
owner updates the nonsecret server profile and restarts their server through
the ordinary configuration flow. The candidate must have current price evidence.
An existing accepted authorization and its scope remain unchanged until review.
The owner panel compares active/proposed models, rates, caps and evidence dates,
and displays spent/held/unknown liabilities. Cancelling review changes no money.

Applying requires an operation ID, the expected accepted revision and hash, the
reviewed candidate fingerprint and explicit owner consent. The server serializes
application with financial admission and rechecks all conditions transactionally.
A stale proposal or conflicting click cannot approve another candidate. An
uncertain response is reconciled with the operation's read-only receipt; the UI
does not blindly POST the same amendment again.

Each accepted revision is append-only history on the original authorization.
New caps cannot fall below spent plus held liabilities, either for the combined
budget or each purpose. Active/queued paid jobs, unresolved outcomes and durable
stops prevent revision. Raising a cap does not forgive costs or clear a stop.
Every dispatch rechecks the persisted accepted profile, including work prepared
by another process. Old jobs keep the prices and planning snapshot they received.

Legacy history is labelled unavailable when its original profile is not stored;
current prices are never invented as historical evidence. User erasure preserves
financial evidence while removing private content. Policy snapshots contain no
keys, private file paths, source photos or prompts.

## Manual setup

Keep the existing persistent database and registered account. Use the ignored
root `.env`, optional explicitly selected private server file and database file
as described in [owner generation](owner-generation.md). The example stays
`GENERATION_MODE=disabled` until the owner configures it manually. No temporary
two-hour session file is needed. Review the configured budget before the first
request, then quote and explicitly confirm each individual operation. Image
estimates require a separate risk acknowledgement.

Actual provider access, quality and invoice behavior require the owner's later
manual test. Synthetic transport tests do not establish that real API calls work.
