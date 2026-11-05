# Ordinary round cost presentation and admission

Optional NPC communication is chosen after a paid plan. Its eventual request does
not exist when the player ends their turn. The immutable `bounded-npc-speech-v1`
permission therefore still allows one text-only child per planned NPC, with the
original payer, source plan, round, provider, tariff, context/output limits, and
zero retries, images or paid counting calls.

That technical permission ceiling is not an expected charge or an upfront hold.
Ordinary admission requires funds for the concrete mandatory requests, rather
than every possible future full-window speech request. Under the payer wallet
lock, accepted unpaid mandatory text, image and grounding tranches retain funding
priority. Existing holds are already subtracted from available funds and are not
counted twice. Optional children cannot consume the protected remainder.

When a plan actually chooses communication, the unchanged native path freezes
and prices its complete audience-safe request, verifies the original envelope,
and atomically reserves available funds before dispatch. A definitive lack of
funds skips only a proven-unspent optional request, with a visible no-charge
notice. It never requests another ordinary-round confirmation. An existing job,
permit, reservation or quote-linked hold prevents that unspent classification,
including legacy exact batch entries. Unknown outcomes keep their liability and
cannot authorize another request.

The read-only forecast now constructs current say/whisper examples from the real
NPC memories and audience, using the existing public-disclosure builder and
configured request estimator. Planning may move a character, choose another
listener, or remain silent: these examples are not bounds on future requests.
Missing examples or pricing remain unknown; a known mandatory subtotal can still
be shown. Only aggregate amounts leave the server. The UI separately presents
current-context estimates, spendable Sparks/Dreams, conditional optional speech,
actual receipts and the collapsed technical permission ceiling. Explicit world
quotes include the server-derived `requiredSparkSubunits`; their original total,
entries, rates and consent hashes are not rewritten.

No tokenizer, cache tariff, output limit, context window or historical settlement
rule is weakened. The UTF-8 counter is a conservative operator estimate, not a
verified model tokenizer. A frozen-body quote does not become a guaranteed
provider invoice cap. Cache hits are not assumed; mixed cache-write receipts keep
their historical pricing. Provider overruns remain unresolved liability rather
than an automatic extra charge or retry. Smaller reserves via exact remote counts
or a verified local tokenizer require their own finite, versioned contract.

Verification uses synthetic transports and disposable PostgreSQL only. Relevant
cases cover current-context versus full-window estimates, Unicode growth,
audience privacy, owner-only funding, insufficient optional funds, mandatory
priority, concurrent admission, request replay, unknown liabilities, quote-linked
holds, and round completion. CI supplies full build and browser coverage; local
focused results alone are not a claim of live-provider quality.
