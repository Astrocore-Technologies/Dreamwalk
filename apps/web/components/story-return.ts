/** Return intents are public story pages, never arbitrary redirects or commands. */
const slugPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;
const heroPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function safeStoryReturn(value: string | null | undefined): string | null {
  if (!value || value.length > 300) return null;
  const match = /^\/adventures\/([^/?#]+)(?:\?heroId=([^&#]+))?$/.exec(value);
  if (!match || !slugPattern.test(match[1]) || (match[2] && !heroPattern.test(match[2])))
    return null;
  return `/adventures/${match[1]}${match[2] ? `?heroId=${match[2]}` : ''}`;
}
export function storyReturnPath(slug: string, heroId?: string): string | null {
  return safeStoryReturn(`/adventures/${slug}${heroId ? `?heroId=${heroId}` : ''}`);
}
export function readStoryReturn(params: Pick<URLSearchParams, 'getAll'>): string | null {
  const values = params.getAll('returnTo');
  return values.length === 1 ? safeStoryReturn(values[0]) : null;
}
export function withStoryReturn(
  path:
    '/auth/sign-in' | '/auth/sign-up' | '/auth/reset-password' | '/onboarding' | '/my-characters',
  intent: string | null,
): string {
  const safe = safeStoryReturn(intent);
  return safe ? `${path}?returnTo=${encodeURIComponent(safe)}` : path;
}
export function storyAfterAuth(onboarded: boolean, intent: string | null): string {
  return onboarded ? safeStoryReturn(intent) || '/home' : withStoryReturn('/onboarding', intent);
}
export function storyWithHero(intent: string | null, heroId: string): string | null {
  const safe = safeStoryReturn(intent);
  return safe && heroPattern.test(heroId) ? `${safe.split('?')[0]}?heroId=${heroId}` : null;
}
