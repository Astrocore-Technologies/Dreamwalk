import { timingSafeEqual } from 'node:crypto';

// Owner-approved temporary pause until domain setup is complete. Match the web
// policy and re-enable only after explicit approval and HTTP/WS verification.
export const ENFORCE_BROWSER_ORIGIN = false;

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
