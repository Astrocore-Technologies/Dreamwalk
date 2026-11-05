import { digest } from '../ai/context';
import { fail } from '../errors';

export type StoryKnownCostAcceptance = {
  version: 'known-cost-v1';
  sourceId: string;
  quoteId: string;
  quoteFingerprint: string;
};
type Quote = { id: string; automaticKnownCostPolicy?: unknown };
/** The existing confirmation supplies the policy. Never infer it from quote availability. */
export function acceptStoryKnownCostPolicy(
  quote: Quote,
  sourceId: string,
  policy: 'known-cost-v1' | undefined,
): StoryKnownCostAcceptance | undefined {
  if (!policy) return undefined;
  if (quote.automaticKnownCostPolicy !== policy)
    fail(409, 'GENERATION_SETTLEMENT_POLICY_MISMATCH', 'GENERATION_SETTLEMENT_POLICY_MISMATCH');
  return { version: policy, sourceId, quoteId: quote.id, quoteFingerprint: digest(quote) };
}
/** Persist outside the provider context so its original native quote digest stays unchanged. */
export function acceptedStoryKnownCostPolicy(
  quote: Quote,
  sourceId: string,
  acceptance: StoryKnownCostAcceptance | undefined,
): 'known-cost-v1' | undefined {
  if (
    acceptance?.version !== 'known-cost-v1' ||
    quote.automaticKnownCostPolicy !== 'known-cost-v1' ||
    acceptance.sourceId !== sourceId ||
    acceptance.quoteId !== quote.id ||
    acceptance.quoteFingerprint !== digest(quote)
  )
    return undefined;
  return 'known-cost-v1';
}
