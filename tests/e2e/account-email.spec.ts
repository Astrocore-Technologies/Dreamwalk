import { test, expect } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

test('email confirmation and recovery consume fragment tokens only after explicit confirmation', async ({
  page,
}) => {
  const database = process.env.DATABASE_URL;
  expect(database, 'Disposable local CI PostgreSQL is required').toBeTruthy();
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(database!).hostname);
  const db = new pg.Pool({ connectionString: database });
  try {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const email = `mail-browser-${suffix}@example.test`;
    const password = `Original-${randomUUID()}!`;
    const registered = await page.request.post('/api/v1/auth/register', {
      data: { email, handle: `mail_${suffix}`, name: 'Почта QA', password },
    });
    expect(registered.status()).toBe(201);
    const { user } = (await registered.json()) as { user: { id: string } };
    // The separate SMTP integration suite tests delivery. Here only synthetic
    // local fixture tokens are inserted to verify the real browser confirmation UI.
    const insert = async (purpose: 'verify' | 'reset') => {
      const token = randomBytes(32).toString('hex');
      await db.query(
        "INSERT INTO auth_email_tokens(token_hash,user_id,purpose,expires_at) VALUES($1,$2,$3,now()+interval '30 minutes')",
        [createHash('sha256').update(token).digest('hex'), user.id, purpose],
      );
      return token;
    };
    const verification = await insert('verify');
    await page.goto(`/auth/verify-email#token=${verification}`);
    await expect(page).toHaveURL(/\/auth\/verify-email$/);
    expect(
      (await db.query('SELECT email_verified FROM users WHERE id=$1', [user.id])).rows[0]
        .email_verified,
    ).toBe(false);
    await page.getByRole('button', { name: 'Подтвердить email', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Email подтверждён');
    await page.goto('/account/sessions');
    await expect(page.getByText('Email подтверждён', { exact: true })).toBeVisible();
    const recovery = await insert('reset');
    const nextPassword = `Recovered-${randomUUID()}!`;
    await page.goto(`/auth/reset-password/confirm#token=${recovery}`);
    await expect(page).toHaveURL(/\/auth\/reset-password\/confirm$/);
    await page.getByLabel('Новый пароль', { exact: true }).fill(nextPassword);
    await page.getByRole('button', { name: 'Изменить пароль', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText(
      'Пароль обновлён. Войди снова на своих устройствах.',
    );
    const expiredSession = await page.request.get('/api/v1/auth/me');
    expect((await expiredSession.json()).user).toBeNull();
    const login = await page.request.post('/api/v1/auth/login', {
      data: { email, password: nextPassword },
    });
    expect(login.ok()).toBeTruthy();
    await page.goto(`/auth/reset-password/confirm#token=${recovery}`);
    await page.getByLabel('Новый пароль', { exact: true }).fill(`Another-${randomUUID()}!`);
    await page.getByRole('button', { name: 'Изменить пароль', exact: true }).click();
    await expect(
      page.getByText('Ссылка недействительна или уже использована. Запроси новую.', {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await db.end();
  }
});
