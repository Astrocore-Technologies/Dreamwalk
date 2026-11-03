import type { APIRequestContext } from '@playwright/test';

/** Only the unpaid local template fixture. Never retry an uncertain or paid request. */
export async function createUnpaidFixtureCampaign(
  request: Pick<APIRequestContext, 'post'>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const create = () =>
    request.post('/api/v1/game/campaigns', {
      data: { template: 'observatory-v1', turnBased: true },
    });
  const first = await create();
  if (first.status() !== 429) return first;
  const error = await first.json().catch(() => null);
  if (error?.code !== 'RATE_LIMITED' || error.retryable !== true) return first;
  // CI journeys share one loopback IP. The middleware rejected this request
  // before creation; allow its 60-second window to expire, at most once.
  await wait(61_000);
  return create();
}
