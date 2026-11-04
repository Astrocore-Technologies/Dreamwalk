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
  // Isolate each request/confirmation journey so a slow channel cannot consume the
  // next channel's test deadline or leave it with an earlier post's state.
  for (const speech of [
    { mode: 'normal speech', text: 'Good morning', channel: 'say' },
    { mode: 'shouted speech', text: 'Can anyone hear me!', channel: 'say' },
    { mode: 'whispered speech', text: 'Quiet words!', channel: 'whisper' },
  ] as const) {
    test(`${speech.mode} can post without selecting an NPC (${locale})`, async ({ page }) => {
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
        ru: {
          send: 'Отправить',
          confirm: 'Подтвердить ход',
          whisper: 'Шёпот',
          actions: 'Действия',
          inspect: 'Осмотреть',
          close: 'Закрыть осмотр',
          say: 'Сказать',
          nearby: 'Речь рядом',
          nearbyWhisper: 'Шёпот рядом',
          clear: 'Обратиться к ведущему',
        },
        en: {
          send: 'Send',
          confirm: 'Confirm turn',
          whisper: 'Whisper',
          actions: 'Actions',
          inspect: 'Inspect',
          close: 'Close inspection',
          say: 'Say',
          nearby: 'Speech nearby',
          nearbyWhisper: 'Nearby whisper',
          clear: 'Address the director',
        },
        uk: {
          send: 'Надіслати',
          confirm: 'Підтвердити хід',
          whisper: 'Шепіт',
          actions: 'Дії',
          inspect: 'Оглянути',
          close: 'Закрити огляд',
          say: 'Сказати',
          nearby: 'Мова поруч',
          nearbyWhisper: 'Шепіт поруч',
          clear: 'Звернутися до ведучого',
        },
      }[locale];
      await page.goto(`/game/${id}`);
      const composer = page.getByTestId('unified-story').locator('form');
      const input = composer.locator('textarea');
      const whisper = composer.getByRole('button', { name: copy.whisper, exact: true });
      // Inspection stays available, but neither the map nor Talk selects a speech target.
      await page.getByRole('button', { name: copy.actions, exact: true }).click();
      const npcActions = page
        .getByRole('dialog', { name: copy.actions, exact: true })
        .locator('[data-map-target="keeper"]');
      await expect(npcActions.getByRole('button', { name: copy.say, exact: true })).toHaveCount(0);
      await npcActions.getByRole('button', { name: copy.inspect, exact: true }).click();
      const inspection = page.getByTestId('npc-public-inspection');
      await expect(inspection).toBeVisible();
      // The card intentionally takes focus after the map menu's dismissal cleanup.
      // Wait for that frame before Talk moves it to the composer.
      await expect(inspection.getByRole('button', { name: copy.close, exact: true })).toBeFocused();
      await inspection.getByTestId('npc-inspection-talk').click();
      await expect(input).toBeFocused();
      await expect(composer.getByTestId('story-audience')).toHaveText(copy.nearby);
      await expect(composer.getByRole('button', { name: copy.clear, exact: true })).toHaveCount(0);
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
      await expect(composer.getByTestId('story-quote')).toBeVisible();
      // Even after a quote is prepared, repeated inspection actions preserve the draft,
      // channel and authorization instead of binding the post to that NPC.
      for (let click = 0; click < 2; click++) {
        await inspection.getByTestId('npc-inspection-talk').click();
        await expect(input).toBeFocused();
        await expect(input).toHaveValue(speech.text);
        await expect(composer.getByTestId('story-audience')).toHaveText(
          speech.channel === 'whisper' ? copy.nearbyWhisper : copy.nearby,
        );
        await expect(composer.getByTestId('story-quote')).toBeVisible();
      }
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
      // Nothing ends the player turn here: no world generation or paid provider call is needed.
    });
  }
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
