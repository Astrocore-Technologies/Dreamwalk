import { test, expect } from '@playwright/test';

for (const [locale, label, insert, example, full] of [
  ['ru', 'Характер', 'Вставить: Мотив', 'Хочет заслужить доверие общины.', 'Недостаточно места'],
  [
    'en',
    'Personality',
    'Insert: Motive',
    'Wants to earn the community’s trust.',
    'Not enough room',
  ],
  ['uk', 'Характер', 'Вставити: Мотив', 'Хоче заслужити довіру громади.', 'Недостатньо місця'],
]) {
  test(`editable NPC templates preserve author content and focus in ${locale}`, async ({
    page,
  }) => {
    const writes: string[] = [];
    await page.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
      if (route.request().method() !== 'GET') writes.push(path);
      const json =
        path === '/auth/me'
          ? {
              user: {
                id: '11111111-1111-4111-8111-111111111111',
                role: 'user',
                name: 'Template QA',
                handle: 'template_qa',
                onboarded: true,
                settings: { language: locale, theme: 'dark' },
              },
            }
          : [];
      await route.fulfill({ json });
    });
    await page.addInitScript(
      (language) => localStorage.setItem('dreamwalk-language', language),
      locale,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/studio/npcs/new');
    const field = page.getByLabel(label, { exact: true });
    await field.fill('before AFTER');
    await field.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(7, 12));
    await page.getByRole('button', { name: insert, exact: true }).click();
    expect((await field.inputValue()).startsWith(`before ${example}`)).toBe(true);
    expect(await field.inputValue()).toMatch(/\nAFTER$/);
    await expect(field).toBeFocused();
    await page.getByRole('button', { name: insert, exact: true }).focus();
    await page.keyboard.press('Enter');
    expect((await field.inputValue()).split(example)).toHaveLength(3);
    await field.fill('x'.repeat(4000));
    await page.getByRole('button', { name: insert, exact: true }).click();
    await expect(field).toHaveValue('x'.repeat(4000));
    await expect(page.getByRole('status').filter({ hasText: full })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(writes).toEqual([]);
  });
}
