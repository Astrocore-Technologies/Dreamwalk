import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ProviderFailure } from '../ai/types';
import { LIVE_TEXT } from './config';
export interface AuthoringTextResult {
  proposal: unknown;
  requestId: string;
  failureCode?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
    costEvidence: 'configured_rates' | 'reported';
  };
}
export interface AuthoringTextProvider {
  readonly version: string;
  generate(request: {
    jobId: string;
    context: unknown;
    signal: AbortSignal;
  }): Promise<AuthoringTextResult>;
}
export interface AuthoringTextDefinition {
  version: string;
  schema: Record<string, unknown>;
  instructions: string;
  validateProposal(value: unknown): unknown;
}
/** Separate private-authoring adapter: no NPC/world schemas or authoritative game effects. */
export class BoundedAuthoringTextProvider implements AuthoringTextProvider {
  readonly version: string;
  constructor(
    private definition: AuthoringTextDefinition,
    private apiKey: string | undefined,
    private transport: typeof fetch = fetch,
  ) {
    this.version = createHash('sha256')
      .update(
        JSON.stringify({
          version: definition.version,
          schema: definition.schema,
          instructions: definition.instructions,
          envelope: LIVE_TEXT,
        }),
      )
      .digest('hex');
  }
  async generate(request: {
    jobId: string;
    context: unknown;
    signal: AbortSignal;
  }): Promise<AuthoringTextResult> {
    if (!this.apiKey) throw new ProviderFailure('LIVE_TEST_AUTHORIZED_KEY_REQUIRED', false);
    const body = JSON.stringify({
      model: LIVE_TEXT.model,
      service_tier: 'default',
      store: false,
      stream: false,
      reasoning: { effort: 'none' },
      max_output_tokens: LIVE_TEXT.maxOutputTokens,
      instructions: this.definition.instructions,
      input: JSON.stringify(request.context),
      text: {
        format: {
          type: 'json_schema',
          name: 'private_location_layout',
          strict: true,
          schema: this.definition.schema,
        },
      },
    });
    if (Buffer.byteLength(body) > LIVE_TEXT.maxInputBytes)
      throw new ProviderFailure('AUTHORING_CONTEXT_TOO_LARGE', false);
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
        usage: z.object({
          input_tokens: z.number().int().nonnegative().max(10000000),
          output_tokens: z.number().int().nonnegative().max(10000000),
        }),
        output: z.array(z.unknown()),
      })
      .safeParse(raw);
    if (!parsed.success) throw new ProviderFailure('PROVIDER_USAGE_UNKNOWN', true);
    const value = parsed.data;
    if (value.service_tier !== 'default')
      throw new ProviderFailure('PROVIDER_TIER_UNKNOWN', true, value.id);
    const costMicros = Number(
      (BigInt(value.usage.input_tokens) * BigInt(LIVE_TEXT.inputMicrosPerMillion) +
        BigInt(value.usage.output_tokens) * BigInt(LIVE_TEXT.outputMicrosPerMillion) +
        999999n) /
        1000000n,
    );
    const usage = {
      inputTokens: value.usage.input_tokens,
      outputTokens: value.usage.output_tokens,
      costMicros,
      costEvidence: 'configured_rates' as const,
    };
    const failed = (failureCode: string): AuthoringTextResult => ({
      requestId: value.id,
      usage,
      proposal: null,
      failureCode,
    });
    if (
      value.usage.input_tokens > LIVE_TEXT.contextTokens ||
      value.usage.output_tokens > LIVE_TEXT.maxOutputTokens
    )
      return failed('PROVIDER_LIMIT_VIOLATION');
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
