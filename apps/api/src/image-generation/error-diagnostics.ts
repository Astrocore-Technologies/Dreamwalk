/** Provider-reported diagnostics, never verified root cause or billing evidence. */
export interface SafeImageDiagnostic {
  httpStatus: number;
  requestId?: string;
  providerCode?: string;
  providerType?: string;
  category?:
    | 'organization_verification'
    | 'model_access'
    | 'permission_scope'
    | 'authentication'
    | 'rate_limit';
  message?: string;
  evidence: 'provider_reported';
  billing: 'unknown';
}
const codes = new Set([
  'organization_verification_required',
  'model_not_found',
  'model_access_denied',
  'insufficient_permissions',
  'permission_denied',
  'invalid_api_key',
  'rate_limit_exceeded',
  'insufficient_quota',
]);
const categoryByCode: Record<string, NonNullable<SafeImageDiagnostic['category']>> = {
  organization_verification_required: 'organization_verification',
  model_not_found: 'model_access',
  model_access_denied: 'model_access',
  insufficient_permissions: 'permission_scope',
  permission_denied: 'permission_scope',
  invalid_api_key: 'authentication',
  rate_limit_exceeded: 'rate_limit',
  insufficient_quota: 'rate_limit',
};
const safeRequestId = (value: unknown): value is string =>
  typeof value === 'string' && /^req_[a-zA-Z0-9_-]{1,160}$/.test(value) && !/sk-/i.test(value);
const types = new Set([
  'invalid_request_error',
  'permission_error',
  'authentication_error',
  'rate_limit_error',
]);
const messages = {
  organization_verification: 'The provider reports an organization verification requirement.',
  model_access: 'The provider reports that the requested model is unavailable or inaccessible.',
  permission_scope: 'The provider reports insufficient permissions or scope.',
  authentication: 'The provider reports an authentication problem.',
  rate_limit: 'The provider reports a rate or quota restriction.',
} as const;
/** Reconstruct from scalar allowlists even when reading persisted or injected diagnostics. */
export function normalizeSafeImageDiagnostic(value: unknown): SafeImageDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (!Number.isInteger(v.httpStatus) || Number(v.httpStatus) < 100 || Number(v.httpStatus) > 599)
    return undefined;
  const result: SafeImageDiagnostic = {
    httpStatus: Number(v.httpStatus),
    evidence: 'provider_reported',
    billing: 'unknown',
  };
  if (safeRequestId(v.requestId)) result.requestId = v.requestId;
  if (typeof v.providerCode === 'string' && codes.has(v.providerCode))
    result.providerCode = v.providerCode;
  if (typeof v.providerType === 'string' && types.has(v.providerType))
    result.providerType = v.providerType;
  if (typeof v.category === 'string' && Object.hasOwn(messages, v.category)) {
    result.category = v.category as keyof typeof messages;
    result.message = messages[result.category];
  }
  return result;
}
export class ImageProviderFailure extends Error {
  readonly outcomeUnknown = true;
  constructor(readonly diagnostic: SafeImageDiagnostic) {
    super('PROVIDER_RESULT_UNKNOWN');
    this.name = 'ImageProviderFailure';
  }
}
export async function safeImageErrorDiagnostic(response: Response): Promise<SafeImageDiagnostic> {
  const requestId = response.headers.get('x-request-id');
  const safe: SafeImageDiagnostic = {
    httpStatus: response.status,
    ...(safeRequestId(requestId) ? { requestId } : {}),
    evidence: 'provider_reported',
    billing: 'unknown',
  };
  if (!response.body) return safe;
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    const read = async () => {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 8192) throw new Error('BOUNDED_DIAGNOSTIC');
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    };
    const value = await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DIAGNOSTIC_TIMEOUT')), 2000);
      }),
    ]);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return safe;
    const error = (value as { error?: unknown }).error;
    if (!error || typeof error !== 'object' || Array.isArray(error)) return safe;
    const data = error as { code?: unknown; type?: unknown; message?: unknown };
    if (typeof data.code === 'string' && codes.has(data.code)) safe.providerCode = data.code;
    if (typeof data.type === 'string' && types.has(data.type)) safe.providerType = data.type;
    // Only classify known language. Never return any raw message, even after regex redaction.
    const text = typeof data.message === 'string' ? data.message.toLowerCase() : '';
    const code = safe.providerCode;
    const category =
      (code ? categoryByCode[code] : undefined) ??
      (/organization.{0,30}(must be verified|verification required|not verified)/.test(text)
        ? 'organization_verification'
        : /model.{0,80}(does not exist|do not have access|not have access)/.test(text)
          ? 'model_access'
          : /insufficient (permissions|scope)|missing (permissions|scopes)/.test(text)
            ? 'permission_scope'
            : undefined);
    if (category) {
      safe.category = category;
      safe.message = messages[category];
    }
    return safe;
  } catch {
    return safe;
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}
