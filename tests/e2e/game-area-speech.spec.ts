import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createAuthoredDraft } from '@dreamwalk/game-core';
import type { GameProjection, StoryTurnFeed } from '@dreamwalk/contracts';
import {
  authoringRequest,
  publishPrivateFixture,
  savePrivateFixture,
} from './support/private-authoring';

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

for (const locale of ['ru', 'en', 'uk'] as const) {
  test(`legacy composer explains its recipient requirement without quoting targetless whispers (${locale})`, async ({
    page,
  }) => {
    const handle = `legacy_area_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const account = await page.request.post('/api/v1/auth/register', {
      data: {
        handle,
        name: 'Synthetic legacy speech',
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
    // The original observatory-v1 template predates the story composer entirely.
    // Exercise an existing-style hybrid-v3 save with no turn controller instead.
    const story = await authoringRequest(page, '/studio/adventures', {
      title: `Legacy speech ${handle}`,
    });
    const draft = createAuthoredDraft('courtyard');
    draft.npcBehavior = 'reactive-v1';
    delete draft.turnRules;
    await savePrivateFixture(page, story.id, draft);
    const release = await publishPrivateFixture(page, story.id);
    const created = await page.request.post('/api/v1/game/campaigns', {
      data: { playableVersionId: release.playableVersionId, turnBased: false },
    });
    expect(created.ok()).toBeTruthy();
    const id = (await created.json()).campaignId;
    const snapshot = await page.request.get(`/api/v1/game/campaigns/${id}/snapshot`);
    expect(snapshot.ok()).toBeTruthy();
    const projection: GameProjection = (await snapshot.json()).projection;
    expect(projection.rulesetVersion).toBe('hybrid-v3');
    expect(projection.turn).toBeUndefined();
    const feedResponse = await page.request.get(`/api/v1/game/campaigns/${id}/turns/feed`);
    expect(feedResponse.ok()).toBeTruthy();
    const feed: StoryTurnFeed = await feedResponse.json();
    expect(feed.canSubmit, 'The compatibility fixture supports the legacy story composer').toBe(
      true,
    );
    expect(feed.unavailableReason).toBeNull();
    const copy = {
      ru: {
        send: 'Отправить',
        whisper: 'Шёпот',
        warning: 'В старом сохранении шёпот без собеседника недоступен.',
      },
      en: {
        send: 'Send',
        whisper: 'Whisper',
        warning: 'Whispering without a recipient is unavailable in this old save.',
      },
      uk: {
        send: 'Надіслати',
        whisper: 'Шепіт',
        warning: 'У старому збереженні шепіт без співрозмовника недоступний.',
      },
    }[locale];
    let quotes = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === `/api/v1/game/campaigns/${id}/turns/quote`) quotes++;
    });
    await page.goto(`/game/${id}`);
    const composer = page.getByTestId('unified-story').locator('form');
    const input = composer.locator('textarea');
    const send = composer.getByRole('button', { name: copy.send, exact: true });
    await expect(composer.getByTestId('legacy-speech-hint')).toBeVisible();
    await expect(composer.getByTestId('area-speech-hint')).toHaveCount(0);
    await input.fill('Keep this draft');
    await expect(send).toBeEnabled();
    const whisper = composer.getByRole('button', { name: copy.whisper, exact: true });
    await whisper.click();
    await expect(whisper).toHaveAttribute('aria-pressed', 'true');
    await expect(send).toBeDisabled();
    await expect(composer).toContainText(copy.warning);
    await expect(input).toHaveValue('Keep this draft');
    expect(quotes).toBe(0);
    await whisper.click();
    await expect(send).toBeEnabled();
    await expect(input).toHaveValue('Keep this draft');
    expect(quotes).toBe(0);
  });
}
