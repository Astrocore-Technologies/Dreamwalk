import type { Page, Route } from '@playwright/test';

const configured = new WeakSet<Page>();
/** Explicit synthetic user-author response for carousel/launch tests, not normal discovery. */
export async function fulfillDiscoveryFixtures(route: Route) {
  const response = await route.fetch();
  const stories = (await response.json()) as { author: { handle: string } }[];
  await route.fulfill({
    response,
    json: stories.map((story) => ({
      ...story,
      author: { ...story.author, handle: 'synthetic_discovery_author' },
    })),
  });
}
export async function exposeDiscoveryFixtures(page: Page) {
  if (configured.has(page)) return;
  configured.add(page);
  await page.route('**/api/v1/adventures?sort=popular', fulfillDiscoveryFixtures);
}
