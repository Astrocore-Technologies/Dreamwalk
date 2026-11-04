// Owner-approved temporary pause until domain setup is complete. Re-enable only
// after explicit approval and coordinated HTTP/WS verification on web and API.
export const ENFORCE_BROWSER_ORIGIN = false;

function exactHttpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.hostname.includes('*') && url.origin === value
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function platformProductionOrigin(env: NodeJS.ProcessEnv): string | null {
  try {
    // Vercel supplies this project-owned production domain even in previews.
    // Never derive the backend trust origin from a browser/forwarded header.
    const platformHost = env.VERCEL === '1' ? env.VERCEL_PROJECT_PRODUCTION_URL : undefined;
    if (platformHost !== undefined) {
      if (
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
          platformHost,
        )
      )
        return null;
      const origin = `https://${platformHost}`;
      return new URL(origin).origin === origin ? origin : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Backend trust contract, not Vercel's mutable choice of primary browser domain. */
export function canonicalWebOrigin(env: NodeJS.ProcessEnv): string | null {
  // Match the API's WEB_ORIGIN once for every environment sharing that API.
  // Never fall back from an explicitly supplied, invalid trust configuration.
  if (env.API_WEB_ORIGIN !== undefined) return exactHttpsOrigin(env.API_WEB_ORIGIN);
  // Preserve deployments not yet migrated to the explicit backend contract.
  if (env.VERCEL === '1' && env.VERCEL_PROJECT_PRODUCTION_URL !== undefined)
    return platformProductionOrigin(env);
  return exactHttpsOrigin(env.WEB_ORIGIN ?? '');
}

export function trustedBrowserOrigin(request: Request, env: NodeJS.ProcessEnv): boolean {
  const canonical = canonicalWebOrigin(env);
  if (!canonical) return false;
  const trusted = new Set([canonical]);
  // A new project-owned custom domain is a browser alias, not a new API trust
  // origin. Admit it separately while retaining the stable canonical host.
  if (env.VERCEL === '1' && env.VERCEL_PROJECT_PRODUCTION_URL !== undefined) {
    const production = platformProductionOrigin(env);
    if (!production) return false;
    trusted.add(production);
  }
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
