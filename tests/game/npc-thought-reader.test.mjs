import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { npcThoughtMessages } from '../../apps/web/components/game/npc-thought-messages.ts';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const reader = read('apps/web/components/game/npc-thought-reader.tsx');

test('thought reader has complete localized provenance, empty and unavailable states', () => {
  for (const locale of ['ru', 'en', 'uk']) {
    assert.deepEqual(Object.keys(npcThoughtMessages[locale]), Object.keys(npcThoughtMessages.en));
    for (const value of Object.values(npcThoughtMessages[locale])) assert.ok(value.trim());
  }
  assert.match(npcThoughtMessages.en.provenance, /Fictional.*not hidden model reasoning/);
});

test('thought retrieval is separate, lazy, uncached and discarded on collapse or unmount', () => {
  assert.match(reader, /open && <ThoughtContent/);
  assert.match(reader, /signal: controller.signal, cache: 'no-store'/);
  assert.match(reader, /active = false;\s+controller.abort\(\)/);
  assert.match(reader, /if \(!active\) return/);
  assert.match(reader, /value.npcId !== npcId/);
  assert.match(reader, /aria-expanded=\{open\}/);
  assert.match(reader, /aria-controls=\{contentId\}/);
  assert.doesNotMatch(reader, /dangerouslySetInnerHTML|localStorage|sessionStorage/);
});

test('reader preserves public inspection Talk and keys private state to selected NPC', () => {
  const inspection = read('apps/web/components/game/npc-public-inspection.tsx');
  assert.ok(inspection.indexOf('npc-inspection-talk') < inspection.indexOf('<NpcThoughtReader'));
  assert.match(inspection, /key=\{`\$\{campaignId\}:\$\{npcId\}`\}/);
  assert.match(inspection, /canReadThoughts &&/);
  const controller = read('apps/api/src/game/game.controller.ts');
  assert.match(controller, /npcs\/:npcId\/inner-thought/);
  assert.match(controller, /@Header\('Cache-Control', 'no-store'\)/);
  assert.match(controller, /this.game.npcInnerThought\(req, id, npcId\)/);
});

test('turn-based posts disclose deferred world cost without replacing legacy recovery', () => {
  const composer = read('apps/web/components/game/unified-story.tsx');
  const cost = read('apps/web/components/game/story-cost.tsx');
  assert.match(composer, /projection.turn \? \([\s\S]*data-testid="world-batch-posting"/);
  assert.match(composer, /turn.generationNeedsConfirmation/);
  assert.match(composer, /<StoryReplyConfirmation/);
  assert.match(
    cost,
    /quote.provider === 'local-turn-resolver' && !quote.external && quote.credits === 0/,
  );
  assert.match(cost, /h\('worldBatchCost'\)/);
  assert.match(cost, /<FundingBreakdown funding=\{quote.funding\}/);
});
