import { NextRequest, NextResponse } from 'next/server';
import { trustedBrowserOrigin, canonicalWebOrigin } from './lib/hosted-origin';

export function proxy(request: NextRequest) {
  if (process.env.VERCEL !== '1') return NextResponse.next();
  const secret = process.env.DREAMWALK_INGRESS_SECRET;
  const origin = process.env.API_URL;
  if (!secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret) || !origin) {
    return new NextResponse('Service unavailable', { status: 503 });
  }
  // The local route owns WebSocket admission and injects its own upstream secret.
  if (request.nextUrl.pathname === '/api/v1/game/socket') return NextResponse.next();
  const target = new URL(origin);
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.pathname !== '/' ||
    target.search ||
    target.hash
  )
    return new NextResponse('Service unavailable', { status: 503 });
  target.pathname = request.nextUrl.pathname;
  target.search = request.nextUrl.search;
  // Temporary share/bypass URL credentials must stop at the platform boundary.
  target.searchParams.delete('x-vercel-protection-bypass');
  target.searchParams.delete('x-vercel-set-bypass-cookie');
  target.searchParams.delete('_vercel_share');
  const headers = new Headers(request.headers);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const canonical = canonicalWebOrigin(process.env);
    if (!canonical) return new NextResponse('Service unavailable', { status: 503 });
    if (!trustedBrowserOrigin(request, process.env))
      return NextResponse.json(
        { code: 'FORBIDDEN', message: 'Invalid request origin.', retryable: false },
        { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
      );
    // Browser CSRF admission happened at this trusted edge. Keep the backend's
    // canonical-origin check on the separately authenticated server-to-server hop.
    headers.set('origin', canonical);
  }
  // Platform authorization is consumed by Vercel, never by the application API.
  // Strip it explicitly rather than relying on a particular edge runtime to do so.
  for (const name of [
    'x-vercel-protection-bypass',
    'x-vercel-trusted-oidc-idp-token',
    'x-vercel-oidc-token',
    'x-vercel-set-bypass-cookie',
  ])
    headers.delete(name);
  // Overwrite untrusted caller input. Request-only: never emit this as a response header.
  headers.set('x-dreamwalk-ingress', secret);
  // Never forward platform protection cookies to the application backend.
  const sessionCookie = (headers.get('cookie') ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter(
      (v) =>
        v.startsWith('dreamwalk_session=') ||
        (request.nextUrl.pathname.startsWith('/api/v1/auth/google/') &&
          v.startsWith('dreamwalk_oauth=')),
    )
    .join('; ');
  if (sessionCookie) headers.set('cookie', sessionCookie);
  else headers.delete('cookie');
  const response = NextResponse.rewrite(target, { request: { headers } });
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('x-vercel-enable-rewrite-caching', '0');
  return response;
}
export const config = { matcher: '/api/:path*' };
