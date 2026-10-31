import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  canRetryEncounterBegin,
  encounterRetryContext,
} from '../../apps/web/components/game/encounter-retry.ts';
const before = {
  streamId: 'stream',
  connectionEpoch: 7,
  revision: 2,
  actorId: 'player',
  mapId: 'room',
  x: 2,
  y: 3,
  movementGeneration: 4,
  lastInputSeq: 8,
  inEncounter: false,
};
const base = {
  type: 'encounter.begin',
  status: 'rejected',
  code: 'STALE_STATE',
  attempts: 0,
  connected: true,
  before,
  after: { ...before, revision: 3 },
};
test('one explicit stale coordination rejection can rebase a nonsemantic NPC revision', () => {
  assert.equal(canRetryEncounterBegin(base), true);
  assert.equal(canRetryEncounterBegin({ ...base, after: { ...before } }), false);
  assert.equal(canRetryEncounterBegin({ ...base, attempts: 1 }), false);
  assert.equal(canRetryEncounterBegin({ ...base, status: 'committed' }), false);
  assert.equal(canRetryEncounterBegin({ ...base, status: 'unknown' }), false);
  assert.equal(canRetryEncounterBegin({ ...base, code: 'NETWORK_ERROR' }), false);
  for (const type of [
    'action',
    'npc.request',
    'npc.speech',
    'encounter.intent',
    'encounter.join',
    'encounter.end',
  ])
    assert.equal(canRetryEncounterBegin({ ...base, type }), false);
});
test('own movement, scene, encounter, connection or lease change forbids stale retry', () => {
  for (const change of [
    { actorId: 'other' },
    { mapId: 'roof' },
    { x: 3 },
    { y: 4 },
    { movementGeneration: 5 },
    { lastInputSeq: 9 },
    { inEncounter: true },
    { streamId: 'new' },
    { connectionEpoch: 8 },
  ])
    assert.equal(
      canRetryEncounterBegin({ ...base, after: { ...base.after, ...change } }),
      false,
      JSON.stringify(change),
    );
  assert.equal(canRetryEncounterBegin({ ...base, connected: false }), false);
  assert.equal(canRetryEncounterBegin({ ...base, before: null }), false);
  assert.equal(canRetryEncounterBegin({ ...base, after: null }), false);
  assert.equal(
    canRetryEncounterBegin({ ...base, before: { ...before, inEncounter: true } }),
    false,
  );
});
test('retry context is a captured value, not a mutable NPC/world reference', () => {
  const envelope = {
    streamId: 'stream',
    connectionEpoch: 7,
    projection: {
      actorId: 'player',
      revision: 2,
      map: { id: 'room' },
      entities: [{ id: 'player', x: 2, y: 3, movementGeneration: 4, lastInputSeq: 8 }],
    },
  };
  const captured = encounterRetryContext(envelope);
  assert.deepEqual(captured, before);
  envelope.projection.entities[0].x = 9;
  assert.equal(captured.x, 2);
  assert.equal(encounterRetryContext(null), null);
  assert.equal(
    encounterRetryContext({ ...envelope, projection: { ...envelope.projection, entities: [] } }),
    null,
  );
});
test('actual hook keeps unknown request IDs and limits retry to explicit stale begin; members refresh bounded and visible', async () => {
  const hook = await readFile(
    new URL('../../apps/web/components/game/use-game.ts', import.meta.url),
    'utf8',
  );
  assert.match(hook, /canRetryEncounterBegin\(/);
  assert.match(hook, /retry.current.body/);
  assert.match(hook, /encounterRetries\+\+/);
  assert.match(hook, /socket.current === initialSocket/);
  assert.match(hook, /operationId: crypto.randomUUID\(\),\s*expectedRevision: after!.revision/);
  const page = await readFile(
    new URL('../../apps/web/components/game/game-page.tsx', import.meta.url),
    'utf8',
  );
  assert.match(page, /if \(!connected\) return/);
  assert.match(page, /document.visibilityState === 'visible'/);
  assert.match(page, /setInterval\(reloadIfVisible, 5000\)/);
  assert.match(page, /removeEventListener\('visibilitychange', reloadIfVisible\)/);
  assert.match(page, /data-member-status=\{member.status\}/);
});
