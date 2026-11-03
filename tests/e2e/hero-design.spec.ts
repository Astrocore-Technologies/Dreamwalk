import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const labels = {
  ru: {
    create: 'Создать героя',
    edit: 'Редактировать',
    save: 'Сохранить героя',
    cancel: 'Отмена',
    traits: 'Черты характера',
    remove: 'Удалить',
    appearance: 'Образ героя',
    name: 'Имя героя',
  },
  en: {
    create: 'Create hero',
    edit: 'Edit',
    save: 'Save hero',
    cancel: 'Cancel',
    traits: 'Personality traits',
    remove: 'Delete',
    appearance: 'Hero appearance',
    name: 'Hero name',
  },
  uk: {
    create: 'Створити героя',
    edit: 'Редагувати',
    save: 'Зберегти героя',
    cancel: 'Скасувати',
    traits: 'Риси характеру',
    remove: 'Видалити',
    appearance: 'Образ героя',
    name: 'Ім’я героя',
  },
};
for (const variant of [
  { locale: 'ru', width: 1536, height: 1024, theme: 'dark' },
  { locale: 'en', width: 1165, height: 747, theme: 'dark' },
  { locale: 'uk', width: 1536, height: 1024, theme: 'light' },
  { locale: 'en', width: 390, height: 844, theme: 'light' },
] as const) {
  test(`hero design ${variant.locale} ${variant.width} ${variant.theme}`, async ({
    page,
  }, testInfo) => {
    const text = labels[variant.locale];
    const hero = {
      id: randomUUID(),
      name: 'Portrait layout fixture',
      backstory: 'A synthetic hero used only to verify layout, editing and privacy.',
      notes: 'PRIVATE_NOTES_NOT_ON_CARD',
      traits: ['Curious', 'Kind'],
      portraitAssetId: randomUUID(),
    };
    const mutations: { path: string; data: Record<string, unknown> }[] = [];
    await page.setViewportSize({ width: variant.width, height: variant.height });
    await page.addInitScript(({ locale, theme }) => {
      localStorage.setItem('dreamwalk-language', locale);
      localStorage.setItem('dreamwalk-theme', theme);
    }, variant);
    await page.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
      if (route.request().method() !== 'GET')
        mutations.push({ path, data: route.request().postDataJSON() });
      let json: unknown = {};
      if (path === '/auth/me')
        json = {
          user: {
            id: randomUUID(),
            role: 'user',
            name: 'Layout QA',
            handle: 'layout_qa',
            onboarded: true,
            settings: { language: variant.locale, theme: variant.theme },
          },
        };
      else if (path === '/heroes') json = [hero];
      else if (path === `/heroes/${hero.id}`) {
        Object.assign(hero, route.request().postDataJSON());
        json = hero;
      } else if (path.startsWith('/assets/'))
        return route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="500" viewBox="0 0 360 500"><rect width="360" height="500" fill="#40334e"/><circle cx="180" cy="120" r="70" fill="#d5b87d"/><path d="M40 500V310a140 140 0 0 1 280 0v190" fill="#897496"/><text x="180" y="470" text-anchor="middle" fill="white" font-size="18">Synthetic portrait fixture</text></svg>',
        });
      else if (path === '/notifications' || path === '/invitations') json = [];
      return route.fulfill({ json });
    });
    await page.goto('/my-characters');
    const card = page.locator('.hero-card');
    await expect(card.getByRole('heading', { name: hero.name })).toBeVisible();
    await expect(card.getByText(hero.notes)).toHaveCount(0);
    const portrait = await card.locator('.hero-portrait').boundingBox();
    expect(portrait!.height / portrait!.width).toBeGreaterThan(0.8);
    await expect(card.locator('details')).not.toHaveAttribute('open', '');
    await card.locator('summary').click();
    await expect(card.locator('details')).toHaveAttribute('open', '');
    expect(mutations).toEqual([]);
    await card.locator('summary').click();
    await page.screenshot({ path: testInfo.outputPath('heroes-fixture.png'), fullPage: true });
    await card.getByRole('button', { name: text.edit, exact: true }).click();
    const dialog = page.getByRole('dialog');
    const name = dialog.getByLabel(text.name, { exact: true });
    await expect(name).toHaveValue(hero.name);
    const editorImage = await dialog.locator('img.upload-preview').boundingBox();
    const input = await name.boundingBox();
    if (variant.width > 700) {
      expect(input!.x).toBeGreaterThan(editorImage!.x + editorImage!.width);
      expect(editorImage!.height).toBeGreaterThan(300);
    }
    const save = dialog.getByRole('button', { name: text.save, exact: true });
    await expect(save).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('hero-editor-fixture.png'), fullPage: true });
    await dialog.getByRole('button', { name: `${text.remove}: Kind`, exact: true }).click();
    await expect(dialog.getByLabel(text.traits)).toHaveValue('Curious');
    await dialog.getByLabel(text.traits).fill('Curious, Brave, ');
    await dialog.getByRole('button', { name: text.cancel, exact: true }).click();
    expect(mutations).toEqual([]);
    await expect(card.getByText('Kind', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: text.edit, exact: true }).click();
    await expect(dialog.getByLabel(text.traits)).toHaveValue('Curious, Kind');
    await dialog.getByLabel(text.traits).fill('Curious, Brave, ');
    await save.click();
    await expect(dialog).toHaveCount(0);
    expect(mutations).toEqual([
      {
        path: `/heroes/${hero.id}`,
        data: {
          name: hero.name,
          backstory: hero.backstory,
          notes: hero.notes,
          portraitAssetId: hero.portraitAssetId,
          traits: ['Curious', 'Brave'],
        },
      },
    ]);
    await card.getByRole('button', { name: text.edit, exact: true }).click();
    await name.fill('Unsaved change');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await card.getByRole('button', { name: text.edit, exact: true }).click();
    await expect(name).toHaveValue(hero.name);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: text.create, exact: true }).click();
    await expect(name).toHaveValue('');
    await expect(dialog.locator('img.upload-preview')).toHaveCount(0);
    await expect(save).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath('hero-editor-empty-fixture.png'),
      fullPage: true,
    });
    await page.keyboard.press('Escape');
    expect(mutations).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
