import { z } from 'zod';
import { OpenAiNpcProvider } from './openai-provider';
import { HttpJsonNpcProvider, MockNpcProvider } from './provider';
import type { AiPolicy, NpcProvider } from './types';
const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');
/** Server-only configuration. Merely selecting an adapter does not authorize a request. */
export function readNpcAiConfiguration(env: NodeJS.ProcessEnv = process.env): {
  provider: NpcProvider;
  policy: Partial<AiPolicy>;
} {
  const c = z
    .object({
      NPC_AI_PROVIDER: z.enum(['mock', 'http-json', 'openai-responses']).default('mock'),
      NPC_AI_EXTERNAL_APPROVED: flag,
      NPC_AI_COST_CEILING_ATTESTED: flag,
      NPC_AI_PRICING_VERIFIED: flag,
      NPC_AI_KILL_SWITCH: flag,
      NPC_AI_ENDPOINT: z.string().url().optional(),
      NPC_AI_ALLOWED_ORIGINS: z.string().default(''),
      NPC_AI_API_KEY: z.string().min(1).optional(),
      NPC_AI_MODEL: z.string().min(1).optional(),
      NPC_AI_INPUT_MICROS_PER_MILLION: z.coerce.number().int().positive().optional(),
      NPC_AI_OUTPUT_MICROS_PER_MILLION: z.coerce.number().int().positive().optional(),
      NPC_AI_VERSION: z.string().min(1).default('npc-ai-v1'),
      NPC_AI_CREDIT_PRICE: z.coerce.number().int().min(0).max(100000).default(0),
      NPC_AI_UPPER_MICROS: z.coerce.number().int().min(0).max(100000000).default(0),
      NPC_AI_CAP_MICROS: z.coerce.number().int().min(0).max(1000000000000).default(0),
      NPC_AI_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(8000),
      NPC_AI_MAX_INPUT_TOKENS: z.coerce.number().int().min(1).max(100000).default(16000),
      NPC_AI_MAX_INPUT_BYTES: z.coerce.number().int().min(1024).max(64000).default(64000),
      NPC_AI_SERVICE_TIER: z.literal('default').optional(),
      NPC_AI_REASONING_EFFORT: z.literal('none').optional(),
      NPC_AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(32000).default(1024),
    })
    .parse(env);
  if (c.NPC_AI_PROVIDER === 'mock') {
    if (
      c.NPC_AI_EXTERNAL_APPROVED ||
      c.NPC_AI_CREDIT_PRICE ||
      c.NPC_AI_UPPER_MICROS ||
      c.NPC_AI_CAP_MICROS
    )
      throw new Error('MOCK_REQUIRES_ZERO_SPEND');
    return {
      provider: new MockNpcProvider(),
      policy: { killSwitch: c.NPC_AI_KILL_SWITCH, version: c.NPC_AI_VERSION },
    };
  }
  if (!c.NPC_AI_MODEL) throw new Error('NPC_AI_MODEL_REQUIRED');
  if (c.NPC_AI_PROVIDER === 'http-json' && !c.NPC_AI_ENDPOINT)
    throw new Error('NPC_AI_ENDPOINT_REQUIRED');
  if (
    c.NPC_AI_EXTERNAL_APPROVED &&
    ((c.NPC_AI_PROVIDER === 'openai-responses'
      ? !c.NPC_AI_PRICING_VERIFIED
      : !c.NPC_AI_COST_CEILING_ATTESTED) ||
      !c.NPC_AI_API_KEY ||
      c.NPC_AI_UPPER_MICROS <= 0 ||
      c.NPC_AI_CAP_MICROS < c.NPC_AI_UPPER_MICROS)
  )
    throw new Error('NPC_AI_APPROVAL_REQUIRES_BOUNDED_BUDGET_AND_CREDENTIALS');
  if (
    c.NPC_AI_PROVIDER === 'openai-responses' &&
    (!c.NPC_AI_INPUT_MICROS_PER_MILLION || !c.NPC_AI_OUTPUT_MICROS_PER_MILLION)
  )
    throw new Error('NPC_AI_VERIFIED_RATES_REQUIRED');
  const provider =
    c.NPC_AI_PROVIDER === 'openai-responses'
      ? new OpenAiNpcProvider({
          enabled: c.NPC_AI_EXTERNAL_APPROVED,
          apiKey: c.NPC_AI_API_KEY,
          model: c.NPC_AI_MODEL,
          version: c.NPC_AI_VERSION,
          maxInputBytes: c.NPC_AI_MAX_INPUT_BYTES,
          serviceTier: c.NPC_AI_SERVICE_TIER,
          reasoningEffort: c.NPC_AI_REASONING_EFFORT,
          maxResponseBytes: 128000,
          maxOutputTokens: c.NPC_AI_MAX_OUTPUT_TOKENS,
          inputMicrosPerMillion: c.NPC_AI_INPUT_MICROS_PER_MILLION!,
          outputMicrosPerMillion: c.NPC_AI_OUTPUT_MICROS_PER_MILLION!,
        })
      : new HttpJsonNpcProvider({
          enabled: c.NPC_AI_EXTERNAL_APPROVED,
          endpoint: c.NPC_AI_ENDPOINT!,
          allowedOrigins: c.NPC_AI_ALLOWED_ORIGINS.split(',')
            .map((v) => v.trim())
            .filter(Boolean),
          apiKey: c.NPC_AI_API_KEY,
          model: c.NPC_AI_MODEL,
          version: c.NPC_AI_VERSION,
          enforcesCostCeiling: c.NPC_AI_COST_CEILING_ATTESTED,
          maxInputTokens: c.NPC_AI_MAX_INPUT_TOKENS,
          maxOutputTokens: c.NPC_AI_MAX_OUTPUT_TOKENS,
        });
  return {
    provider,
    policy: {
      externalApproved: c.NPC_AI_EXTERNAL_APPROVED,
      killSwitch: c.NPC_AI_KILL_SWITCH,
      creditPrice: c.NPC_AI_CREDIT_PRICE,
      providerUpperMicros: c.NPC_AI_UPPER_MICROS,
      providerCapMicros: c.NPC_AI_CAP_MICROS,
      timeoutMs: c.NPC_AI_TIMEOUT_MS,
      version: c.NPC_AI_VERSION,
    },
  };
}
