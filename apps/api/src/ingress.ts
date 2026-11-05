import { timingSafeEqual } from 'node:crypto';

// The owner approved restoring origin protection after custom-domain setup.
// Keep the HTTP and WebSocket policy aligned with the hosted web relay.
export const ENFORCE_BROWSER_ORIGIN = true;

/** Hosted mutations require the stable web-to-API origin, never an absent one. */
export function requestOriginAllowed(
  origin: string | string[] | undefined,
  expected: string,
  requireOrigin: boolean,
) {
  return origin === expected || (!requireOrigin && origin === undefined);
}

/** An extra transport gate, never a replacement for user/session/asset authorization. */
export function ingressAllowed(
  value: string | string[] | undefined,
  secret: string | undefined,
  required: boolean,
) {
  if (!secret) return !required;
  if (typeof value !== 'string') return false;
  const received = Buffer.from(value),
    expected = Buffer.from(secret);
  return received.length === expected.length && timingSafeEqual(received, expected);
}
