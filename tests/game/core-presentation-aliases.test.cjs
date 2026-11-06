// Source-only, synthetic tests. Never build into the shared node_modules worktree.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...args) {
  if (request === '@dreamwalk/contracts')
    return resolve(__dirname, '../../packages/contracts/src/index.ts');
  return resolveFilename.call(this, request, parent, ...args);
};
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
      fileName: filename,
    }).outputText,
    filename,
  );
const g = require('../../packages/game-core/src/index.ts');
const {
  storyItemPlacementContext,
} = require('../../packages/game-core/src/story-item-placement.ts');
const {
  storyItemTransferContext,
} = require('../../packages/game-core/src/story-item-transfers.ts');
const turnId = '76bab0b2-9782-4001-9001-777777777777';
function world() {
  const draft = g.createCompleteObservatoryDraft();
  delete draft.supportingNpcPolicy;
  const state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice', 'bob']);
  state.narrativeSource = { versionId: 'released-v1', checksum: 'c'.repeat(64) };
  Object.assign(state.entities.alice, { x: 5, y: 4 });
  Object.assign(state.entities.key, {
    x: 5,
    y: 5,
    label: 'Старинный пропуск',
    labelTranslations: undefined,
  });
  Object.assign(state.entities.keeper, {
    x: 6,
    y: 4,
    label: 'Смотритель',
    labelTranslations: undefined,
  });
  const destination = Object.values(state.maps).find(
    (map) => map.id !== state.entities.alice.mapId,
  );
  destination.label = 'Архив';
  delete destination.labelTranslations;
  return state;
}
function aliases(state, locale = 'en', kinds = ['item', 'npc', 'map']) {
  const destination = Object.values(state.maps).find(
    (map) => map.id !== state.entities.alice.mapId,
  );
  const names =
    locale === 'uk'
      ? ['Мідна перепустка', 'Доглядач', 'Архів']
      : ['Brass pass', 'Caretaker', 'Archive'];
  return {
    version: 'released-label-alias-v1',
    campaignId: 'campaign',
    actorId: 'alice',
    locale,
    sourceVersionId: state.narrativeSource.versionId,
    authority: 'a'.repeat(64),
    entries: [
      ...(kinds.includes('item')
        ? [
            {
              kind: 'entity',
              id: 'key',
              sourceText: state.entities.key.label,
              text: names[0],
              translationKey: '1'.repeat(64),
            },
          ]
        : []),
      ...(kinds.includes('npc')
        ? [
            {
              kind: 'entity',
              id: 'keeper',
              sourceText: state.entities.keeper.label,
              text: names[1],
              translationKey: '2'.repeat(64),
            },
          ]
        : []),
      ...(kinds.includes('map')
        ? [
            {
              kind: 'map',
              id: destination.id,
              sourceText: destination.label,
              text: names[2],
              translationKey: '3'.repeat(64),
            },
          ]
        : []),
    ],
  };
}
function input(state, text, locale = 'en') {
  return {
    operationId: turnId,
    channel: 'say',
    text,
    replyLocale: locale,
    expectedCanonRevision: state.narrativeCanon?.revision ?? 0,
    ...(state.turnController ? { turnFence: g.turnFence(state) } : {}),
  };
}
function proposal(state, request, evidence, action) {
  const context = g.buildStoryTurnContext(state, 'alice', request, turnId, evidence);
  return {
    turnId,
    contextHash: context.contextHash,
    status: 'ready',
    code: null,
    steps: context.segments.map((segment) => ({
      segmentIndex: segment.index,
      action: segment.kind === 'attempt' ? action : null,
      reply: null,
    })),
    narrative: {
      narration: 'The attempt resolves.',
      newScene: null,
      newNpc: null,
      evidenceIds: [],
    },
  };
}
function carry(state) {
  state.entities.alice.inventory = ['key'];
  state.entities.key.ownerId = 'alice';
}
function assertLabelsUnchanged(before, after) {
  for (const [id, entity] of Object.entries(before.entities)) {
    assert.equal(after.entities[id].label, entity.label);
    assert.deepEqual(after.entities[id].labelTranslations, entity.labelTranslations);
  }
  for (const [id, map] of Object.entries(before.maps)) {
    assert.equal(after.maps[id].label, map.label);
    assert.deepEqual(after.maps[id].labelTranslations, map.labelTranslations);
  }
  assert.equal(Object.hasOwn(after, 'presentationAliases'), false);
}

