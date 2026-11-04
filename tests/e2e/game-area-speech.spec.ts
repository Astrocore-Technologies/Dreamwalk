import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

for (const locale of ['ru', 'en', 'uk'] as const) {
  test(`all speech modes can post without selecting an NPC (${locale})`, async ({ page }) => {
    const handle = `area_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const account = await page.request.post('/api/v1/auth/register', {
      data: {
        handle,
        name: 'Synthetic area speech',
        email: `${handle}@example.test`,
        password: `Speech-${randomUUID()}!`,
      },
    });
    expect(account.ok()).toBeTruthy();
    expect(
      (await page.request.patch('/api/v1/account/settings', { data: { language: locale } })).ok(),
    ).toBeTruthy();
    await page.addInitScript(
      (language) => localStorage.setItem('dreamwalk-language', language),
      locale,
    );
    const created = await page.request.post('/api/v1/game/campaigns', {
      data: { template: 'observatory-v1', turnBased: true },
    });
    expect(created.ok()).toBeTruthy();
    const id = (await created.json()).campaignId;
    const copy = {
      ru: { send: 'Отправить', confirm: 'Подтвердить ход', whisper: 'Шёпот' },
      en: { send: 'Send', confirm: 'Confirm turn', whisper: 'Whisper' },
      uk: { send: 'Надіслати', confirm: 'Підтвердити хід', whisper: 'Шепіт' },
    }[locale];
    await page.goto(`/game/${id}`);
    const composer = page.getByTestId('unified-story').locator('form');
    const input = composer.locator('textarea');
    const whisper = composer.getByRole('button', { name: copy.whisper, exact: true });
    for (const speech of [
      { text: 'Good morning', channel: 'say' },
      { text: 'Can anyone hear me!', channel: 'say' },
      { text: 'Quiet words!', channel: 'whisper' },
    ]) {
      if (speech.channel === 'whisper') await whisper.click();
      await expect(whisper).toHaveAttribute('aria-pressed', String(speech.channel === 'whisper'));
      await input.fill(speech.text);
      const send = composer.getByRole('button', { name: copy.send, exact: true });
      await expect(send).toBeEnabled();
      const quoted = page.waitForResponse((response) =>
        response.url().endsWith(`/game/campaigns/${id}/turns/quote`),
      );
      await send.click();
      const quoteResponse = await quoted;
      expect(quoteResponse.ok()).toBeTruthy();
      const quoteInput = quoteResponse.request().postDataJSON();
      expect(quoteInput.targetNpcId).toBeUndefined();
      expect(quoteInput.channel).toBe(speech.channel);
      expect(quoteInput.text).toBe(speech.text);
      const submitResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().endsWith(`/game/campaigns/${id}/turns`),
      );
      await composer.getByRole('button', { name: copy.confirm, exact: true }).click();
      const submitted = await submitResponse;
      expect(submitted.ok()).toBeTruthy();
      const submittedInput = submitted.request().postDataJSON();
      expect(submittedInput.operationId).toBe(quoteInput.operationId);
      expect(submittedInput.targetNpcId).toBeUndefined();
      expect(submittedInput.channel).toBe(speech.channel);
      await expect(input).toHaveValue('');
    }
    // Nothing ends the player turn here: no world generation or paid provider call is needed.
  });
}
