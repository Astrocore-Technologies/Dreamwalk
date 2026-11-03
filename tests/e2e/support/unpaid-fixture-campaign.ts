import type { APIRequestContext, APIResponse } from '@playwright/test';

/** Only the unpaid local template fixture. Never retry an uncertain or paid request. */
export async function createUnpaidFixtureCampaign(
  request: Pick<APIRequestContext, 'post'>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const create = () =>
    request.post('/api/v1/game/campaigns', {
      data: { template: 'observatory-v1', turnBased: true },
    });
  return retryRejectedFixtureRequest(create, wait);
}

async function retryRejectedFixtureRequest<T extends Pick<APIResponse, 'status' | 'json'>>(
  request: () => Promise<T>,
  wait: (ms: number) => Promise<void>,
): Promise<T> {
  const first = await request();
  if (first.status() !== 429) return first;
  const error = await first.json().catch(() => null);
  if (error?.code !== 'RATE_LIMITED' || error.retryable !== true) return first;
  // Explicit middleware rejection precedes the handler. No uncertain work is retried.
  await wait(61_000);
  return request();
}

/** Test-only language setup, never quote, dispatch, billing or permission settings. */
export function setUnpaidFixtureLocale(
  request: Pick<APIRequestContext, 'patch'>,
  language: 'uk' | 'en' | 'ru',
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  return retryRejectedFixtureRequest(
    () => request.patch('/api/v1/account/settings', { data: { language } }),
    wait,
  );
}

/** Only read-only snapshots/feed of the already-created unpaid fixture campaign. */
export function readUnpaidFixtureCampaign(
  request: Pick<APIRequestContext, 'get'>,
  campaignId: string,
  resource: 'snapshot' | 'turns/feed',
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  return retryRejectedFixtureRequest(
    () => request.get(`/api/v1/game/campaigns/${encodeURIComponent(campaignId)}/${resource}`),
    wait,
  );
}
