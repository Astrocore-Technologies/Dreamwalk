import { z } from 'zod';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import {
  ProviderFailure,
  type NpcProvider,
  type ProviderRequest,
  type ProviderResult,
} from './types';

const resultSchema = z
  .object({
    proposal: z.unknown(),
    requestId: z.string().min(1).max(200),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().max(10000000),
        outputTokens: z.number().int().nonnegative().max(10000000),
        costMicros: z.number().int().nonnegative().safe(),
      })
      .strict(),
  })
  .strict();
export function validateProviderResult(value: unknown): ProviderResult {
  return resultSchema.parse(value);
}
/** No external network. Supplies a context-derived proposal prepared by the rules core. */
export class MockNpcProvider implements NpcProvider {
  readonly id = 'mock';
  readonly version = 'mock-v1';
  readonly external = false;
  constructor(
    private options: {
      delayMs?: number;
      failure?: 'known' | 'uncertain';
      costMicros?: number;
      proposal?: unknown;
    } = {},
  ) {}
  async generate(request: ProviderRequest): Promise<ProviderResult> {
    if (this.options.delayMs)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.options.delayMs);
        request.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new ProviderFailure('PROVIDER_TIMEOUT', true));
          },
          { once: true },
        );
      });
    if (request.signal.aborted) throw new ProviderFailure('PROVIDER_TIMEOUT', true);
    if (this.options.failure)
      throw new ProviderFailure('MOCK_FAILURE', this.options.failure === 'uncertain');
    return {
      proposal: this.options.proposal ??
        request.context.mockProposal ?? { actions: [{ kind: 'wait' }] },
      requestId: `mock-${request.jobId}`,
      usage: { inputTokens: 0, outputTokens: 0, costMicros: this.options.costMicros ?? 0 },
    };
  }
}
export interface HttpProviderConfig {
  enabled: boolean;
  endpoint: string;
  allowedOrigins: string[];
  apiKey?: string;
  model: string;
  version: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** Operator attests the trusted adapter endpoint enforces transmitted token/cost ceilings. */
  enforcesCostCeiling?: boolean;
  maxInputBytes?: number;
  maxOutputBytes?: number;
}
/** Generic JSON adapter boundary, not a claim that an unverified vendor schema is interchangeable.
 * Server-owned adapter endpoints accept {model,purpose,context,operationId} and return ProviderResult.
 * Never configured from a player payload. Redirects and literal/private hosts are forbidden.
 */
export class HttpJsonNpcProvider implements NpcProvider {
  readonly id = 'http-json';
  readonly external = true;
  readonly version: string;
  private endpoint: URL;
  constructor(
    private settings: HttpProviderConfig,
    private transport: typeof fetch = fetch,
  ) {
    for (const limit of [
      settings.maxInputBytes ?? 64000,
      settings.maxOutputBytes ?? 32000,
      settings.maxInputTokens ?? 16000,
      settings.maxOutputTokens ?? 1024,
    ]) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000000)
        throw new Error('INVALID_PROVIDER_CONFIGURATION');
    }
    this.version =
      settings.version +
      ':' +
      createHash('sha256')
        .update(
          JSON.stringify({
            endpoint: settings.endpoint,
            model: settings.model,
            maxInputTokens: settings.maxInputTokens ?? 16000,
            maxOutputTokens: settings.maxOutputTokens ?? 1024,
          }),
        )
        .digest('hex')
        .slice(0, 16);
    this.endpoint = new URL(settings.endpoint);
    const host = this.endpoint.hostname;
    if (
      this.endpoint.protocol !== 'https:' ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.hash ||
      this.endpoint.search ||
      !settings.allowedOrigins.includes(this.endpoint.origin) ||
      /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host) ||
      isIP(host.replace(/^\[|\]$/g, '')) !== 0 ||
      !settings.model.trim() ||
      !settings.version.trim()
    )
      throw new Error('INVALID_PROVIDER_CONFIGURATION');
  }
  async generate(request: ProviderRequest): Promise<ProviderResult> {
    if (!this.settings.enabled || !this.settings.apiKey || !this.settings.enforcesCostCeiling)
      throw new ProviderFailure('PROVIDER_DISABLED', false);
    const body = JSON.stringify({
      model: this.settings.model,
      purpose: request.purpose,
      context: request.context,
      operationId: request.jobId,
      limits: {
        maxInputTokens: this.settings.maxInputTokens ?? 16000,
        maxOutputTokens: this.settings.maxOutputTokens ?? 1024,
        maxCostMicros: request.maxCostMicros,
      },
    });
    if (Buffer.byteLength(body) > (this.settings.maxInputBytes ?? 64000))
      throw new ProviderFailure('CONTEXT_TOO_LARGE', false);
    let response: Response;
    try {
      response = await this.transport(this.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: request.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.settings.apiKey}`,
          'idempotency-key': request.jobId,
        },
        body,
      });
    } catch {
      throw new ProviderFailure('PROVIDER_OUTCOME_UNKNOWN', true);
    }
    // A failed HTTP response can still have incurred provider cost; never blindly retry it.
    if (!response.ok || !response.body) throw new ProviderFailure('PROVIDER_RESPONSE_FAILED', true);
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > (this.settings.maxOutputBytes ?? 32000)) {
          await reader.cancel();
          throw new ProviderFailure('PROVIDER_RESULT_TOO_LARGE', true);
        }
        chunks.push(value);
      }
      return validateProviderResult(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (e) {
      if (e instanceof ProviderFailure) throw e;
      throw new ProviderFailure('PROVIDER_INVALID_RESULT', true);
    }
  }
}
