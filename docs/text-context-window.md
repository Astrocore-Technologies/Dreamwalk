# Per-request text context and reply limits

The requested total window is `text.contextBudgetTokens` (up to 256000). The model
capacity remains `text.contextTokens`; the effective window is the smaller value.
`text.maxOutputTokens` reserves reply space inside that window. These settings do
not change cumulative money caps or apply to image generation. No request is padded
to fill the selected context and no session-wide token allowance is consumed.

A token counter measures the complete provider envelope, not only player prose.
The adapter contract separates model capabilities, counting and pricing. Exact
counters must explicitly support the selected model and identify their version;
unsupported models use a labelled conservative estimate. There is currently no
verified local GPT-6 Luna tokenizer in this repository. The ordinary OpenAI path
therefore counts complete UTF-8 envelope bytes plus at least 4096 protocol tokens
as a conservative estimate. This can reach the configured limit before the real
model tokenizer. For example, 130000 Cyrillic letters occupy 260000 UTF-8 bytes;
that is not evidence that a 130000-token model prompt fits or has been tested.

OpenAI documents `POST /v1/responses/input_tokens` for exact request counts:
https://developers.openai.com/api/docs/guides/token-counting . It is not silently
called while quoting, typing or idling. No model-specific exactness is inferred
from another tokenizer, and the synthetic exact counter in tests is not a GPT
implementation. Actual model-specific counting and account access remain a manual
integration/verification boundary; there is no live-counting claim in this change.

The former 64 KiB gate no longer defines this explicit window mode. A separate
4 MiB transport safety limit fails oversized requests rather than cutting strings.
Legacy profiles keep their existing behavior and financial history. Adding or
changing the window requires the normal reviewed policy revision on the same
scope; it cannot clear old spending, unknown charges, holds or permanent stops.

Story context retrieves committed, audience-authorized feed records and old shared
narrative turns. NPC context retrieves only that NPC's own archived observations.
Shared speech excludes private facts and other participants' whispers through the
existing disclosure implementation. OOC party chat is never model history.
Retrieval has a bounded 32768-record candidate guard. Packing keeps whole records,
with older optional history removed first; canon, current scene/rules, current
questions, goals/obligations and their referenced evidence remain pinned. Existing
grounded summaries are reused; no paid summarization or hidden retry is introduced.
If required content alone cannot fit, the request fails before dispatch. Selection
never deletes database history. An admitted manual request retains its exact body
and pricing snapshot while another request or policy revision is pending.

Verification distinguishes growing estimated context, a synthetic exact adapter,
real PostgreSQL admission, and real provider behavior. Offline tests and fake
receipts do not prove a real 130k-token Russian conversation or real image quality.
