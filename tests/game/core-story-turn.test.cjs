const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
function world() {
  const d = g.createCompleteObservatoryDraft();
  delete d.supportingNpcPolicy;
  return g.createStateFromPlayable(g.compilePlayableDraft(d).playable, ['alice', 'bob']);
}
function input(text, targetNpcId = 'keeper', channel = 'say') {
  return {
    operationId: randomUUID(),
    text,
    channel,
    ...(targetNpcId ? { targetNpcId } : {}),
    expectedCanonRevision: 0,
  };
}
function near() {
  const s = world();
  Object.assign(s.entities.alice, { x: 5, y: 4 });
  return s;
}
function turn(s, i) {
  const id = randomUUID();
  const p = g.createMockStoryTurnProposal(s, 'alice', i, id);
  return { p, id, r: g.applyStoryTurnProposal(s, 'alice', i, id, p) };
}
test('story composer parses escapes, rejects malformed and bounded segments, clarifies movement', () => {
  assert.deepEqual(
    g.parseStorySegments('hello \\*literal\\* *wait* yes').segments.map((s) => [s.kind, s.text]),
    [
      ['speech', 'hello *literal*'],
      ['attempt', 'wait'],
      ['speech', 'yes'],
    ],
  );
  for (const text of ['*unclosed', '**', '* *', ''])
    assert.equal(g.parseStorySegments(text).code, 'INVALID_MARKUP');
  assert.equal(g.parseStorySegments('*wait* a *wait* b *wait*').code, 'TOO_MANY_SEGMENTS');
  for (const text of ['*walk to keeper*', '*подхожу к двери*', '*йду до дверей*'])
    assert.equal(g.parseStorySegments(text).code, 'WALK_FIRST');
});
test('targeted dialogue uses only addressed NPC safe memory and excludes director/secrets', () => {
  const s = near();
  s.npcBrains.keeper.living.observations.push({
    id: 'secret-x',
    eventId: 'secret-x',
    rootId: 'secret-x',
    tick: 0,
    kind: 'authored_fact',
    confidence: 1,
    disclosure: 'private',
    revealCondition: 'never',
    definitionText: 'HIDDEN GOLD',
    title: 'SECRET',
    audienceIds: [],
    depth: 0,
  });
  const ctx = g.buildStoryTurnContext(s, 'alice', input('Hello'), randomUUID());
  assert.equal(ctx.director, undefined);
  assert.ok(!JSON.stringify(ctx).includes('HIDDEN GOLD'));
  assert.ok(!ctx.mechanics.some((e) => e.id === 'journal'));
});
test('ordered actions precede NPC reply; several speech segments survive stable source selection', () => {
  const s = near();
  const i = input('Hello *wait* Thank you');
  const { r } = turn(s, i);
  assert.equal(r.error, undefined);
  assert.deepEqual(
    r.entries.map((e) => e.kind),
    ['speech', 'npc_reply', 'attempt', 'outcome', 'speech', 'npc_reply'],
  );
  assert.equal(s.npcUtterances?.length ?? 0, 0);
  const speechEntries = r.entries.filter((e) => ['speech', 'npc_reply'].includes(e.kind));
  assert.equal(new Set(speechEntries.map((e) => e.sourceId)).size, speechEntries.length);
  assert.ok(
    speechEntries.every(
      (e) =>
        e.sourceId &&
        r.state.npcUtterances.some((u) => u.id === e.sourceId && u.speakerId === e.authorId),
    ),
  );
});
test('whispers never create canon or public prose; physical outcomes only safe templates', () => {
  const s = near();
  const { r, p, id } = turn(s, input('private *wait*', 'keeper', 'whisper'));
  assert.equal(r.error, undefined);
  assert.equal(r.state.narrativeCanon, s.narrativeCanon);
  for (const entry of r.entries.filter((e) => e.kind !== 'outcome'))
    assert.deepEqual(new Set(entry.audienceIds), new Set(['alice', 'keeper']));
  assert.equal(r.entries.find((e) => e.kind === 'outcome').text, undefined);
  p.narrative = { narration: 'leak', newScene: null, newNpc: null, evidenceIds: [] };
  assert.equal(
    g.applyStoryTurnProposal(s, 'alice', input('private *wait*', 'keeper', 'whisper'), id, p).error,
    'FORBIDDEN',
  );
  assert.throws(
    () => g.buildStoryTurnContext(s, 'alice', input('secret', null, 'whisper'), randomUUID()),
    /PRIVATE_STORY_EXTENSION/,
  );
});
test('movement and distant immediate action rejected before provider context', () => {
  const s = near();
  assert.throws(
    () => g.buildStoryTurnContext(s, 'alice', input('*walk to door*'), randomUUID()),
    /WALK_FIRST/,
  );
  Object.assign(s.entities.door, { x: 8, y: 4 });
  assert.throws(
    () => g.buildStoryTurnContext(s, 'alice', input('*open door*'), randomUUID()),
    /WALK_FIRST/,
  );
});
test('turn-specific speech root stable across ticks but semantic readset changes stale proposal', () => {
  const s = near(),
    i = input('Hello'),
    id = randomUUID();
  const c = g.buildStoryTurnContext(s, 'alice', i, id);
  const later = structuredClone(s);
  later.tick += 20;
  const d = g.buildStoryTurnContext(later, 'alice', i, id);
  assert.equal(c.dialogues[0].replyToObservationId, d.dialogues[0].replyToObservationId);
  assert.equal(c.contextHash, d.contextHash);
  const p = g.createMockStoryTurnProposal(s, 'alice', i, id);
  later.entities.alice.x = 6;
  later.entities.alice.y = 5;
  assert.equal(g.applyStoryTurnProposal(later, 'alice', i, id, p).error, 'STALE_STATE');
});
test('director records failed locked-door attempt truthfully, commits new scene without mutating source', () => {
  const s = world();
  Object.assign(s.entities.alice, { x: 9, y: 5 });
  const before = JSON.stringify(s.narrativeSource);
  const { r } = turn(s, input('*open door* Continue the investigation', null));
  assert.equal(r.error, undefined);
  assert.ok(r.entries.some((e) => e.kind === 'outcome' && e.code === 'FORBIDDEN'));
  assert.equal(r.state.entities.door.open, false);
  assert.equal(r.state.narrativeCanon.revision, 1);
  assert.equal(JSON.stringify(r.state.narrativeSource), before);
  assert.ok(Object.keys(r.state.maps).length > Object.keys(s.maps).length);
  assert.deepEqual(
    r.entries.slice(0, 3).map((e) => e.kind),
    ['attempt', 'outcome', 'speech'],
  );
});
test('sequential pickup then give validates against updated inventory, not initial state', () => {
  const s = near();
  Object.assign(s.entities.key, { x: 5, y: 5 });
  const { r } = turn(s, input('*take key* *give key to keeper*'));
  assert.equal(r.error, undefined);
  assert.equal(r.state.entities.key.ownerId, 'keeper');
  assert.equal(s.entities.key.ownerId, undefined);
});
test('unknown mechanism clarifies; malicious action cannot create money/items or move on a promise', () => {
  const s = near();
  const i = input('*conjure a million credits*');
  assert.equal(turn(s, i).r.clarification, 'AMBIGUOUS');
  const known = input('*wait*'),
    id = randomUUID(),
    p = g.createMockStoryTurnProposal(s, 'alice', known, id);
  p.steps[0].action = { kind: 'move_to', target: { x: 1, y: 1 } };
  assert.equal(g.applyStoryTurnProposal(s, 'alice', known, id, p).error, 'INVALID_ACTION');
});
test('targeted locked-door failure remains truthful and private wording stays out of public outcome', () => {
  const s = near();
  Object.assign(s.entities.door, { x: 5, y: 5 });
  const i = input('*open door* Did it open?', 'keeper', 'whisper');
  const id = randomUUID(),
    ctx = g.buildStoryTurnContext(s, 'alice', i, id);
  assert.equal(ctx.actionOutcomes[0].code, 'FORBIDDEN');
  const r = g.applyStoryTurnProposal(
    s,
    'alice',
    i,
    id,
    g.createMockStoryTurnProposal(s, 'alice', i, id),
  );
  assert.equal(r.error, undefined);
  assert.equal(r.state.entities.door.open, false);
  assert.equal(r.entries.find((e) => e.kind === 'outcome').code, 'FORBIDDEN');
  assert.ok(!JSON.stringify(r.entries.filter((e) => e.channel === 'say')).includes('Did it open'));
});
test('only exact authored public question releases asked fact, never private internal title', () => {
  const d = g.createCompleteObservatoryDraft();
  delete d.supportingNpcPolicy;
  d.npcs[0].initialFacts = [
    {
      id: 'private-location',
      title: 'Hidden sanctuary',
      text: 'ANSWER_SECRET',
      disclosure: 'asked',
      publicQuestion: 'Where can we rest?',
    },
  ];
  const s = g.createStateFromPlayable(g.compilePlayableDraft(d).playable, ['alice', 'bob']);
  Object.assign(s.entities.alice, { x: 5, y: 4 });
  for (const text of ['Hidden sanctuary', 'Can you tell me where can we rest?'])
    assert.ok(
      !JSON.stringify(g.buildStoryTurnContext(s, 'alice', input(text), randomUUID())).includes(
        'ANSWER_SECRET',
      ),
    );
  assert.ok(
    JSON.stringify(
      g.buildStoryTurnContext(s, 'alice', input('Where can we rest?'), randomUUID()),
    ).includes('ANSWER_SECRET'),
  );
});
test('provider-inferred immediate action dry-run uses original safe speech evidence without broadening it', () => {
  const s = near(),
    i = input('*examine the nearby key carefully* Hello'),
    id = randomUUID();
  Object.assign(s.entities.key, { x: 5, y: 5 });
  const context = g.buildStoryTurnContext(s, 'alice', i, id);
  assert.deepEqual(context.actionPreview, []);
  const proposal = {
    turnId: id,
    contextHash: context.contextHash,
    status: 'ready',
    code: null,
    steps: [
      { segmentIndex: 0, action: { kind: 'inspect', targetId: 'key' }, reply: null },
      { segmentIndex: 1, action: null, reply: { code: 'acknowledged' } },
    ],
    narrative: null,
  };
  const before = JSON.stringify(s),
    r = g.applyStoryTurnProposal(s, 'alice', i, id, proposal);
  assert.equal(r.error, undefined);
  assert.equal(JSON.stringify(s), before);
  assert.equal(r.actions.length, 1);
  assert.equal(r.entries.at(-1).kind, 'npc_reply');
});
test('whisper give transfers private item but public physical outcome contains no item or target identity', () => {
  const s = near();
  const privateId = 'private-inventory-canary';
  s.entities[privateId] = {
    ...s.entities.key,
    id: privateId,
    label: 'Private keepsake',
    ownerId: 'alice',
  };
  s.entities.alice.inventory = [privateId];
  Object.assign(s.entities.bob, { x: 5, y: 5 });
  const i = input(`*give ${privateId} to keeper* PRIVATE_WHISPER_CANARY`, 'keeper', 'whisper');
  const { r } = turn(s, i);
  assert.equal(r.error, undefined);
  assert.equal(r.state.entities[privateId].ownerId, 'keeper');
  const publicEntries = r.entries.filter((e) => e.channel === 'say');
  assert.ok(publicEntries.length);
  assert.ok(publicEntries.every((e) => e.audienceIds.includes('bob')));
  const serialized = JSON.stringify(publicEntries);
  assert.ok(!serialized.includes(privateId));
  assert.ok(!serialized.includes('PRIVATE_WHISPER_CANARY'));
  assert.deepEqual(publicEntries[0].action, { kind: 'give' });
  assert.equal(r.actions[0].action.itemId, privateId);
  assert.ok(!JSON.stringify(g.projectState(r.state, 'bob')).includes(privateId));
});
test('unquoted failed inferred action never commits dependent success prose in either mode', () => {
  for (const target of ['keeper', null]) {
    const s = near();
    Object.assign(s.entities.door, { x: 5, y: 5 });
    const i = input('*try the nearby entrance somehow* It opened!', target),
      id = randomUUID();
    const ctx = g.buildStoryTurnContext(s, 'alice', i, id);
    assert.deepEqual(ctx.actionPreview, []);
    const p = {
      turnId: id,
      contextHash: ctx.contextHash,
      status: 'ready',
      code: null,
      steps: [
        { segmentIndex: 0, action: { kind: 'open', targetId: 'door' }, reply: null },
        { segmentIndex: 1, action: null, reply: target ? { text: 'The door is now open!' } : null },
      ],
      narrative: target
        ? null
        : {
            narration: 'The door opens successfully.',
            newScene: null,
            newNpc: null,
            evidenceIds: [],
          },
    };
    const before = JSON.stringify(s),
      r = g.applyStoryTurnProposal(s, 'alice', i, id, p);
    assert.equal(r.clarification, 'UNSUPPORTED');
    assert.equal(r.state, s);
    assert.equal(JSON.stringify(s), before);
    assert.deepEqual(r.entries, []);
    assert.deepEqual(r.events, []);
    assert.deepEqual(r.actions, []);
  }
});
test('mismatched provider action cannot borrow another quoted failure to publish success', () => {
  const s = near();
  Object.assign(s.entities.door, { x: 5, y: 5 });
  Object.assign(s.entities['side-door'], { x: 4, y: 4 });
  const i = input('*open door* Hello'),
    id = randomUUID(),
    p = g.createMockStoryTurnProposal(s, 'alice', i, id);
  p.steps[0].action = { kind: 'open', targetId: 'side-door' };
  p.steps[1].reply = { text: 'Opened!' };
  const r = g.applyStoryTurnProposal(s, 'alice', i, id, p);
  assert.equal(r.clarification, 'UNSUPPORTED');
  assert.equal(r.state, s);
  assert.deepEqual(r.entries, []);
});
