import {
  textUsageCostMicros,
  textInputReserveRate,
  type TextCachePricing,
} from '../generation/text-pricing';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../ai/context';
import { ProviderFailure } from '../ai/types';
import { LIVE_TEXT } from './config';
import {
  assertTextContext,
  measureTextContext,
  TEXT_CONTEXT_TRANSPORT_BYTES,
} from '../ai/text-context';
import {
  estimateTextRequest,
  estimateFingerprint,
  type TextReserveSnapshot,
  type TextEstimationPolicy,
} from '../generation/estimates';
import type { PreparedTextRequest } from '../ai/types';
export interface AuthoringTextProfile {
  model: string;
  contextTokens: number;
  contextBudgetTokens?: number;
  maxOutputTokens: number;
  storyPlanMaxOutputTokens?: number;
  maxInputBytes: number;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  cachePricing?: TextCachePricing;
  upperMicros: number;
  estimation?: TextEstimationPolicy;
  pricing?: { source?: string; reviewedAt: string; validUntil: string };
}
export interface AuthoringTextResult {
  proposal: unknown;
  requestId: string;
  failureCode?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    cacheWriteInputTokensDetails?: { ttl30mTokens: number; ttl12hTokens: number };
    costVerifiedForSparks?: boolean;
    costMicros: number;
    costEvidence: 'configured_rates' | 'reported';
  };
}
export interface AuthoringTextRequest {
  jobId: string;
  context: unknown;
  signal: AbortSignal;
  textReservationSnapshot?: TextReserveSnapshot;
  maxCostMicros?: number;
}
export interface AuthoringTextProvider {
  readonly version: string;
  readonly profile?: AuthoringTextProfile;
  prepareTextRequest?(context: unknown): PreparedTextRequest | undefined;
  generate(request: AuthoringTextRequest): Promise<AuthoringTextResult>;
}
export interface AuthoringTextDefinition {
  purpose?: 'story_plan';
  version: string;
  schema: Record<string, unknown>;
  instructions: string;
  validateProposal(value: unknown): unknown;
}
/** Exact key-free Responses body shared by quoting and transport. */
export function buildAuthoringTextRequestBody(
  definition: AuthoringTextDefinition,
  profile: AuthoringTextProfile,
  context: unknown,
): string {
  return JSON.stringify({
    model: profile.model,
    service_tier: 'default',
    ...(profile.cachePricing ? { prompt_cache_options: { mode: 'implicit', ttl: '30m' } } : {}),
    ...(profile.contextBudgetTokens !== undefined ? { truncation: 'disabled' } : {}),
    store: false,
    stream: false,
    reasoning: { effort: 'none' },
    max_output_tokens: profile.maxOutputTokens,
    instructions: definition.instructions,
    input: JSON.stringify(profile.estimation ? canonical(context) : context),
    text: {
      format: {
        type: 'json_schema',
        name: 'private_location_layout',
        strict: true,
        schema: definition.schema,
      },
    },
  });
}
/** Separate private-authoring adapter: no NPC/world schemas or authoritative game effects. */
export class BoundedAuthoringTextProvider implements AuthoringTextProvider {
  readonly version: string;
  constructor(
    private definition: AuthoringTextDefinition,
    private apiKey: string | undefined,
    private transport: typeof fetch = fetch,
    readonly profile: AuthoringTextProfile = LIVE_TEXT,
  ) {
    if (definition.purpose === 'story_plan' && profile.storyPlanMaxOutputTokens !== undefined) {
      if (
        !profile.estimation ||
        !Number.isSafeInteger(profile.storyPlanMaxOutputTokens) ||
        profile.storyPlanMaxOutputTokens < 16 ||
        profile.storyPlanMaxOutputTokens > 32000
      )
        throw new Error('INVALID_AUTHORING_PROVIDER_PROFILE');
      profile = { ...profile, maxOutputTokens: profile.storyPlanMaxOutputTokens };
    }
    if (profile.contextBudgetTokens !== undefined)
      profile = { ...profile, maxInputBytes: TEXT_CONTEXT_TRANSPORT_BYTES };
    if (
      !profile.model.trim() ||
      [
        profile.contextTokens,
        profile.maxOutputTokens,
        profile.maxInputBytes,
        profile.inputMicrosPerMillion,
        profile.outputMicrosPerMillion,
        profile.upperMicros,
      ].some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      profile.maxInputBytes > (profile.contextBudgetTokens !== undefined ? 4194304 : 64000) ||
      (!profile.estimation &&
        BigInt(profile.upperMicros) <
          (BigInt(profile.contextTokens) * BigInt(textInputReserveRate(profile)) +
            BigInt(profile.maxOutputTokens) * BigInt(profile.outputMicrosPerMillion) +
            999999n) /
            1000000n)
    )
      throw new Error('INVALID_AUTHORING_PROVIDER_PROFILE');
    textUsageCostMicros(profile, { inputTokens: 0, outputTokens: 0 });
    this.profile = Object.freeze({
      ...profile,
      ...(profile.cachePricing ? { cachePricing: Object.freeze({ ...profile.cachePricing }) } : {}),
      ...(profile.estimation ? { estimation: Object.freeze({ ...profile.estimation }) } : {}),
      ...(profile.pricing ? { pricing: Object.freeze({ ...profile.pricing }) } : {}),
    });
    this.version = createHash('sha256')
      .update(
        JSON.stringify({
          version: definition.version,
          schema: definition.schema,
          instructions: definition.instructions,
          envelope: profile,
        }),
      )
      .digest('hex');
  }
  prepareTextRequest(context: unknown): PreparedTextRequest | undefined {
    if (!this.profile.estimation) return undefined;
    const body = buildAuthoringTextRequestBody(this.definition, this.profile, context);
    const { pricing, ...profile } = this.profile;
    return {
      body,
      snapshot: estimateTextRequest(
        body,
        {
          ...profile,
          ...(pricing?.source
            ? {
                pricing: {
                  source: pricing.source,
                  reviewedAt: pricing.reviewedAt,
                  validUntil: pricing.validUntil,
                },
              }
            : {}),
        },
        this.version,
      ),
    };
  }
  async generate(request: AuthoringTextRequest): Promise<AuthoringTextResult> {
    if (!this.apiKey) throw new ProviderFailure('LIVE_TEST_AUTHORIZED_KEY_REQUIRED', false);
    if (
      this.profile.pricing &&
      !(
        Date.parse(this.profile.pricing.reviewedAt) <= Date.now() &&
        Date.parse(this.profile.pricing.validUntil) > Date.now()
      )
    )
      throw new ProviderFailure('GENERATION_PRICING_EXPIRED', false);
    const body = buildAuthoringTextRequestBody(this.definition, this.profile, request.context);
    if (this.profile.contextBudgetTokens !== undefined) {
      try {
        assertTextContext(measureTextContext(body, this.profile));
      } catch {
        throw new ProviderFailure('TEXT_CONTEXT_WINDOW_EXCEEDED', false);
      }
    }
    if (Buffer.byteLength(body) > this.profile.maxInputBytes)
      throw new ProviderFailure('AUTHORING_CONTEXT_TOO_LARGE', false);
    let snapshot: TextReserveSnapshot | undefined;
    if (this.profile.estimation) {
      const prepared = this.prepareTextRequest(request.context)!;
      const pinned = request.textReservationSnapshot;
      if (
        !pinned ||
        pinned.fingerprint !== prepared.snapshot.fingerprint ||
        estimateFingerprint(pinned) !== estimateFingerprint(prepared.snapshot) ||
        pinned.bodySha256 !== prepared.snapshot.bodySha256 ||
        pinned.reserveMicros !== prepared.snapshot.reserveMicros ||
        prepared.body !== body
      )
        throw new ProviderFailure('PROVIDER_REQUEST_SNAPSHOT_CHANGED', false);
      snapshot = prepared.snapshot;
      if (request.maxCostMicros === undefined || snapshot.reserveMicros > request.maxCostMicros)
        throw new ProviderFailure('PROVIDER_BUDGET_TOO_SMALL', false);
    }
    let response: Response;
    try {
      response = await this.transport('https://api.openai.com/v1/responses', {
        method: 'POST',
        redirect: 'error',
        signal: request.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          'X-Client-Request-Id': request.jobId,
        },
        body,
      });
    } catch {
      throw new ProviderFailure('PROVIDER_OUTCOME_UNKNOWN', true);
    }
    const headerRequestId = response.headers.get('x-request-id');
    const requestId =
      headerRequestId && /^[A-Za-z0-9._:-]{1,200}$/.test(headerRequestId)
        ? headerRequestId
        : undefined;
    if (!response.ok || !response.body)
      throw new ProviderFailure(
        response.status === 403 ? 'PROVIDER_HTTP_403' : 'PROVIDER_RESPONSE_FAILED',
        true,
        requestId,
      );
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 128000) {
          await reader.cancel();
          throw new Error('limit');
        }
        chunks.push(part.value);
      }
    } catch {
      throw new ProviderFailure('PROVIDER_OUTCOME_UNKNOWN', true);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ProviderFailure('PROVIDER_USAGE_UNKNOWN', true);
    }
    const parsed = z
      .object({
        id: z.string().min(1).max(200),
        status: z.string(),
        service_tier: z.string(),
        usage: z
          .object({
            input_tokens: z.number().int().nonnegative().max(10000000),
            output_tokens: z.number().int().nonnegative().max(10000000),
            input_tokens_details: z
              .object({
                cached_tokens: z.number().int().nonnegative().max(10000000).optional(),
                cache_write_tokens: z.number().int().nonnegative().max(10000000).optional(),
                cache_write_tokens_details: z
                  .object({
                    ttl_30m_tokens: z.number().int().nonnegative(),
                    ttl_12h_tokens: z.number().int().nonnegative(),
                  })
                  .optional(),
              })
              .refine(
                (d) =>
                  !d.cache_write_tokens_details ||
                  d.cache_write_tokens_details.ttl_30m_tokens +
                    d.cache_write_tokens_details.ttl_12h_tokens ===
                    d.cache_write_tokens,
              )
              .optional(),
          })
          .refine(
            (u) =>
              (u.input_tokens_details?.cached_tokens ?? 0) +
                (u.input_tokens_details?.cache_write_tokens ?? 0) <=
              u.input_tokens,
          ),
        output: z.array(z.unknown()),
      })
      .safeParse(raw);
    if (!parsed.success) throw new ProviderFailure('PROVIDER_USAGE_UNKNOWN', true);
    const value = parsed.data;
    if (value.service_tier !== 'default')
      throw new ProviderFailure('PROVIDER_TIER_UNKNOWN', true, value.id);
    const details = value.usage.input_tokens_details;
    if (
      this.profile.cachePricing &&
      (details?.cached_tokens === undefined || details.cache_write_tokens === undefined)
    )
      throw new ProviderFailure('PROVIDER_USAGE_UNKNOWN', true, value.id);
    const tokenUsage = {
      inputTokens: value.usage.input_tokens,
      outputTokens: value.usage.output_tokens,
      cachedInputTokens: details?.cached_tokens ?? 0,
      cacheWriteInputTokens: details?.cache_write_tokens ?? 0,
      ...(details?.cache_write_tokens_details || this.profile.cachePricing
        ? {
            cacheWriteInputTokensDetails: {
              ttl30mTokens:
                details?.cache_write_tokens_details?.ttl_30m_tokens ??
                details?.cache_write_tokens ??
                0,
              ttl12hTokens: details?.cache_write_tokens_details?.ttl_12h_tokens ?? 0,
            },
          }
        : {}),
    };
    const usage = {
      ...tokenUsage,
      ...textUsageCostMicros(this.profile, tokenUsage),
      costEvidence: 'configured_rates' as const,
    };
    const { costMicros } = usage;
    const failed = (failureCode: string): AuthoringTextResult => ({
      requestId: value.id,
      usage,
      proposal: null,
      failureCode,
    });
    if (
      (this.profile.contextBudgetTokens !== undefined &&
        value.usage.input_tokens + this.profile.maxOutputTokens >
          Math.min(this.profile.contextBudgetTokens, this.profile.contextTokens)) ||
      value.usage.input_tokens > this.profile.contextTokens ||
      value.usage.output_tokens > this.profile.maxOutputTokens
    )
      return failed('PROVIDER_LIMIT_VIOLATION');
    if (snapshot && costMicros > snapshot.reserveMicros) return failed('PROVIDER_RESERVE_EXCEEDED');
    if (value.status !== 'completed') return failed('PROVIDER_INCOMPLETE');
    const texts: string[] = [];
    for (const output of value.output) {
      const message = z
        .object({ type: z.literal('message'), content: z.array(z.unknown()) })
        .safeParse(output);
      if (!message.success) continue;
      for (const c of message.data.content) {
        const part = z.object({ type: z.literal('output_text'), text: z.string() }).safeParse(c);
        if (part.success) texts.push(part.data.text);
      }
    }
    let proposal: unknown;
    try {
      proposal = JSON.parse(texts.join(''));
    } catch {
      return failed('PROVIDER_INVALID_RESULT');
    }
    return { proposal, requestId: value.id, usage };
  }
}
