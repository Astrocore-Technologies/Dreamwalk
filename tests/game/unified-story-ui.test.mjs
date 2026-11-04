import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sceneClick } from '../../apps/web/components/game/scene-input.ts';
import { api } from '../../apps/web/lib/client.tsx';
import {
  storyTargetValid,
  storyDraftKey,
  storyRecipientLabel,
  storyRecipientForProjection,
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

test('grid speech ignores any selected NPC and inspection never chooses a recipient', async () => {
  const recipient = { id: 'keeper', label: 'Keeper' };
  const turnBased = { entities: [], turn: { phase: 'player' } };
  const effectiveRecipient = storyRecipientForProjection(turnBased, recipient);
  assert.equal(effectiveRecipient, null);
  assert.equal(storyRecipientForProjection(turnBased, null), null);
  assert.equal(storyRecipientForProjection({ entities: [] }, recipient), recipient);
  for (const channel of ['say', 'whisper']) {
    assert.equal(storyTargetValid(turnBased, channel, effectiveRecipient?.id), true);
    assert.equal(
      storyDraftKey('Keep this draft', channel, effectiveRecipient?.id, 'room'),
      storyDraftKey('Keep this draft', channel, undefined, 'room'),
    );
  }
  const composer = await readFile(
    new URL('../../apps/web/components/game/unified-story.tsx', import.meta.url),
    'utf8',
  );
  assert.match(composer, /storyRecipientForProjection\(projection, recipient\)/);
  assert.match(composer, /const targetNpcId = activeRecipient\?\.id/);
  assert.match(composer, /\{activeRecipient && \(/);
  assert.match(composer, /'nearbySpeech'/);
  const page = await readFile(
    new URL('../../apps/web/components/game/game-page.tsx', import.meta.url),
    'utf8',
  );
  assert.match(page, /if \(p.turn\) \{\s*setInspectedNpcId\(npcId\);\s*return;/);
  assert.match(page, /if \(!p.turn && npc && !controlsDisabled && !storyBusy\)/);
  const actions = await readFile(
    new URL('../../apps/web/components/game/map-actions.tsx', import.meta.url),
    'utf8',
  );
  assert.match(actions, /!projection.turn && \([\s\S]*?onSay\(e.id\)/);
});

test('private target loss is blocked and every consent-relevant draft change invalidates its identity', () => {
  const p = { entities: [{ id: 'keeper', kind: 'npc' }], turn: { phase: 'player' } };
  assert.equal(storyTargetValid(p, 'whisper', 'keeper'), true);
  assert.equal(storyTargetValid(p, 'whisper'), true);
  assert.equal(storyTargetValid({ entities: [], turn: { phase: 'player' } }, 'whisper'), true);
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
test('legacy whispers require a recipient without blocking turn-based area speech', async () => {
  const legacy = { entities: [{ id: 'keeper', kind: 'npc' }] };
  assert.equal(storyTargetValid(legacy, 'say'), true);
  assert.equal(storyTargetValid(legacy, 'whisper'), false);
  assert.equal(storyTargetValid(legacy, 'whisper', 'keeper'), true);
  assert.equal(storyTargetValid(legacy, 'whisper', 'missing'), false);
  const turnBased = { ...legacy, turn: { phase: 'player' } };
  assert.equal(storyTargetValid(turnBased, 'say'), true);
  assert.equal(storyTargetValid(turnBased, 'whisper'), true);
  assert.equal(storyTargetValid(turnBased, 'whisper', 'missing'), false);
  const composer = await readFile(
    new URL('../../apps/web/components/game/unified-story.tsx', import.meta.url),
    'utf8',
  );
  assert.match(composer, /h\(projection.turn \? 'areaSpeech' : 'legacySpeech'\)/);
  assert.match(composer, /h\(projection.turn \? 'areaWhisper' : 'legacyChooseWhisper'\)/);
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

test('viewport layout separates history from stable composer and removes the scene-media control only', async () => {
  const read = (file) => readFile(new URL(`../../apps/web/${file}`, import.meta.url), 'utf8');
  const story = await read('components/game/unified-story.tsx');
  assert.doesNotMatch(story, /SceneMedia|styles\.media|nearBottom/);
  assert.match(story, /useStoryScroll/);
  assert.match(story, /className=\{styles\.history\}/);
  assert.match(story, /className=\{styles\.composerFeedback\}/);
  const scroll = await read('components/game/use-story-scroll.ts');
  assert.match(scroll, /new ResizeObserver\(restore\)/);
  assert.match(scroll, /saved\.anchor\.offset/);
  assert.doesNotMatch(scroll, /scrollIntoView|window\.scroll/);
  const page = await read('components/game/game-page.tsx');
  assert.doesNotMatch(page, /fitPlaySurface/);
  assert.match(page, /data-testid="campaign-details"/);
  assert.match(page, /if \(encounter\?\.id\) setExtrasOpen\(true\)/);
  const css = await read('components/game/story-feed.module.css');
  assert.match(css, /scrollbar-gutter: stable/);
  assert.match(css, /overflow-anchor: none/);
  assert.match(css, /resize: none/);
  assert.match(css, /\.history\s*\{[^}]*flex: 1 1 0;[^}]*min-height: 72px/s);
  assert.match(
    css,
    /:global\(\.game-shell\) \.composer\s*\{[^}]*flex: 0 1 auto;[^}]*min-height: 0;[^}]*max-height: none/s,
  );
  assert.match(css, /\.composer > :not\(\.composerFeedback\)\s*\{[^}]*flex-shrink: 0/s);
  assert.match(
    css,
    /\.composerFeedback\s*\{[^}]*flex: 0 1 auto;[^}]*min-height: 0;[^}]*overflow-y: auto/s,
  );
  const shell = await read('app/design-system.css');
  assert.match(shell, /height: 100dvh/);
  assert.match(shell, /\.main-content > \[data-locale\]/);
  assert.match(shell, /\.game-shell:has\(\[data-testid='game-room'\]\)/);
  // Underlying explicit image generation / binding and cost-consent components remain.
  assert.match(await read('components/game/scene-media.tsx'), /media-preparation/);
  assert.match(story, /<WorldGenerationConfirmation|<StoryReplyConfirmation/);
});

test('public NPC inspection occupies history without replacing the composer or issuing a command', async () => {
  const read = (file) =>
    readFile(new URL(`../../apps/web/components/game/${file}`, import.meta.url), 'utf8');
  const page = await read('game-page.tsx');
  const story = await read('unified-story.tsx');
  const card = await read('npc-public-inspection.tsx');
  const css = await read('story-feed.module.css');
  assert.equal((page.match(/<UnifiedStory/g) || []).length, 1);
  assert.match(page, /inspection=\{/);
  assert.match(page, /publicProfile\?\.role \|\| inspectedNpc\.supportingNpc\?\.roleLabel/);
  assert.match(page, /portraitUrl=\{inspectedPortraitUrl\}/);
  assert.match(page, /if \(!p.turn && npc && !controlsDisabled && !storyBusy\)/);
  assert.match(story, /data-inspecting=\{!!inspection\}/);
  assert.match(story, /aria-hidden=\{!!inspection\}/);
  assert.match(story, /tabIndex=\{inspection \? -1 : 0\}/);
  assert.match(
    story,
    /inspection && <div className=\{styles\.inspectionLayer\}>\{inspection\}<\/div>/,
  );
  assert.match(css, /visibility: hidden/);
  assert.match(css, /\.inspectionLayer\s*\{[^}]*container-type: size/s);
  assert.match(await read('npc-public-inspection.module.css'), /max-height: min\(240px, 35cqh\)/);
  assert.match(
    css,
    /\.inspectionLayer\s*\{[^}]*position: absolute;[^}]*inset: 0;[^}]*overflow-y: auto;/s,
  );
  assert.doesNotMatch(
    card,
    /dangerouslySetInnerHTML|\bapi\(|\bfetch\(|\bcommand\(|\bprepare\(|\bsubmit\(|secrets|personality|roleId/,
  );
  assert.match(card, /role &&/);
  assert.match(card, /portraitUrl &&/);
  assert.match(card, /event.key === 'Escape'/);
  assert.match(card, /focus\(\{ preventScroll: true \}\)/);
  assert.match(card, /onTalk\(\);/);
});
