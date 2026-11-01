import { createHash } from 'node:crypto';
import type { TextTokenCounter } from './text-context';
import { ProviderFailure } from './types';
export const TEXT_COUNT_VERSION = 'openai-responses-input-tokens-v1';
export const bodyHash = (body: string) => createHash('sha256').update(body).digest('hex');
export interface TextCountEvidence {
  id: string;
  model: string;
  bodySha256: string;
  inputTokens: number;
  providerVersion: string;
  policyRevision: number;
  policyHash: string;
}
export interface TextCountAdapter {
  readonly version: string;
  countBody(purpose: import('./types').AiPurpose, context: unknown): string;
  count(
    purpose: import('./types').AiPurpose,
    context: unknown,
    operationId: string,
  ): Promise<number>;
}
/** Internal snapshots never become model instructions or recursively hash themselves. */
export function modelContext(context: unknown): unknown {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return context;
  return Object.fromEntries(
    Object.entries(context).filter(
      ([k]) => !['textContextCandidate', 'textCountEvidence'].includes(k),
    ),
  );
}
export function evidenceCounter(
  body: string,
  model: string,
  version: string,
  context: unknown,
): TextTokenCounter | undefined {
  const e = (context as { textCountEvidence?: TextCountEvidence } | null)?.textCountEvidence;
  if (!e) return undefined;
  if (
    e.model !== model ||
    e.providerVersion !== version ||
    e.bodySha256 !== bodyHash(body) ||
    !Number.isSafeInteger(e.inputTokens) ||
    e.inputTokens < 0 ||
    !e.id ||
    !e.policyHash
  )
    throw new Error('TEXT_COUNT_EVIDENCE_STALE');
  return {
    id: TEXT_COUNT_VERSION,
    precision: 'exact',
    supports: (m) => m === model,
    countInput: (candidate) => {
      if (bodyHash(candidate) !== e.bodySha256) throw new Error('TEXT_COUNT_EVIDENCE_STALE');
      return e.inputTokens;
    },
  };
}
/** Only fields supported by InputTokenCountParams; reserve output locally. */
export function countRequestBody(body: string) {
  const v = JSON.parse(body) as Record<string, unknown>;
  return JSON.stringify(
    Object.fromEntries(
      ['model', 'instructions', 'input', 'text', 'reasoning', 'truncation']
        .filter((k) => k in v)
        .map((k) => [k, v[k]]),
    ),
  );
}
export async function countOpenAiInput(
  body: string,
  key: string | undefined,
  operationId: string,
  transport: typeof fetch,
) {
  if (!key) throw new ProviderFailure('TEXT_COUNT_CREDENTIAL_REQUIRED', false);
  let response: Response;
  try {
    response = await transport('https://api.openai.com/v1/responses/input_tokens', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'X-Client-Request-Id': operationId,
      },
      body: countRequestBody(body),
    });
  } catch {
    throw new ProviderFailure('TEXT_COUNT_OUTCOME_UNKNOWN', true);
  }
  if (!response.ok)
    throw new ProviderFailure(
      response.status === 403 ? 'PROVIDER_HTTP_403' : 'TEXT_COUNT_HTTP_ERROR',
      true,
    );
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  if (!response.body) throw new ProviderFailure('TEXT_COUNT_INVALID_RESPONSE', true);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      bytes += r.value.byteLength;
      if (bytes > 16384) {
        await reader.cancel();
        throw new Error('oversized');
      }
      chunks.push(r.value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      value.object !== 'response.input_tokens' ||
      !Number.isSafeInteger(value.input_tokens) ||
      value.input_tokens < 0
    )
      throw new Error('invalid');
    return value.input_tokens as number;
  } catch {
    throw new ProviderFailure('TEXT_COUNT_INVALID_RESPONSE', true);
  }
}
