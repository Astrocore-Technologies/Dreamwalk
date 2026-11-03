import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { StoryFeedEntry, StoryTurnFeed } from '@dreamwalk/contracts';
import { campaignDetails } from './support/campaign-details';

async function bounds(page: Page) {
  return page.evaluate(() => ({
    width: document.documentElement.scrollWidth - innerWidth,
    height: document.documentElement.scrollHeight - innerHeight,
    pageTop: scrollY,
  }));
}

for (const locale of ['ru', 'en', 'uk']) {
  test(`game history stays anchored and desktop stays inside the viewport (${locale})`, async ({
    page,
  }, info) => {
    const handle = `layout_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const registered = await page.request.post('/api/v1/auth/register', {
      data: {
        handle,
        name: 'Synthetic layout reader',
        email: `${handle}@example.test`,
        password: `Layout-${randomUUID()}!`,
      },
    });
    expect(registered.ok()).toBeTruthy();
    expect(
      (await page.request.patch('/api/v1/account/settings', { data: { language: locale } })).ok(),
    ).toBeTruthy();
    await page.addInitScript(
      (language) => localStorage.setItem('dreamwalk-language', language),
      locale,
    );
    const created = await page.request.post('/api/v1/game/campaigns', {
      data: { template: 'observatory-v1', turnBased: false },
    });
    expect(created.ok()).toBeTruthy();
    const id = (await created.json()).campaignId;
    const source = await page.request.get(`/api/v1/game/campaigns/${id}/turns/feed`);
    expect(source.ok()).toBeTruthy();
    const fixture: StoryTurnFeed = await source.json();
    const entry = (number: number): StoryFeedEntry => ({
      id: `layout-${number}`,
      ordinal: number,
      sequence: number,
      tick: number,
      createdAt: null,
      kind: 'npc_reply',
      channel: 'say',
      authorLabel: 'Reader fixture',
      text: `Message ${number}. ${'A long visible story line that wraps naturally. '.repeat(4)}`,
    });
    fixture.entries = Array.from({ length: 45 }, (_, index) => entry(index));
    await page.route(`**/api/v1/game/campaigns/${id}/turns/feed`, (route) =>
      route.fulfill({ json: fixture }),
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/game/${id}`);
    const panel = page.getByTestId('unified-story');
    const feed = page.getByTestId('story-feed');
    const input = panel.locator('textarea');
    await expect(feed.locator('[data-story-entry]')).toHaveCount(45);
    await expect(page.getByTestId('scene-media')).toHaveCount(0);
    const gap = () => feed.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
    await expect.poll(gap).toBeLessThan(2);
    const originalInput = await input.boundingBox();
    fixture.entries.push(entry(45));
    await expect(feed.locator('[data-story-entry]')).toHaveCount(46);
    await expect.poll(gap).toBeLessThan(2);
    expect((await input.boundingBox())!.y).toBeCloseTo(originalInput!.y, 0);

    // Read an older paragraph, then receive new entries and polling repeats.
    await feed.evaluate((el) => {
      el.scrollTop = 400;
      el.dispatchEvent(new Event('scroll'));
    });
    const anchor = await feed.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      const node = [...el.querySelectorAll<HTMLElement>('[data-story-entry]')].find(
        (n) => n.getBoundingClientRect().bottom > top,
      )!;
      return {
        id: node.dataset.storyEntry,
        offset: node.getBoundingClientRect().top - top,
        scrollTop: el.scrollTop,
      };
    });
    fixture.entries.push(entry(46), entry(47));
    await expect(feed.locator('[data-story-entry]')).toHaveCount(48);
    const marker = feed.locator(`[data-story-entry="${anchor.id}"]`);
    const offset = () =>
      marker.evaluate(
        (el) =>
          el.getBoundingClientRect().top -
          el.closest('[data-testid="story-feed"]')!.getBoundingClientRect().top,
      );
    await expect.poll(offset).toBeCloseTo(anchor.offset, 0);
    const newEvents = panel
      .locator('button')
      .filter({ hasText: /К последним событиям|Jump to latest|До останніх подій/ });
    await expect(newEvents).toBeVisible();
    expect((await input.boundingBox())!.y).toBeCloseTo(originalInput!.y, 0);
    await page.waitForResponse(`**/api/v1/game/campaigns/${id}/turns/feed`);
    await expect.poll(offset).toBeCloseTo(anchor.offset, 0);

    // A confirmation and viewport resize must not hide the composer or lose the paragraph.
    fixture.turns = [
      {
        id: 'layout-confirmation',
        generationNeedsConfirmation: true,
        status: 'committed',
      } as StoryTurnFeed['turns'][number],
    ];
    await expect(panel.locator('[data-testid="story-reply-confirmation"]')).toHaveCount(1);
    await expect.poll(offset).toBeCloseTo(anchor.offset, 0);
    for (const size of [
      { width: 1280, height: 720 },
      { width: 1024, height: 600 },
      { width: 820, height: 700 },
    ]) {
      await page.setViewportSize(size);
      await expect.poll(async () => (await bounds(page)).height).toBeLessThanOrEqual(1);
      expect((await bounds(page)).width).toBeLessThanOrEqual(1);
      expect((await bounds(page)).pageTop).toBe(0);
      await expect(input).toBeInViewport();
      await expect.poll(offset).toBeCloseTo(anchor.offset, 0);
    }
    await campaignDetails(page);
    await expect(page.getByTestId('campaign-hero')).toBeVisible();
    expect((await bounds(page)).height).toBeLessThanOrEqual(1);
    await page.getByTestId('campaign-details').locator(':scope > summary').press('Escape');
    await expect(page.getByTestId('campaign-details')).not.toHaveAttribute('open', '');
    await expect(input).toBeInViewport();
    await newEvents.focus();
    await newEvents.press('Enter');
    await expect.poll(gap).toBeLessThan(2);
    await expect(newEvents).toHaveCount(0);
    await info.attach(`game-chat-${locale}-desktop`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    // Narrow screens retain document navigation and a bounded, independently scrollable chat.
    fixture.turns = [];
    await page.setViewportSize({ width: 390, height: 844 });
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeInViewport();
    expect((await bounds(page)).width).toBeLessThanOrEqual(1);
    await input.fill('Draft stays in place');
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(input).toHaveValue('Draft stays in place');
    await expect.poll(async () => (await bounds(page)).height).toBeLessThanOrEqual(1);
    await page.reload();
    await expect(feed.locator('[data-story-entry]')).toHaveCount(48);
    await expect.poll(gap).toBeLessThan(2);
    await expect(input).toBeInViewport();
  });
}
