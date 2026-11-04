import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';

const labels = {
  en: {
    character: 'Character',
    location: 'Location',
    name: 'Name',
    brief: 'Creative brief',
    create: 'Prepare sample · free',
    cancel: 'Cancel preparation',
    empty: 'Your concept will appear here',
  },
  ru: {
    character: 'Персонаж',
    location: 'Локация',
    name: 'Название / имя',
    brief: 'Описание замысла',
    create: 'Подготовить пример · бесплатно',
    cancel: 'Отменить подготовку',
    empty: 'Здесь появится ваш замысел',
  },
  uk: {
    character: 'Персонаж',
    location: 'Локація',
    name: 'Назва / ім’я',
    brief: 'Опис задуму',
    create: 'Підготувати приклад · безкоштовно',
    cancel: 'Скасувати підготовку',
    empty: 'Тут з’явиться ваш задум',
  },
};

for (const variant of [
  { locale: 'ru', theme: 'dark', width: 1536, height: 1024 },
  { locale: 'en', theme: 'light', width: 1280, height: 900 },
  { locale: 'uk', theme: 'dark', width: 390, height: 844 },
  { locale: 'en', theme: 'light', width: 390, height: 844 },
] as const) {
  test(`workshop presentation ${variant.locale} ${variant.theme} ${variant.width}`, async ({
    page,
  }, testInfo) => {
    const text = labels[variant.locale];
    const writes: { path: string; body: Record<string, unknown> }[] = [];
    const project = {
      id: randomUUID(),
      kind: 'character',
      name: 'Synthetic concept QA',
      sourceHash: 'synthetic',
      status: 'concept',
      revision: 1,
      provider: 'fixture',
      conceptUrl: '/api/v1/assets/synthetic-concept/file',
      plan: null,
      projection: null,
    };
    let created = false;
    let failFirstCreate = true;
    let releaseCreate: (() => void) | undefined;
    await page.setViewportSize(variant);
    await page.addInitScript(({ locale, theme }) => {
      localStorage.setItem('dreamwalk-language', locale);
      localStorage.setItem('dreamwalk-theme', theme);
    }, variant);
    // Every API route is intercepted. No provider, upload, billing or live data is used.
    await page.route('**/api/v1/**', async (route) => {
      const endpoint = new URL(route.request().url()).pathname.replace('/api/v1', '');
      const method = route.request().method();
      if (endpoint === '/assets/synthetic-concept/file')
        return route.fulfill({
          path: path.resolve('apps/web/public/images/observatory.webp'),
          contentType: 'image/webp',
        });
      let json: unknown = {};
      if (method !== 'GET') writes.push({ path: endpoint, body: route.request().postDataJSON() });
      if (endpoint === '/auth/me')
        json = {
          user: {
            id: 'synthetic-workshop-user',
            name: 'Synthetic workshop QA',
            handle: 'workshop_qa',
            role: 'user',
            onboarded: true,
            settings: { language: variant.locale, theme: variant.theme },
          },
        };
      else if (endpoint === '/visual-authoring/projects' && method === 'POST') {
        if (failFirstCreate) {
          failFirstCreate = false;
          return route.fulfill({
            status: 503,
            json: { code: 'INTERNAL_ERROR', message: 'Synthetic interruption' },
          });
        }
        await new Promise<void>((resolve) => {
          releaseCreate = resolve;
        });
        created = true;
        json = project;
      } else if (endpoint === `/visual-authoring/projects/${project.id}/cancel`) {
        created = false;
        json = { ...project, status: 'cancelled' };
      } else if (endpoint === '/visual-authoring/projects') json = created ? [project] : [];
      else if (
        [
          '/visual-authoring/packages',
          '/heroes',
          '/npcs',
          '/notifications',
          '/invitations',
        ].includes(endpoint)
      )
        json = [];
      else if (method !== 'GET') return route.fulfill({ status: 403, json: { code: 'FORBIDDEN' } });
      return route.fulfill({ json });
    });
    await page.goto('/studio/visuals');
    const brief = page.locator('[data-workshop-brief]');
    const preview = page.locator('[data-workshop-preview]');
    const character = page.getByRole('button', { name: text.character, exact: true });
    const location = page.getByRole('button', { name: text.location, exact: true });
    const create = brief.getByRole('button', { name: text.create, exact: true });
    await expect(character).toHaveAttribute('aria-pressed', 'true');
    await expect(preview.getByRole('heading', { name: text.empty })).toBeVisible();
    await expect(preview.locator('img')).toHaveCount(0);
    await brief
      .getByLabel(text.brief, { exact: true })
      .fill('Synthetic brief retained across mode switches.');
    await location.click();
    await expect(location).toHaveAttribute('aria-pressed', 'true');
    await expect(create).toBeDisabled(); // A location still requires a saved adventure.
    await character.click();
    await expect(brief.getByLabel(text.brief, { exact: true })).toHaveValue(
      'Synthetic brief retained across mode switches.',
    );
    const source = brief.getByRole('combobox', { name: text.character, exact: true });
    await source.selectOption('photo');
    await expect(create).toBeDisabled();
    await brief.locator('input[type="checkbox"]').first().check();
    await source.selectOption('text');
    await source.selectOption('photo');
    await expect(brief.locator('input[type="checkbox"]').first()).not.toBeChecked();
    await expect(create).toBeDisabled();
    await source.selectOption('text');
    await brief.getByLabel(text.name, { exact: true }).fill(project.name);
    await expect(create).toBeEnabled();
    expect(writes).toHaveLength(0);
    await create.click();
    await expect(create).toBeEnabled();
    await expect.poll(() => writes.length).toBe(1);
    await create.click();
    await expect(create).toBeDisabled();
    await expect(character).toBeDisabled();
    await expect(location).toBeDisabled();
    // Repeated native clicks cannot submit while the request is pending.
    await create.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[0]).toEqual(writes[1]); // Retry retains the operation ID and full brief.
    releaseCreate?.();
    const image = preview.getByRole('img', { name: project.name, exact: true });
    await expect(image).toBeVisible();
    await image.evaluate((element) => (element as HTMLImageElement).decode());
    expect(
      await image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    ).toBeGreaterThan(0);
    await page.evaluate(() => document.fonts.ready);
    const formBox = await brief.boundingBox(),
      previewBox = await preview.boundingBox();
    if (variant.width > 1000) expect(previewBox!.x).toBeGreaterThan(formBox!.x + formBox!.width);
    else expect(previewBox!.y).toBeGreaterThan(formBox!.y + formBox!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const screenshot = await page.screenshot({
      path: testInfo.outputPath('workshop-synthetic-concept.png'),
      fullPage: true,
      animations: 'disabled',
    });
    const decoded = await sharp(screenshot).metadata();
    expect(decoded.width).toBe(variant.width);
    expect(decoded.height).toBeGreaterThan(0);
    await page.reload();
    await expect(preview.getByRole('heading', { name: text.empty })).toBeVisible();
    await page.getByRole('article').filter({ hasText: project.name }).getByRole('button').click();
    await expect(image).toBeVisible();
    await preview.getByRole('button', { name: text.cancel, exact: true }).click();
    await expect(preview.getByRole('heading', { name: text.empty })).toBeVisible();
    await expect(preview.locator('img')).toHaveCount(0);
    expect(writes.map((entry) => entry.path)).toEqual([
      '/visual-authoring/projects',
      '/visual-authoring/projects',
      `/visual-authoring/projects/${project.id}/cancel`,
    ]);
    // Location surface remains usable on a saved-story route, without generating anything.
    project.kind = 'location';
    await page.goto(`/studio/visuals?adventureId=${randomUUID()}`);
    await expect(location).toHaveAttribute('aria-pressed', 'true');
    await expect(create).toBeEnabled();
    await expect(preview.getByRole('heading', { name: text.empty })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('workshop-location-empty.png'),
      fullPage: true,
      animations: 'disabled',
    });
    expect(writes).toHaveLength(3);
    await create.click();
    await expect.poll(() => writes.length).toBe(4);
    releaseCreate?.();
    await expect(image).toBeVisible();
    await image.evaluate((element) => (element as HTMLImageElement).decode());
    // A rendered location concept never substitutes for a validated spatial plan.
    await expect(preview.getByRole('button').first()).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const locationCapture = await page.screenshot({
      path: testInfo.outputPath('workshop-location-synthetic-concept.png'),
      fullPage: true,
      animations: 'disabled',
    });
    expect((await sharp(locationCapture).metadata()).width).toBe(variant.width);
    expect(writes[3].body.kind).toBe('location');
    expect(writes[3].body.generationMode).toBe('fixture');
  });
}
