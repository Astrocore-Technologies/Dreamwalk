/** Evaluation-only durable transport guard. Never loaded by the ordinary application. */
import { open, readFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
export const LIMITS = Object.freeze({
  approvedMicros: 1000000,
  carriedMicros: 10769,
  runCapMicros: 200000,
  requestUpperMicros: 50000,
  maxRequests: 4,
  maxBodyBytes: 64000,
  maxResponseBytes: 128000,
  maxOutputTokens: 4096,
  inputRate: 550000,
  outputRate: 825000,
  model: 'gpt-6-luna',
});
export const pricedUsage = (input, output) =>
  Math.ceil((input * LIMITS.inputRate + output * LIMITS.outputRate) / 1000000);
async function persist(path, value) {
  const temp = path + '.next';
  const f = await open(temp, 'w', 0o600);
  try {
    await f.writeFile(JSON.stringify(value));
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(temp, path);
  const d = await open(dirname(path), 'r');
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
export async function createStoryGuard(path, transport) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await open(path + '.lock', 'wx', 0o600); // A crash requires review, never automatic unlock/retry.
  let ledger;
  try {
    ledger = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      await lock.close();
      throw e;
    }
    ledger = { version: 1, limits: LIMITS, attempts: [] };
    await persist(path, ledger);
  }
  return createDurableStoryGuard(
    ledger,
    (value) => persist(path, value),
    async () => {
      await lock.close();
      const { unlink } = await import('node:fs/promises');
      await unlink(path + '.lock');
    },
    transport,
  );
}
/** Shared policy independent of platform-specific durable storage. */
export function createDurableStoryGuard(ledger, save, release, transport) {
  if (
    ledger.version !== 1 ||
    !ledger.limits ||
    Object.keys(ledger.limits).length !== Object.keys(LIMITS).length ||
    Object.entries(LIMITS).some(([k, v]) => ledger.limits[k] !== v) ||
    !Array.isArray(ledger.attempts) ||
    ledger.attempts.length > LIMITS.maxRequests ||
    ledger.attempts.some(
      (a) =>
        !['reserved', 'unknown', 'known'].includes(a.state) ||
        typeof a.jobId !== 'string' ||
        a.upperMicros !== LIMITS.requestUpperMicros ||
        (a.state === 'known' &&
          (!Number.isSafeInteger(a.costMicros) ||
            a.costMicros < 0 ||
            a.costMicros > a.upperMicros)),
    ) ||
    new Set(ledger.attempts.map((a) => a.jobId)).size !== ledger.attempts.length
  )
    throw Error('LEDGER_POLICY_CHANGED');
  let busy = false,
    closed = false;
  return {
    snapshot: () => structuredClone(ledger),
    async close() {
      if (!closed) {
        closed = true;
        await release();
      }
    },
    async fetch(url, init) {
      if (closed) throw Error('GUARD_CLOSED');
      if (busy) throw Error('ONE_REQUEST_AT_A_TIME');
      if (
        String(url) !== 'https://api.openai.com/v1/responses' ||
        init?.method !== 'POST' ||
        init.redirect !== 'error'
      )
        throw Error('LIVE_ROUTE_FORBIDDEN');
      const body = JSON.parse(init.body),
        bytes = Buffer.byteLength(init.body),
        headers = new Headers(init.headers),
        jobId = headers.get('x-client-request-id');
      if (
        !jobId ||
        body.model !== LIMITS.model ||
        body.service_tier !== 'default' ||
        body.store !== false ||
        body.stream !== false ||
        body.tools ||
        body.previous_response_id ||
        body.prompt_cache_retention ||
        body.max_output_tokens !== LIMITS.maxOutputTokens ||
        bytes > LIMITS.maxBodyBytes
      )
        throw Error('LIVE_REQUEST_NOT_APPROVED');
      const input = JSON.parse(body.input);
      if (!['narrative', 'speech'].includes(input.purpose)) throw Error('LIVE_PURPOSE_FORBIDDEN');
      if (ledger.attempts.some((a) => a.state === 'reserved' || a.state === 'unknown'))
        throw Error('UNRECONCILED_EXPOSURE');
      if (ledger.attempts.some((a) => a.jobId === jobId)) throw Error('DUPLICATE_DISPATCH');
      const spent = ledger.attempts.reduce((n, a) => n + (a.costMicros ?? a.upperMicros), 0);
      if (
        ledger.attempts.length >= LIMITS.maxRequests ||
        spent + LIMITS.requestUpperMicros > LIMITS.runCapMicros ||
        LIMITS.carriedMicros + spent + LIMITS.requestUpperMicros > LIMITS.approvedMicros
      )
        throw Error('LIVE_BUDGET_EXHAUSTED');
      if (pricedUsage(bytes + 4096, LIMITS.maxOutputTokens) > LIMITS.requestUpperMicros)
        throw Error('LIVE_BOUND_EXCEEDED');
      busy = true;
      const attempt = {
        jobId,
        requestHash: createHash('sha256').update(init.body).digest('hex'),
        requestBytes: bytes,
        purpose: input.purpose,
        contextHash: input.context?.contextHash ?? null,
        state: 'reserved',
        upperMicros: LIMITS.requestUpperMicros,
        at: new Date().toISOString(),
      };
      ledger.attempts.push(attempt);
      await save(ledger);
      try {
        const response = await transport(url, init);
        attempt.httpRequestId = response.headers.get('x-request-id')?.slice(0, 200) ?? null;
        attempt.requestId = attempt.httpRequestId;
        if (!response.ok || !response.body) throw Error('RESPONSE_UNKNOWN');
        const reader = response.body.getReader();
        let size = 0;
        const chunks = [];
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > LIMITS.maxResponseBytes) {
            await reader.cancel();
            throw Error('RESPONSE_TOO_LARGE');
          }
          chunks.push(part.value);
        }
        const raw = Buffer.concat(chunks),
          value = JSON.parse(raw.toString());
        const usage = value.usage;
        if (value.id && typeof value.id === 'string') attempt.requestId = value.id.slice(0, 200);
        if (value.id && typeof value.id === 'string') attempt.responseId = value.id.slice(0, 200);
        if (
          value.service_tier !== 'default' ||
          !Number.isSafeInteger(usage?.input_tokens) ||
          !Number.isSafeInteger(usage?.output_tokens) ||
          usage.input_tokens < 0 ||
          usage.output_tokens < 0 ||
          usage.input_tokens > bytes + 4096 ||
          usage.output_tokens > LIMITS.maxOutputTokens
        )
          throw Error('USAGE_OR_TIER_UNKNOWN');
        attempt.state = 'known';
        attempt.inputTokens = usage.input_tokens;
        attempt.outputTokens = usage.output_tokens;
        attempt.costMicros = pricedUsage(usage.input_tokens, usage.output_tokens);
        attempt.costEvidence = 'conservative_configured_rates_not_invoice';
        await save(ledger);
        return new Response(raw, { status: response.status, headers: response.headers });
      } catch {
        attempt.state = 'unknown';
        await save(ledger);
        throw Error('LIVE_OUTCOME_UNKNOWN_STOP');
      } finally {
        busy = false;
      }
    },
  };
}
