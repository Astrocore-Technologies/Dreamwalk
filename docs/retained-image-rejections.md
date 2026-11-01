# Distinct image requests after an explicit model refusal

An explicit, structured HTTP403 model_not_found/model_access_denied response has no usable image. It does not prove zero billing. The original job remains unknown and its full reservation remains held in the same financial scope.

For owner image requests only, a fresh server assessment may permit a distinct quote and explicit user-confirmed request within the remaining cap. Every held/spent amount is still counted. Only retained structured model-refusal holds are excluded from the one-active-request serialization check; a new queued/dispatched image still blocks another admission. Timeout, 5xx, missing/ambiguous diagnostics, conflicting text/provider liabilities, stale policy, overruns and insufficient funds remain blocked. The check is repeated under authorization/scope locks at admission and dispatch. No database flag, authorization stop, old attempt, invoice amount or cap is changed by reporting this capability. Text and policy amendments retain their existing stop rules.

Old attempts are optional history, not a new card failure. Generate remains the action until a usable image is saved for the location. Regenerate always needs a fresh quote and consent; a failed later attempt keeps the saved image visible. No provider request is retried automatically.

Synthetic tests cover retained accounting, image-only capability, ambiguous-error stops, concurrent admission, worker reconstruction, usable library output and insufficient remaining funds. Live verification is a separate authorized single request through the user's Firefox, not an assertion based on mock output.
