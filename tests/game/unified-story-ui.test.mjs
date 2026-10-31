import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sceneClick } from '../../apps/web/components/game/scene-input.ts';
import {
  storyTargetValid,
  storyDraftKey,
} from '../../apps/web/components/game/story-turn-guards.ts';
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
  assert.match(source, /hidden=\{tab !== 'ooc'\}/);
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
