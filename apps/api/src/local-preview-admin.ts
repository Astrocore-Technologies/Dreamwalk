import type { Request } from 'express';
import { z } from 'zod';

// An operator-created account in an isolated local preview, never a public seed.
export const LOCAL_PREVIEW_ADMIN_EMAIL = 'local-preview-admin@dreamwalk.test';
export const LOCAL_PREVIEW_ADMIN_AUDIT = 'local_preview_admin.created';
const localLoginSchema = z
  .object({ email: z.literal('admin'), password: z.string().min(1).max(128) })
  .strict();
type LocalRequest = Pick<Request, 'headers' | 'socket'>;
type LocalConfig = { NODE_ENV: string; WEB_ORIGIN: string };
function loopbackAddress(value: string | undefined) {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}
function loopbackUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
export function localPreviewAdminEnabled(
  req: LocalRequest,
  settings: LocalConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (
    env.LOCAL_PREVIEW_TEST_ADMIN_ENABLED !== 'true' ||
    settings.NODE_ENV === 'production' ||
    !loopbackUrl(settings.WEB_ORIGIN) ||
    !loopbackAddress(req.socket.localAddress) ||
    !loopbackAddress(req.socket.remoteAddress)
  )
    return false;
  const host = req.headers.host;
  if (!host || !loopbackUrl(`http://${host}`)) return false;
  const forwardedHost = req.headers['x-forwarded-host'];
  if (
    forwardedHost &&
    (typeof forwardedHost !== 'string' || !loopbackUrl(`http://${forwardedHost}`))
  )
    return false;
  const origin = req.headers.origin;
  return !origin || origin === new URL(settings.WEB_ORIGIN).origin;
}
export function localPreviewLogin(body: unknown, enabled: boolean) {
  if (
    !enabled ||
    typeof body !== 'object' ||
    body === null ||
    !('email' in body) ||
    body.email !== 'admin'
  )
    return null;
  const parsed = localLoginSchema.parse(body);
  return { email: LOCAL_PREVIEW_ADMIN_EMAIL, password: parsed.password };
}
