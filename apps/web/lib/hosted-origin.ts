/** Deployment-owned configuration only; never trust forwarded host headers. */
export function canonicalWebOrigin(env: NodeJS.ProcessEnv): string | null {
  try {
    const url = new URL(env.WEB_ORIGIN ?? '');
    return url.protocol === 'https:' && url.origin === env.WEB_ORIGIN ? url.origin : null;
  } catch {
    return null;
  }
}

export function trustedBrowserOrigin(request: Request, env: NodeJS.ProcessEnv): boolean {
  const canonical = canonicalWebOrigin(env);
  if (!canonical) return false;
  const trusted = new Set([canonical]);
  for (const host of [env.VERCEL_URL, env.VERCEL_BRANCH_URL]) {
    if (!host || !/^[a-z0-9.-]+\.vercel\.app$/i.test(host)) continue;
    trusted.add(`https://${host.toLowerCase()}`);
  }
  const actual = new URL(request.url);
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  const fetchSite = request.headers.get('sec-fetch-site');
  return (
    trusted.has(actual.origin) &&
    origin === actual.origin &&
    (!host || host === actual.host) &&
    (!fetchSite || fetchSite === 'same-origin')
  );
}
