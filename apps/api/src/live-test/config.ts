import { z } from 'zod';
export const LIVE_TEXT = Object.freeze({
  model: 'gpt-6-luna',
  contextTokens: 1050000,
  maxOutputTokens: 2048,
  maxInputBytes: 64000,
  inputMicrosPerMillion: 250000,
  outputMicrosPerMillion: 750000,
  upperMicros: 264036,
  capMicros: 1000000,
  scopeId: 'manual-live-test-20261031',
  pricingSource: 'https://developers.openai.com/api/docs/models/gpt-6-luna',
});
export interface LiveTestConfig {
  enabled: boolean;
  sessionId?: string;
  ownerId?: string;
  expiresAt?: Date;
  estimateRiskApproved?: boolean;
}
export function readLiveTestConfig(env: NodeJS.ProcessEnv = process.env): LiveTestConfig {
  if (env.LIVE_TEST_ENABLED !== 'true') return { enabled: false };
  const sessionId = z.uuid().parse(env.LIVE_TEST_SESSION_ID);
  const ownerId = z.uuid().parse(env.LIVE_TEST_OWNER_ID);
  const expiresAt = new Date(z.iso.datetime().parse(env.LIVE_TEST_EXPIRES_AT));
  if (expiresAt.getTime() > Date.now() + 2 * 3600000) throw new Error('LIVE_TEST_EXPIRY_TOO_LONG');
  return {
    enabled: true,
    sessionId,
    ownerId,
    expiresAt,
    estimateRiskApproved: env.IMAGE_ESTIMATE_RISK_APPROVED === 'true',
  };
}
