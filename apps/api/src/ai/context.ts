import { createHash } from 'node:crypto';
import type { DecisionContext } from './types';
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
/** Only accept contexts constructed by the game core. This is a size/format boundary, not an ACL. */
export function validateDecisionContext(
  context: DecisionContext,
  maxBytes: number,
): DecisionContext {
  if (
    !context ||
    typeof context !== 'object' ||
    Array.isArray(context) ||
    typeof context.contextHash !== 'string' ||
    !context.contextHash ||
    context.contextHash.length > 200 ||
    Buffer.byteLength(JSON.stringify(context)) > maxBytes
  )
    throw new Error('INVALID_DECISION_CONTEXT');
  return structuredClone(context);
}
export function cacheKey(
  scope: { campaignId: string; npcId: string; purpose: string },
  context: DecisionContext,
  provider: string,
  providerVersion: string,
  policyVersion: string,
): string {
  return digest({
    ...scope,
    contextHash: context.contextHash,
    inputHash: digest(context),
    provider,
    providerVersion,
    policyVersion,
  });
}