test('EN/UK pickup, drop and give resolve frozen display aliases and preserve canonical labels/input', () => {
  for (const locale of ['en', 'uk']) {
    let state = world();
    const evidence = g.validatePresentationAliases(state, 'alice', aliases(state, locale));
    assert.ok(Object.isFrozen(evidence));
    assert.ok(Object.isFrozen(evidence.entries));
    assert.ok(evidence.entries.every(Object.isFrozen));
    const [item, npc] = evidence.entries;
    const pickup = locale === 'en' ? `take ${item.text}` : `піднімаю ${item.text}`;
    assert.deepEqual(g.parsePlayerTextAction(state, 'alice', pickup, evidence), {
      kind: 'pick_up',
      targetId: 'key',
    });
    assert.equal(g.parsePlayerTextAction(state, 'alice', pickup), null);
    let request = input(state, `*${pickup}*`, locale);
    const before = structuredClone(state),
      originalInput = structuredClone(request);
    let body = proposal(state, request, evidence, { kind: 'pick_up', targetId: 'key' });
    let result = g.applyStoryTurnProposal(state, 'alice', request, turnId, body, {
      presentationAliases: evidence,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.state.entities.key.ownerId, 'alice');
    assert.deepEqual(state, before);
    assert.deepEqual(request, originalInput);
    assertLabelsUnchanged(state, result.state);
    state = result.state;
    // A separate turn with exactly the same frozen sidecar, no translation refresh.
    const dropText =
      locale === 'en' ? `put ${item.text} on the ground` : `покладу ${item.text} на землю`;
    request = input(state, `*${dropText}*`, locale);
    request.operationId = '76bab0b2-9782-4001-9001-888888888888';
    const choices = storyItemPlacementContext(state, 'alice', dropText, request, evidence);
    assert.equal(choices.items[0].id, 'key');
    assert.ok(choices.items[0].points.length);
    const context = g.buildStoryTurnContext(state, 'alice', request, request.operationId, evidence);
    body = {
      turnId: request.operationId,
      contextHash: context.contextHash,
      status: 'ready',
      code: null,
      steps: [
        {
          segmentIndex: 0,
          action: { kind: 'drop', targetId: 'key', target: choices.items[0].points[0] },
          reply: null,
        },
      ],
      narrative: {
        narration: 'The object is on the ground.',
        newScene: null,
        newNpc: null,
        evidenceIds: [],
      },
    };
    result = g.applyStoryTurnProposal(state, 'alice', request, request.operationId, body, {
      presentationAliases: evidence,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.state.entities.key.ownerId, undefined);
    assertLabelsUnchanged(state, result.state);
    state = world();
    carry(state);
    const give =
      locale === 'en' ? `give ${item.text} to ${npc.text}` : `віддай ${item.text} до ${npc.text}`;
    assert.deepEqual(g.parsePlayerTextAction(state, 'alice', give, evidence), {
      kind: 'give',
      targetId: 'keeper',
      itemId: 'key',
    });
    const transfer = storyItemTransferContext(state, 'alice', give, evidence);
    assert.equal(transfer.items[0].id, 'key');
    assert.ok(
      transfer.recipients.find((recipient) => recipient.id === 'keeper').labels.includes(npc.text),
    );
    request = input(state, `*${give}*`, locale);
    body = proposal(state, request, evidence, { kind: 'give', targetId: 'keeper', itemId: 'key' });
    result = g.applyStoryTurnProposal(state, 'alice', request, turnId, body, {
      presentationAliases: evidence,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.state.entities.key.ownerId, 'keeper');
    assertLabelsUnchanged(state, result.state);
  }
});

test('existing translated map resolves in preflight, ordered apply and final semantic travel', () => {
  for (const locale of ['en', 'uk']) {
    const state = world(),
      evidence = aliases(state, locale, ['map']),
      destination = evidence.entries[0];
    const text = locale === 'en' ? `go to ${destination.text}` : `йду до ${destination.text}`;
    assert.equal(g.resolveTravelRequest(state, text, evidence).mapId, destination.id);
    assert.equal(
      g.resolveTravelDestination(state, destination.text, evidence).mapId,
      destination.id,
    );
    const request = input(state, `*${text}*`, locale);
    const body = g.createMockStoryTurnProposal(state, 'alice', request, turnId, evidence);
    assert.equal(body.narrative.newScene, null);
    const result = g.applyStoryTurnProposal(state, 'alice', request, turnId, body, {
      presentationAliases: evidence,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.state.entities.alice.mapId, destination.id);
    assertLabelsUnchanged(state, result.state);
    assert.equal(result.pendingTravel, undefined);
  }
  const state = g.initializeTurnController(world(), ['alice', 'bob']).state;
  const evidence = aliases(state, 'en', ['map']),
    destination = evidence.entries[0];
  const request = input(state, '*I set off toward the archive building*');
  const body = proposal(state, request, evidence, null);
  body.travelIntent = {
    segmentIndex: 0,
    destinationName: destination.text,
    description: 'The archive building.',
    template: 'room',
  };
  const result = g.applyStoryTurnProposal(state, 'alice', request, turnId, body, {
    presentationAliases: evidence,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.alice.mapId, destination.id);
  assert.equal(result.pendingTravel, undefined);
  assertLabelsUnchanged(state, result.state);
});

test('canonical and translated name collisions fail closed, never silently select a namesake', () => {
  for (const kind of ['item', 'map']) {
    const state = world(),
      evidence = aliases(state, 'en', [kind]);
    if (kind === 'item')
      Object.assign(state.entities.token, {
        label: evidence.entries[0].text,
        mapId: state.entities.alice.mapId,
        x: 5,
        y: 5,
        ownerId: undefined,
      });
    else state.maps[state.entities.alice.mapId].label = evidence.entries[0].text;
    assert.throws(
      () => g.validatePresentationAliases(state, 'alice', evidence),
      /INVALID_PRESENTATION_ALIASES/,
    );
    assert.throws(
      () => g.buildStoryTurnContext(state, 'alice', input(state, '*wait*'), turnId, evidence),
      /INVALID_PRESENTATION_ALIASES/,
    );
  }
  const state = world(),
    evidence = aliases(state, 'en', ['item', 'npc']);
  evidence.entries[1].text = evidence.entries[0].text;
  assert.throws(
    () => g.validatePresentationAliases(state, 'alice', evidence),
    /INVALID_PRESENTATION_ALIASES/,
  );
});

test('concealed/foreign-inventory/player/stale-source evidence is rejected without mutation', () => {
  for (const mode of [
    'hidden',
    'foreign',
    'player',
    'source',
    'label',
    'actor',
    'authority',
    'key',
    'extra',
    'oversized',
  ]) {
    const state = world(),
      evidence = aliases(state, 'en', ['item']);
    if (mode === 'hidden')
      state.entities.key.mapId =
        evidence.entries[0].id === 'key'
          ? Object.keys(state.maps).find((id) => id !== state.entities.alice.mapId)
          : '';
    if (mode === 'foreign') {
      state.entities.key.ownerId = 'bob';
      state.entities.bob.inventory = ['key'];
    }
    if (mode === 'player') {
      evidence.entries[0].id = 'bob';
      evidence.entries[0].sourceText = state.entities.bob.label;
    }
    if (mode === 'source') evidence.sourceVersionId = 'stale';
    if (mode === 'label') state.entities.key.label = 'Changed source';
    if (mode === 'actor') evidence.actorId = 'bob';
    if (mode === 'authority') evidence.authority = 'invalid';
    if (mode === 'key') evidence.entries[0].translationKey = 'not-cache-evidence';
    if (mode === 'extra') evidence.secret = 'never propagate arbitrary fields';
    if (mode === 'oversized') evidence.entries[0].text = 'x'.repeat(121);
    const before = structuredClone(state);
    assert.throws(
      () => g.validatePresentationAliases(state, 'alice', evidence),
      /INVALID_PRESENTATION_ALIASES/,
      mode,
    );
    assert.deepEqual(state, before);
  }
});

test('evidence changes the hash before generation; omission preserves the legacy context shape', () => {
  const state = world(),
    request = input(state, '*wait*'),
    before = structuredClone(state);
  const plain = g.buildStoryTurnContext(state, 'alice', request, turnId);
  assert.deepEqual(g.buildStoryTurnContext(state, 'alice', request, turnId, undefined), plain);
  assert.equal(Object.hasOwn(plain, 'presentationAliases'), false);
  const evidence = aliases(state),
    localized = g.buildStoryTurnContext(state, 'alice', request, turnId, evidence);
  assert.notEqual(localized.contextHash, plain.contextHash);
  assert.deepEqual(localized.mechanics, plain.mechanics);
  assert.deepEqual(localized.segments, plain.segments);
  assert.deepEqual(localized.director, plain.director);
  const alternate = structuredClone(evidence);
  alternate.entries[0].translationKey = '9'.repeat(64);
  assert.notEqual(
    g.buildStoryTurnContext(state, 'alice', request, turnId, alternate).contextHash,
    localized.contextHash,
  );
  const body = proposal(state, request, evidence, { kind: 'wait' });
  assert.equal(
    g.applyStoryTurnProposal(state, 'alice', request, turnId, body).error,
    'STALE_STATE',
  );
  assert.equal(
    g.applyStoryTurnProposal(state, 'alice', request, turnId, body, {
      presentationAliases: alternate,
    }).error,
    'STALE_STATE',
  );
  assert.deepEqual(state, before);
});

test('visible attacks/references resolve aliases, but isolated NPC voice evidence never gets the catalog', () => {
  const state = world(),
    evidence = aliases(state);
  assert.deepEqual(g.parseStoryAttackAttempt(state, 'alice', 'hit Caretaker', evidence), {
    kind: 'hit',
    targetId: 'keeper',
  });
  assert.deepEqual(g.parsePlayerTextAction(state, 'alice', 'inspect Caretaker', evidence), {
    kind: 'inspect',
    targetId: 'keeper',
  });
  const request = { ...input(state, 'Hello'), targetNpcId: 'keeper' };
  const plain = g.buildStoryTurnContext(state, 'alice', request, turnId);
  const localized = g.buildStoryTurnContext(state, 'alice', request, turnId, evidence);
  assert.equal(Object.hasOwn(localized, 'presentationAliases'), false);
  assert.deepEqual(localized.dialogues, plain.dialogues);
  assert.notEqual(localized.contextHash, plain.contextHash);
  const shared = g.buildStoryTurnContext(state, 'alice', input(state, 'Hello'), turnId, evidence);
  assert.ok(shared.presentationAliases);
  assert.ok(!JSON.stringify(shared.sceneSpeakers).includes('released-label-alias-v1'));
  assert.ok(!JSON.stringify(shared.sceneSpeakers).includes('Brass pass'));
});

test('translated existing names cannot materialize duplicate paid scenes, NPCs or props', () => {
  for (const kind of ['newScene', 'newNpc', 'newItem']) {
    const state = world(),
      evidence = aliases(state),
      request = input(state, '*look around*');
    const body = proposal(state, request, evidence, null);
    if (kind === 'newScene')
      body.narrative.newScene = {
        name: 'Archive',
        description: 'A room.',
        template: 'room',
        connection: { fromMapId: state.entities.alice.mapId, x: 2, y: 2 },
      };
    if (kind === 'newNpc')
      body.narrative.newNpc = {
        name: 'Caretaker',
        roleLabel: 'Helper',
        description: 'A helper.',
        appearance: 'A familiar uniform.',
        personalitySummary: 'Careful.',
        values: ['duty'],
        publicSpeechStyle: 'neutral',
        goal: 'help',
        placement: 'current',
        spawn: { x: 7, y: 4 },
        knownEntityIds: [],
      };
    if (kind === 'newItem') body.narrative.newItem = { name: 'Brass pass', description: 'A key.' };
    assert.equal(g.storyTurnProposalSchema.safeParse(body).success, true, kind);
    const result = g.applyStoryTurnProposal(state, 'alice', request, turnId, body, {
      presentationAliases: evidence,
    });
    assert.equal(result.error, 'INVALID_ACTION', kind);
    assert.strictEqual(result.state, state);
    assert.deepEqual(result.events, []);
  }
});

test('a hidden offstage canonical namesake cannot create an alias oracle', () => {
  const state = world(),
    evidence = aliases(state, 'en', ['item']);
  const text = 'take Brass pass';
  const expected = g.parsePlayerTextAction(state, 'alice', text, evidence);
  state.entities.hidden = {
    ...state.entities.keeper,
    id: 'hidden',
    mapId: Object.keys(state.maps).find((id) => id !== state.entities.alice.mapId),
    label: 'Brass pass',
  };
  assert.deepEqual(g.parsePlayerTextAction(state, 'alice', text, evidence), expected);
  assert.deepEqual(g.validatePresentationAliases(state, 'alice', evidence), evidence);
  const request = input(state, `*${text}*`);
  const body = proposal(state, request, evidence, expected);
  const result = g.applyStoryTurnProposal(state, 'alice', request, turnId, body, {
    presentationAliases: evidence,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.key.ownerId, 'alice');
});

test('ordered transfer and deferred stages retain exact evidence but cannot reuse unavailable references', () => {
  const state = world();
  carry(state);
  const evidence = g.validatePresentationAliases(state, 'alice', aliases(state));
  const bytes = JSON.stringify(evidence);
  const request = input(state, '*give Brass pass to Caretaker* *inspect Caretaker*');
  const body = g.createMockStoryTurnProposal(state, 'alice', request, turnId, evidence);
  assert.equal(body.status, 'ready');
  const result = g.applyStoryTurnProposal(state, 'alice', request, turnId, body, {
    presentationAliases: evidence,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.key.ownerId, 'keeper');
  assert.equal(JSON.stringify(evidence), bytes);
  const nextInput = input(result.state, '*inspect Caretaker*');
  const context = g.buildStoryTurnContext(result.state, 'alice', nextInput, turnId, evidence);
  assert.deepEqual(context.presentationAliases, evidence);
  assert.deepEqual(
    g.validatePresentationAliases(result.state, 'alice', evidence, nextInput.text),
    evidence,
  );
  assert.throws(
    () => g.validatePresentationAliases(result.state, 'alice', evidence),
    /INVALID_PRESENTATION_ALIASES/,
  );
  assert.throws(
    () =>
      g.buildStoryTurnContext(
        result.state,
        'alice',
        input(result.state, '*take Brass pass*'),
        turnId,
        evidence,
      ),
    /INVALID_PRESENTATION_ALIASES/,
  );
  assert.equal(g.parsePlayerTextAction(result.state, 'alice', 'take Brass pass', evidence), null);
  // Consumed/removed or renamed unused labels cannot invalidate a later unrelated segment.
  for (const mode of ['removed', 'renamed']) {
    const next = structuredClone(result.state);
    if (mode === 'removed') delete next.entities.key;
    else next.entities.key.label = 'Changed';
    assert.deepEqual(
      g.validatePresentationAliases(next, 'alice', evidence, '*inspect Caretaker*'),
      evidence,
    );
    assert.throws(
      () => g.validatePresentationAliases(next, 'alice', evidence, '*take Brass pass*'),
      /INVALID_PRESENTATION_ALIASES/,
    );
  }
});

test('malformed sidecars are bounded and detached; empty evidence adds no context property', () => {
  const state = world(),
    raw = aliases(state),
    evidence = g.validatePresentationAliases(state, 'alice', raw);
  raw.entries[0].text = 'Mutated';
  assert.equal(evidence.entries[0].text, 'Brass pass');
  for (const entries of [
    [null],
    [{ ...evidence.entries[0] }, null],
    Array(257).fill(evidence.entries[0]),
  ])
    assert.throws(
      () => g.validatePresentationAliases(state, 'alice', { ...evidence, entries }),
      /INVALID_PRESENTATION_ALIASES/,
    );
  const empty = { ...evidence, entries: [] },
    request = input(state, '*wait*');
  assert.equal(g.validatePresentationAliases(state, 'alice', empty), undefined);
  assert.deepEqual(
    g.buildStoryTurnContext(state, 'alice', request, turnId, empty),
    g.buildStoryTurnContext(state, 'alice', request, turnId),
  );
  assert.equal(g.mentionsPresentationLabel('йду до старої кімнати', 'стара кімната'), true);
});

test('released visible doors resolve EN/UK open and close without renaming or bypassing locks', () => {
  for (const locale of ['en', 'uk'])
    for (const kind of ['open', 'close']) {
      const state = world();
      Object.assign(state.entities.door, {
        x: 5,
        y: 5,
        label: 'Запертая створка',
        labelTranslations: undefined,
        locked: false,
        open: kind === 'close',
      });
      const text = locale === 'en' ? 'Brass gate' : 'Мідна брама';
      const evidence = {
        ...aliases(state, locale, []),
        entries: [
          {
            kind: 'entity',
            id: 'door',
            sourceText: state.entities.door.label,
            text,
            translationKey: '4'.repeat(64),
          },
        ],
      };
      const verb = locale === 'en' ? kind : kind === 'open' ? 'відкриваю' : 'закриваю';
      const actionText = `${verb} ${text}`;
      const action = { kind, targetId: 'door' };
      assert.deepEqual(g.parsePlayerTextAction(state, 'alice', actionText, evidence), action);
      const request = input(state, `*${actionText}*`, locale);
      const body = proposal(state, request, evidence, action);
      const result = g.applyStoryTurnProposal(state, 'alice', request, turnId, body, {
        presentationAliases: evidence,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.state.entities.door.open, kind === 'open');
      assertLabelsUnchanged(state, result.state);
      if (kind === 'open') {
        state.entities.door.locked = true;
        const locked = g.applyAction(
          state,
          'alice',
          g.parsePlayerTextAction(state, 'alice', actionText, evidence),
        );
        assert.ok(locked.error);
        assert.equal(locked.error, g.applyAction(state, 'alice', action).error);
        assert.strictEqual(locked.state, state);
      }
    }
});

for (const locale of ['en', 'uk']) {
  for (const kind of ['item_custody', 'item_placement', 'item_consumed']) {
    test(`typed established ${kind} admits a named carried released alias (${locale})`, () => {
      const state = world();
      carry(state);
      const evidence = aliases(state, locale, ['item']);
      const label = evidence.entries[0].text;
      const request = input(state, `*${label} changed hands or position.*`, locale);
      const context = g.buildStoryTurnContext(state, 'alice', request, turnId, evidence);
      assert.ok(context.establishedRoleplay.entities.some((entity) => entity.id === 'key'));
      const effect =
        kind === 'item_custody'
          ? { kind, itemId: 'key', recipientId: 'keeper' }
          : kind === 'item_placement'
            ? { kind, itemId: 'key', point: { x: 5, y: 5 }, surfaceId: null }
            : { kind, itemId: 'key' };
      const body = proposal(state, request, evidence, null);
      body.steps[0].establishedEvents = [
        { description: `${label} changed.`, entityIds: ['key'], effects: [effect] },
      ];
      const before = structuredClone(state);
      const result = g.applyStoryTurnProposal(state, 'alice', request, turnId, body, {
        presentationAliases: evidence,
      });
      assert.equal(result.error, undefined);
      assert.deepEqual(state, before);
      if (kind === 'item_custody') assert.equal(result.state.entities.key.ownerId, 'keeper');
      else if (kind === 'item_placement')
        assert.equal(result.state.entities.key.ownerId, undefined);
      else assert.equal(result.state.entities.key, undefined);
      if (result.state.entities.key)
        assert.equal(result.state.entities.key.label, before.entities.key.label);
      assert.ok(g.applyStoryTurnProposal(state, 'alice', request, turnId, body).error);
    });
  }
}

test('established alias references never authorize unmentioned, foreign, stale or hidden inventory', () => {
  const state = world();
  carry(state);
  const evidence = aliases(state, 'en', ['item']);
  for (const text of ['*I waited.*', '*The Brass passerby waited.*']) {
    const request = input(state, text);
    const context = g.buildStoryTurnContext(state, 'alice', request, turnId, evidence);
    assert.ok(!context.establishedRoleplay.entities.some((entity) => entity.id === 'key'));
    const body = proposal(state, request, evidence, null);
    body.steps[0].establishedEvents = [
      {
        description: 'The item moved.',
        entityIds: ['key'],
        effects: [{ kind: 'item_custody', itemId: 'key', recipientId: 'keeper' }],
      },
    ];
    assert.ok(
      g.applyStoryTurnProposal(state, 'alice', request, turnId, body, {
        presentationAliases: evidence,
      }).error,
    );
  }
  const request = input(state, '*Brass pass changed hands.*');
  const body = proposal(state, request, evidence, null);
  body.steps[0].establishedEvents = [
    {
      description: 'The item moved.',
      entityIds: ['key'],
      effects: [{ kind: 'item_custody', itemId: 'key', recipientId: 'keeper' }],
    },
  ];
  for (const change of ['foreign', 'hidden', 'stale', 'unready']) {
    const next = structuredClone(state),
      invalid = structuredClone(evidence);
    if (change === 'foreign' || change === 'hidden') {
      next.entities.alice.inventory = [];
      next.entities.key.ownerId = change === 'foreign' ? 'bob' : 'keeper';
      next.entities[next.entities.key.ownerId].inventory = ['key'];
    } else if (change === 'stale') next.entities.key.label = 'Changed source';
    else invalid.entries[0].translationKey = '';
    assert.throws(
      () => g.buildStoryTurnContext(next, 'alice', request, turnId, invalid),
      /INVALID_PRESENTATION_ALIASES/,
    );
    assert.ok(
      g.applyStoryTurnProposal(next, 'alice', request, turnId, body, {
        presentationAliases: invalid,
      }).error,
    );
  }
});
