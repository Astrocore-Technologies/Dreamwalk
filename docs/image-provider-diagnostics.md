# Safe image-provider failure diagnostics

A non-success HTTP response remains an **unknown billing outcome**. HTTP 403 does
not establish zero cost, authorize a retry, or prove a particular root cause.
No provider request is repeated automatically.

`safeImageErrorDiagnostic(response)` in
`apps/api/src/image-generation/error-diagnostics.ts` consumes at most 8192 bytes
with a two-second diagnostic read deadline. It returns HTTP status, a narrowly
validated `req_…` receipt, allowlisted provider code/type and, where recognized,
a canonical message for organization verification, model access, permissions,
authentication or rate/quota restriction. Every diagnosis is explicitly
`provider_reported`, not independently verified.

Raw provider prose, error parameters, headers, URLs, organization identifiers,
prompt excerpts and credential echoes are never retained. Unknown or malformed
bodies yield only safe status/receipt metadata. Even recognized messages are
replaced wholesale, not passed through a regex-redaction filter.

The adapter throws `ImageProviderFailure` with `outcomeUnknown=true`. The image
worker stores only reconstructed safe diagnostics in `safe_diagnostic`, preserves
the uncertain reservation and request receipt, and exposes them through the
existing authenticated own-job view. Foreign-job access remains forbidden.
Confirmed erasure clears diagnostics and receipt identifiers; late failures
cannot restore them. Export normalizes the same allowlist again.

For an independently approved one-shot desktop script, reuse this helper rather
than dumping a response body or reimplementing weaker redaction. Preserve the
same durable unknown-cost reservation and no-retry rule. This code change is not
permission for another live request; no earlier missing response body can be
recovered or retrospectively diagnosed by these tests.
