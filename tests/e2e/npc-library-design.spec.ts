import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const labels = {
  ru: {
    title: 'Персонажи мира',
    name: 'Имя NPC',
    biography: 'Биография',
    character: 'Характер',
    speech: 'Речь',
    greeting: 'Первая реплика',
    secret: 'Секреты и скрытые знания',
    save: 'Сохранить NPC',
    library: 'Библиотека NPC',
    leave: 'Выйти без сохранения',
    remove: 'Удалить',
    cancel: 'Отмена',
    artwork: 'Образ на карте',
  },
  en: {
    title: 'World characters',
    name: 'NPC name',
    biography: 'Biography',
    character: 'Personality',
    speech: 'Speech',
    greeting: 'First greeting',
    secret: 'Secrets and hidden knowledge',
    save: 'Save NPC',
    library: 'NPC library',
    leave: 'Leave without saving',
    remove: 'Delete',
    cancel: 'Cancel',
    artwork: 'In-world appearance',
  },
  uk: {
    title: 'Персонажі світу',
    name: 'Ім’я NPC',
    biography: 'Біографія',
    character: 'Характер',
    speech: 'Мовлення',
    greeting: 'Перша репліка',
    secret: 'Таємниці й приховані знання',
    save: 'Зберегти NPC',
    library: 'Бібліотека NPC',
    leave: 'Вийти без збереження',
    remove: 'Видалити',
    cancel: 'Скасувати',
    artwork: 'Образ на мапі',
  },
};
const fixtures = () =>
  ['Observatory keeper', 'Archive researcher', 'Forest pathfinder'].map((name, index) => ({
    id: randomUUID(),
    name,
    age: 53,
    role: 'Synthetic layout fixture',
    description:
      'A synthetic character created only inside this browser test. No real account or private character data is used.',
    personality: 'Curious, patient and attentive.',
    appearance: 'An illustrated adult traveller.',
    biography: 'A fixture biography retained when switching sections.',
    secrets: 'PRIVATE_NPC_FIXTURE_NEVER_ON_CARD',
    greeting: 'Welcome to the observatory.',
    sourceLanguage: 'en',
    sourceRevision: 1,
    translations: {},
    visibility: 'private',
    modelProfileId: null,
    portraitAssetId: index === 2 ? null : randomUUID(),
    editRevision: 1,
    characterProfile: {
      version: 1,
      initialGoal: 'patrol',
      personality: {
        role: 'guard',
        values: ['duty'],
        taboos: ['steal', 'disclose_private'],
        speechStyle: '',
      },
    },
    characterPackageVersionId: randomUUID(),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }));
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function waitForArt(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images).map(async (image) => {
        if (!image.complete)
          await new Promise<void>((resolve, reject) => {
            image.addEventListener('load', () => resolve(), { once: true });
            image.addEventListener(
              'error',
              () => reject(new Error('Fixture portrait failed to load')),
              { once: true },
            );
          });
        if (!image.naturalWidth) throw new Error('Fixture portrait has no decoded pixels');
        await image.decode();
      }),
    );
    const hero = document.querySelector('[data-testid="npc-library"] header');
    if (hero) {
      const match = getComputedStyle(hero).backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
      if (!match) throw new Error('Decorative NPC hero is missing');
      const image = new Image();
      image.src = match[1];
      await image.decode();
    }
  });
}
for (const variant of [
  { locale: 'ru', theme: 'dark', width: 1536, height: 1024 },
  { locale: 'en', theme: 'dark', width: 1165, height: 747 },
  { locale: 'uk', theme: 'light', width: 1536, height: 1024 },
  { locale: 'en', theme: 'light', width: 390, height: 844 },
] as const) {
  test(`NPC library and editor design ${variant.locale} ${variant.width} ${variant.theme}`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    const text = labels[variant.locale];
    const npcs = fixtures();
    const npc = npcs[0];
    const mutations: { method: string; path: string; data: Record<string, unknown> }[] = [];
    let empty = true;
    let conflict = false;
    await page.setViewportSize({ width: variant.width, height: variant.height });
    await page.addInitScript(({ locale, theme }) => {
      localStorage.setItem('dreamwalk-language', locale);
      localStorage.setItem('dreamwalk-theme', theme);
    }, variant);
    await page.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
      const method = route.request().method();
      if (method !== 'GET') mutations.push({ method, path, data: route.request().postDataJSON() });
      let json: unknown = {};
      if (path === '/auth/me')
        json = {
          user: {
            id: '11111111-1111-4111-8111-111111111111',
            role: 'user',
            name: 'Synthetic NPC design QA',
            handle: 'npc_design_qa',
            onboarded: true,
            settings: { language: variant.locale, theme: variant.theme },
          },
        };
      else if (path === '/npcs') json = empty ? [] : npcs;
      else if (path === `/npcs/${npc.id}`) {
        if (method === 'PATCH') {
          if (conflict)
            return route.fulfill({
              status: 409,
              json: { code: 'STALE_STATE', message: 'STALE_STATE' },
            });
          const { expectedEditRevision, ...draft } = route.request().postDataJSON();
          expect(expectedEditRevision).toBe(npc.editRevision);
          Object.assign(npc, draft, { editRevision: npc.editRevision + 1 });
        }
        json = npc;
      } else if (path.startsWith('/assets/')) {
        // Deliberately schematic, clearly labelled test-only portrait, never uploaded.
        return route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="440" height="550"><rect width="440" height="550" fill="#30213f"/><circle cx="220" cy="150" r="80" fill="#dbbd83"/><path d="M55 550V360a165 165 0 0 1 330 0v190" fill="#79618c"/><text x="220" y="520" text-anchor="middle" fill="white" font-size="20">SYNTHETIC PORTRAIT</text></svg>',
        });
      } else if (path === '/notifications' || path === '/invitations') json = [];
      return route.fulfill({ json });
    });
    await page.goto('/studio/npcs');
    const library = page.getByTestId('npc-library');
    await expect(library.getByRole('heading', { name: text.title })).toBeVisible();
    await expect(library.locator('a[href^="/studio/npcs/"]:not([href$="/new"])')).toHaveCount(0);
    await noOverflow(page);
    await waitForArt(page);
    await page.screenshot({ path: info.outputPath('npc-library-empty.png'), fullPage: true });
    empty = false;
    await page.reload();
    await expect(library.getByRole('heading', { name: npc.name })).toBeVisible();
    await expect(library.getByText(npc.secrets)).toHaveCount(0);
    const cards = library.locator('a[href^="/studio/npcs/"]:not([href$="/new"])');
    await expect(cards).toHaveCount(3);
    if (variant.width === 1536) {
      const boxes = await Promise.all([0, 1, 2].map((i) => cards.nth(i).boundingBox()));
      expect(boxes[0]!.y).toBe(boxes[2]!.y);
    }
    await noOverflow(page);
    await waitForArt(page);
    await page.screenshot({ path: info.outputPath('npc-library-populated.png'), fullPage: true });
    expect(mutations).toEqual([]);
    await cards.first().click();
    const editor = page.getByTestId('npc-editor');
    const name = editor.getByLabel(text.name, { exact: true });
    await expect(name).toHaveValue(npc.name);
    await expect(editor.locator('[data-autosave-status="saved"]')).toBeVisible();
    const portrait = await editor.locator('img').boundingBox();
    expect(portrait!.height).toBeGreaterThan(300);
    if (variant.width > 700)
      expect((await name.boundingBox())!.x).toBeGreaterThan(portrait!.x + portrait!.width);
    await expect(editor.getByLabel(text.secret)).toHaveValue(npc.secrets);
    await noOverflow(page);
    await waitForArt(page);
    await page.screenshot({ path: info.outputPath('npc-editor-populated.png'), fullPage: true });
    await editor.getByRole('button', { name: text.biography, exact: true }).click();
    await expect(editor.getByRole('textbox', { name: text.biography, exact: true })).toHaveValue(
      npc.biography,
    );
    await editor.getByRole('button', { name: text.speech, exact: true }).click();
    await expect(editor.getByRole('textbox', { name: text.greeting, exact: true })).toHaveValue(
      npc.greeting,
    );
    await editor.getByRole('button', { name: text.character, exact: true }).click();
    await expect(editor.getByRole('textbox', { name: text.character, exact: true })).toHaveValue(
      npc.personality,
    );
    await editor.locator('summary').filter({ hasText: text.artwork }).click();
    await expect(editor.locator('details')).toHaveAttribute('open', '');
    expect(mutations).toEqual([]);
    await editor.locator('summary').filter({ hasText: text.artwork }).click();
    await editor.getByRole('button', { name: text.remove, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: text.cancel, exact: true }).click();
    expect(mutations).toEqual([]);
    const originalProfile = structuredClone(npc.characterProfile);
    const originalPackage = npc.characterPackageVersionId;
    await name.fill('Autosaved synthetic keeper');
    await expect.poll(() => mutations.length).toBe(1);
    await expect(editor.locator('[data-autosave-status="saved"]')).toBeVisible();
    expect(mutations[0].data).toMatchObject({
      expectedEditRevision: 1,
      secrets: npc.secrets,
      biography: npc.biography,
      greeting: npc.greeting,
      characterProfile: originalProfile,
      characterPackageVersionId: originalPackage,
      portraitAssetId: npc.portraitAssetId,
    });
    await page.reload();
    await expect(name).toHaveValue('Autosaved synthetic keeper');
    // A stale revision remains visibly blocked and preserves the local draft.
    conflict = true;
    await name.fill('Unacknowledged local draft');
    await expect(editor.locator('[data-autosave-status="conflict"]')).toBeVisible();
    await expect(name).toHaveValue('Unacknowledged local draft');
    await editor.getByRole('button', { name: text.library, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: text.leave, exact: true }).click();
    await expect(library).toBeVisible();
    const writesBeforeNew = mutations.length;
    await library.locator('a[href="/studio/npcs/new"]').first().click();
    await expect(name).toHaveValue('');
    await expect(editor.locator('img')).toHaveCount(0);
    await expect(editor.locator('[data-autosave-status="disabled"]')).toBeVisible();
    await waitForArt(page);
    await page.screenshot({ path: info.outputPath('npc-editor-new.png'), fullPage: true });
    await name.fill('x');
    await editor.getByRole('button', { name: text.library, exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(name).toHaveValue('x');
    await editor.getByRole('button', { name: text.library, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: text.leave, exact: true }).click();
    await expect(library).toBeVisible();
    expect(mutations).toHaveLength(writesBeforeNew);
    expect(
      mutations.every(
        (mutation) => mutation.method === 'PATCH' && mutation.path === `/npcs/${npc.id}`,
      ),
    ).toBe(true);
    await page.goBack();
    await expect(name).toHaveValue('');
    await page.goForward();
    await expect(library).toBeVisible();
    await noOverflow(page);
  });
}
