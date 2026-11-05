// The owner approved restoring HTTP and WebSocket origin protection after the
// custom domains were connected. Keep this policy aligned with the API.
export const ENFORCE_BROWSER_ORIGIN = true;

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

/** Stable backend trust contract; never inferred from a platform/browser host. */
export function canonicalWebOrigin(env: NodeJS.ProcessEnv): string | null {
  if (env.API_WEB_ORIGIN !== undefined) return exactHttpsOrigin(env.API_WEB_ORIGIN);
  // Vercel's primary domain can change independently of the API configuration.
  if (env.VERCEL === '1') return null;
  return exactHttpsOrigin(env.WEB_ORIGIN ?? '');
}

function browserOrigins(env: NodeJS.ProcessEnv): Set<string> | null {
  const configured = env.WEB_ALLOWED_ORIGINS;
  if (configured === undefined) {
    if (env.VERCEL === '1') return null;
    const canonical = canonicalWebOrigin(env);
    return canonical ? new Set([canonical]) : null;
  }
  if (configured.length > 4096) return null;
  const values = configured.split(',').map((value) => value.trim());
  if (values.length > 16 || values.some((value) => !exactHttpsOrigin(value))) return null;
  const trusted = new Set(values);
  if (env.VERCEL === '1' && env.VERCEL_ENV === 'preview') {
    for (const host of [env.VERCEL_URL, env.VERCEL_BRANCH_URL]) {
      if (host === undefined) continue;
      if (
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/.test(host) ||
        !exactHttpsOrigin(`https://${host}`)
      )
        return null;
      trusted.add(`https://${host}`);
    }
  }
  return trusted;
}

export function trustedBrowserOrigin(request: Request, env: NodeJS.ProcessEnv): boolean {
  if (!canonicalWebOrigin(env)) return false;
  const trusted = browserOrigins(env);
  if (!trusted) return false;
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
