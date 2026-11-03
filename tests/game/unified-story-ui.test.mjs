import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sceneClick } from '../../apps/web/components/game/scene-input.ts';
import { api } from '../../apps/web/lib/client.tsx';
import {
  storyTargetValid,
  storyDraftKey,
  storyRecipientLabel,
} from '../../apps/web/components/game/story-turn-guards.ts';
test('API sends the selected default locale without dropping headers, cookies or upload boundaries', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    calls.push({ path, options });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  await api('/locale-test', { method: 'POST', body: JSON.stringify({ text: 'hello' }) });
  assert.equal(calls[0].path, '/api/v1/locale-test');
  assert.equal(calls[0].options.headers.get('Accept-Language'), 'ru');
  assert.equal(calls[0].options.headers.get('Content-Type'), 'application/json');
  assert.equal(calls[0].options.credentials, 'include');
  for (const locale of ['uk', 'en', 'ru']) {
    const headers = new Headers({ 'Accept-Language': locale, 'X-Request-Test': 'retained' });
    const body = new FormData();
    body.set('name', 'plain text');
    await api('/locale-test', { method: 'POST', headers, body });
    const sent = calls.at(-1).options;
    assert.equal(sent.headers.get('Accept-Language'), locale);
    assert.equal(sent.headers.get('X-Request-Test'), 'retained');
    assert.equal(sent.headers.has('Content-Type'), false);
    assert.equal(headers.has('Content-Type'), false);
    assert.notEqual(sent.headers, headers);
    assert.equal(sent.body, body);
  }
});
test('story quotes and uncertain resubmissions retain the captured reply locale, not a later UI preference', async () => {
  const source = await readFile(
    new URL('../../apps/web/components/game/unified-story.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /replyLocale: getLocale\(\)/);
  assert.match(source, /setPrepared\(\{ input, result, mapId: projection.map.id, key \}\)/);
  assert.match(source, /const sent = recover \? submitted.current : prepared/);
  assert.match(source, /\.\.\.sent.input,/);
  assert.match(source, /data-testid="story-reply-language"/);
  assert.match(source, /prepared.input.replyLocale/);
  const legacy = await readFile(
    new URL('../../apps/web/components/game/living-conversation.tsx', import.meta.url),
    'utf8',
  );
  assert.match(legacy, /speech: \{ channel, text: sent.trim\(\), replyLocale: getLocale\(\) \}/);
});
test('visible NPC click selects only, free floor moves, walls and closed doors do neither', () => {
  const p = {
    map: { width: 8, height: 8, blocked: [{ x: 1, y: 1 }] },
    entities: [
      { id: 'n', kind: 'npc', x: 3, y: 4 },
      { id: 'd', kind: 'door', x: 2, y: 2, open: false },
    ],
  };
  assert.deepEqual(sceneClick(p, 3, 4), { kind: 'npc', npcId: 'n' });
  assert.deepEqual(sceneClick(p, 4, 4), { kind: 'move', target: { x: 4, y: 4 } });
  for (const [x, y] of [
    [1, 1],
    [2, 2],
    [-1, 0],
    [8, 1],
    [1, 8],
    [NaN, 1],
    [1.5, 1],
  ])
    assert.equal(sceneClick(p, x, y), null);
});
test('persisted literal stars and HTML stay plain text; only authoritative entry kind controls emphasis', async () => {
  const source = await readFile(
    new URL('../../apps/web/components/game/unified-story.tsx', import.meta.url),
    'utf8',
  );
  const css = await readFile(
    new URL('../../apps/web/components/game/story-feed.module.css', import.meta.url),
    'utf8',
  );
  assert.match(source, /if \(entry.text\) return entry.text/);
  assert.doesNotMatch(source, /storyTextSegments|dangerouslySetInnerHTML|<StoryText/);
  assert.match(source, /data-story-kind=\{entry.kind\}/);
  assert.match(css, /\[data-story-kind='attempt'\] p/);
  // The server removes raw escapes before persistence: client parsing would incorrectly
  // turn the resulting literal "*not an action*" speech into an attempted action.
});
test('one primary story surface replaces competing forms and guards private recipient, order and consent', async () => {
  const page = await readFile(
    new URL('../../apps/web/components/game/game-page.tsx', import.meta.url),
    'utf8',
  );
  assert.match(page, /<UnifiedStory/);
  assert.doesNotMatch(page, /<NarrativeDirector|<LivingConversation|<IntentProposals|<PartyChat/);
  const source = await readFile(
    new URL('../../apps/web/components/game/unified-story.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /feed\?\.entries.map/);
  assert.doesNotMatch(source, /entries.sort|dangerouslySetInnerHTML/);
  assert.match(source, /!targetValid/);
  assert.match(source, /storyTargetValid\(projection, channel, targetNpcId\)/);
  assert.match(source, /confirmedActionHash: sent.result.confirmationHash/);
  assert.match(source, /consent: true/);
  assert.match(source, /submitted.current = sent/);
  // The single story composer no longer exposes a competing OOC surface.
  assert.doesNotMatch(source, /<PartyChat|tab === 'ooc'|tab !== 'ooc'|setTab/);
  assert.match(source, /aria-label=\{h\('composer'\)\}/);
});

test('private target loss is blocked and every consent-relevant draft change invalidates its identity', () => {
  const p = { entities: [{ id: 'keeper', kind: 'npc' }] };
  assert.equal(storyTargetValid(p, 'whisper', 'keeper'), true);
  assert.equal(storyTargetValid(p, 'whisper'), false);
  assert.equal(storyTargetValid({ entities: [] }, 'whisper', 'keeper'), false);
  assert.equal(storyTargetValid(p, 'say', 'missing'), false);
  assert.equal(storyTargetValid(p, 'say'), true);
  const original = storyDraftKey('secret', 'whisper', 'keeper', 'room');
  for (const altered of [
    storyDraftKey('other', 'whisper', 'keeper', 'room'),
    storyDraftKey('secret', 'say', 'keeper', 'room'),
    storyDraftKey('secret', 'whisper', 'helper', 'room'),
    storyDraftKey('secret', 'whisper', 'keeper', 'roof'),
  ])
    assert.notEqual(original, altered);
  assert.equal(original, storyDraftKey(' secret ', 'whisper', 'keeper', 'room'));
});
test('selected NPC display label updates with locale without changing the selected identity', () => {
  const recipient = { id: 'keeper', label: 'Доглядач' };
  for (const label of ['Доглядач', 'Keeper', 'Смотритель']) {
    const projection = { entities: [{ id: 'keeper', kind: 'npc', label }] };
    assert.equal(storyRecipientLabel(projection, recipient), label);
    assert.equal(storyTargetValid(projection, 'whisper', recipient.id), true);
  }
  assert.equal(recipient.label, 'Доглядач');
  assert.equal(storyRecipientLabel({ entities: [] }, recipient), 'Доглядач');
  assert.equal(storyTargetValid({ entities: [] }, 'whisper', recipient.id), false);
  assert.equal(storyRecipientLabel({ entities: [] }, null), null);
});
test('every unified interface message has explicit RU, EN and UK strings', async () => {
  const source = await readFile(
    new URL('../../apps/web/components/game/story-messages.ts', import.meta.url),
    'utf8',
  );
  const { transformSync } = await import('esbuild');
  const code =
    source
      .slice(
        source.indexOf('export const storyMessages'),
        source.indexOf('export type StoryMessageKey'),
      )
      .replace('export const', 'const') + '\nreturn storyMessages;';
  const js = transformSync('(function(){' + code + '})()', { loader: 'ts', target: 'es2022' }).code;
  const messages = new Function('return ' + js)();
  for (const [key, values] of Object.entries(messages)) {
    assert.equal(values.length, 3, key);
    assert.ok(
      values.every((value) => typeof value === 'string' && value.trim()),
      key,
    );
  }
});

test('ordinary gameplay offers one compact composer estimate instead of diagnostic generation controls', async () => {
  const page = await readFile(
    new URL('../../apps/web/components/game/game-page.tsx', import.meta.url),
    'utf8',
  );
  const composer = await readFile(
    new URL('../../apps/web/components/game/unified-story.tsx', import.meta.url),
    'utf8',
  );
  const cost = await readFile(
    new URL('../../apps/web/components/game/story-cost.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(page, /LiveTestPanel/);
  assert.match(composer, /<StoryCost quote=/);
  assert.doesNotMatch(composer, /ProviderSparkReserve|SparkQuoteNotice|type="checkbox"/);
  assert.match(cost, /estimatedTotalMicros/);
  assert.match(cost, /estimatedHold/);
  assert.match(cost, /providerEstimateOnly/);
  assert.doesNotMatch(cost, /USD|formatUsd/);
  assert.match(composer, /setTimeout\(expire, remaining\)/);
  assert.match(composer, /actionLock.current = true/);
  assert.match(composer, /sent.key !== draftKey/);
  assert.doesNotMatch(composer, /h\('demo'\)/);
  const messages = await readFile(
    new URL('../../apps/web/components/game/story-messages.ts', import.meta.url),
    'utf8',
  );
  assert.match(messages, /Искры не списываются/);
});
