import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const run = promisify(execFile);

test('account export is prepared explicitly and downloaded by its owner', async ({ page }) => {
  const database = process.env.DATABASE_URL;
  expect(database, 'Disposable local CI PostgreSQL is required').toBeTruthy();
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(database!).hostname);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const email = `export-browser-${suffix}@example.test`;
  const password = `Export-${randomUUID()}!`;
  const registered = await page.request.post('/api/v1/auth/register', {
    data: { email, handle: `export_${suffix}`, name: 'Экспорт QA', password },
  });
  expect(registered.status()).toBe(201);
  await page.goto('/account/privacy');
  await page.getByRole('button', { name: 'Запросить экспорт', exact: true }).click();
  await expect(page.getByText('Экспорт ожидает обработки', { exact: true })).toBeVisible();
  const response = await page.request.get('/api/v1/account/exports');
  expect(response.ok()).toBeTruthy();
  const requests = (await response.json()) as { id: string; status: string }[];
  expect(requests).toHaveLength(1);
  await run(
    process.execPath,
    [
      'scripts/process-data-request.mjs',
      '--request',
      requests[0].id,
      '--operator',
      'synthetic-browser-test',
    ],
    { env: process.env },
  );
  await page.getByRole('button', { name: 'Обновить список архивов' }).click();
  await expect(page.getByText('Экспорт готов', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Скачать мои данные' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('dreamwalk-export.json');
  const path = await download.path();
  expect(path).toBeTruthy();
  const contents = await readFile(path!, 'utf8');
  const artifact = JSON.parse(contents) as { profile: { email: string } };
  expect(artifact.profile.email).toBe(email);
  expect(contents).not.toContain(password);
  expect(contents).not.toContain('password_hash');
  expect(contents).not.toContain('token_hash');
});
