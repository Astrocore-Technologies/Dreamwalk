/** Provider-independent context accounting. No network, secrets, prices or persistent mutations. */
export const MAX_REQUEST_CONTEXT_TOKENS = 256000;
export const TEXT_CONTEXT_TRANSPORT_BYTES = 4194304;
export interface TextModelCapabilities {
  model: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
}
export interface TextTokenCounter {
  readonly id: string;
  readonly precision: 'exact' | 'conservative_estimate';
  supports(model: string): boolean;
  /** Count the complete provider envelope, including instructions/schema/protocol. */
  countInput(serializedBody: string, model: string): number;
}
export interface TextContextPolicy {
  contextTokens: number;
  contextBudgetTokens?: number;
  maxOutputTokens: number;
  model: string;
  maxInputBytes: number;
  estimation?: { textProtocolTokens: number };
}
export interface TextContextMeasurement {
  schemaVersion: 1;
  requestedContextTokens: number;
  effectiveContextTokens: number;
  modelContextTokens: number;
  reservedOutputTokens: number;
  inputTokens: number;
  totalTokens: number;
  counterId: string;
  precision: 'exact' | 'conservative_estimate';
  protocolTokenAllowance: number;
  serializedBytes: number;
  transportLimitBytes: number;
}
export function contextWindow(policy: TextContextPolicy, capabilities?: TextModelCapabilities) {
  const modelContextTokens = Math.min(
    policy.contextTokens,
    capabilities?.contextWindowTokens ?? policy.contextTokens,
  );
  const requestedContextTokens = policy.contextBudgetTokens ?? modelContextTokens;
  const effectiveContextTokens = Math.min(requestedContextTokens, modelContextTokens);
  if (
    ![modelContextTokens, requestedContextTokens, policy.maxOutputTokens].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    (policy.contextBudgetTokens !== undefined &&
      requestedContextTokens > MAX_REQUEST_CONTEXT_TOKENS) ||
    policy.maxOutputTokens >= effectiveContextTokens ||
    policy.maxOutputTokens > (capabilities?.maxOutputTokens ?? 32000)
  )
    throw new Error('TEXT_CONTEXT_POLICY_INVALID');
  return {
    requestedContextTokens,
    effectiveContextTokens,
    modelContextTokens,
    reservedOutputTokens: policy.maxOutputTokens,
  };
}
export function measureTextContext(
  body: string,
  policy: TextContextPolicy,
  counter?: TextTokenCounter,
  capabilities?: TextModelCapabilities,
): TextContextMeasurement {
  const window = contextWindow(policy, capabilities);
  const exact = counter?.supports(policy.model) ? counter : undefined;
  const serializedBytes = Buffer.byteLength(body, 'utf8');
  // Explicit conservative fallback, NOT a tokenizer or guaranteed provider token bound.
  const protocolTokenAllowance = exact
    ? 0
    : Math.max(4096, policy.estimation?.textProtocolTokens ?? 0);
  const inputTokens = exact
    ? exact.countInput(body, policy.model)
    : serializedBytes + protocolTokenAllowance;
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(inputTokens + policy.maxOutputTokens)
  )
    throw new Error('TEXT_TOKEN_COUNT_INVALID');
  return {
    schemaVersion: 1,
    ...window,
    inputTokens,
    totalTokens: inputTokens + policy.maxOutputTokens,
    counterId: exact?.id ?? 'utf8-envelope-plus-protocol-v1',
    precision: exact?.precision ?? 'conservative_estimate',
    protocolTokenAllowance,
    serializedBytes,
    transportLimitBytes: policy.maxInputBytes,
  };
}
export function assertTextContext(measurement: TextContextMeasurement) {
  if (measurement.serializedBytes > measurement.transportLimitBytes)
    throw new Error('TEXT_CONTEXT_TRANSPORT_LIMIT');
  if (measurement.totalTokens > measurement.effectiveContextTokens)
    throw new Error('TEXT_CONTEXT_WINDOW_EXCEEDED');
  return measurement;
}
