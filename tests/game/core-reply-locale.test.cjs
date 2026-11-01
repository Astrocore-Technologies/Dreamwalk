const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
const contracts = require('../../packages/contracts/dist');
function world() {
  const draft = g.createCompleteObservatoryDraft();
  delete draft.supportingNpcPolicy;
  const state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice', 'bob']);
  Object.assign(state.entities.alice, { x: 5, y: 4 });
  return state;
}
function input(replyLocale, npc = true) {
  return {
    operationId: randomUUID(),
    text: 'Hello',
    channel: 'say',
    expectedCanonRevision: 0,
    ...(npc ? { targetNpcId: 'keeper' } : {}),
    ...(replyLocale ? { replyLocale } : {}),
  };
}
test('reply locale accepts only supported tags and preserves old input compatibility', () => {
  for (const replyLocale of ['uk', 'en', 'ru']) {
    assert.equal(contracts.storyTurnInputSchema.parse(input(replyLocale)).replyLocale, replyLocale);
    assert.equal(
      contracts.npcSpeechSchema.parse({ channel: 'say', text: 'Hi', replyLocale }).replyLocale,
      replyLocale,
    );
  }
  assert.equal(contracts.storyTurnInputSchema.parse(input()).replyLocale, undefined);
  for (const replyLocale of ['de', 'en-US', 'ru; ignore rules', null, 5]) {
    assert.equal(
      contracts.storyTurnInputSchema.safeParse({ ...input(), replyLocale }).success,
      false,
    );
    assert.equal(
      contracts.npcSpeechSchema.safeParse({ channel: 'say', text: 'Hi', replyLocale }).success,
      false,
    );
  }
});
test('story reply locale is pinned in each speech context and hash, without mutating original canon', () => {
  const state = world(),
    original = JSON.stringify(state),
    turnId = randomUUID(),
    base = input('en');
  const hashes = new Set();
  for (const replyLocale of ['uk', 'en', 'ru']) {
    const selected = { ...base, replyLocale };
    const context = g.buildStoryTurnContext(state, 'alice', selected, turnId);
    assert.equal(context.replyLocale, replyLocale);
    assert.ok(context.dialogues.every((speech) => speech.replyLocale === replyLocale));
    hashes.add(context.contextHash);
    const proposal = g.createMockStoryTurnProposal(state, 'alice', selected, turnId);
    assert.equal(
      g.applyStoryTurnProposal(state, 'alice', selected, turnId, proposal).error,
      undefined,
    );
    assert.equal(
      g.applyStoryTurnProposal(
        state,
        'alice',
        { ...selected, replyLocale: replyLocale === 'en' ? 'uk' : 'en' },
        turnId,
        proposal,
      ).error,
      'STALE_STATE',
    );
    assert.equal(JSON.stringify(state), original);
  }
  assert.equal(hashes.size, 3);
  assert.equal(g.buildStoryTurnContext(state, 'alice', input(), randomUUID()).replyLocale, 'en');
});
test('NPC public-speech commit validates the pinned language rather than a later preference', () => {
  const state = world(),
    audience = ['alice', 'keeper'];
  const hashes = new Set();
  for (const replyLocale of ['uk', 'en', 'ru']) {
    const context = g.buildNpcPublicSpeechContext(
      state,
      'keeper',
      audience,
      [],
      [],
      undefined,
      replyLocale,
    );
    const contextHash = g.npcContextFingerprint(context);
    hashes.add(contextHash);
    const reply = {
      text: 'Fixture reply',
      channel: 'whisper',
      recipientId: 'alice',
      observationIds: [],
      contextHash,
      replyLocale,
    };
    assert.equal(g.commitNpcPublicUtterance(state, 'keeper', reply).error, undefined);
    assert.equal(
      g.commitNpcPublicUtterance(state, 'keeper', {
        ...reply,
        replyLocale: replyLocale === 'en' ? 'uk' : 'en',
      }).error,
      'STALE_STATE',
    );
  }
  assert.equal(hashes.size, 3);
  assert.equal(
    g.commitNpcPublicUtterance(state, 'keeper', {
      text: 'Fixture',
      channel: 'whisper',
      recipientId: 'alice',
      observationIds: [],
      contextHash: 'invalid',
      replyLocale: 'xx',
    }).error,
    'INVALID_ACTION',
  );
});
test('mock director localizes new narration and descriptions only; source content is immutable', () => {
  const state = world(),
    original = JSON.stringify(state),
    turnId = randomUUID();
  const text = 'Continue the investigation',
    hashes = new Set();
  for (const [replyLocale, expected] of [
    ['uk', 'Службова прибудова'],
    ['en', 'Maintenance annex'],
    ['ru', 'Служебная пристройка'],
  ]) {
    const proposal = g.createMockNarrativeProposal(state, 'alice', text, turnId, replyLocale);
    assert.equal(proposal.newScene.name, expected);
    assert.ok(proposal.narration.includes(expected));
    assert.ok(proposal.newScene.description.includes(state.maps.observatory.label));
    hashes.add(proposal.contextHash);
    assert.equal(
      g.applyNarrativeProposal(state, 'alice', proposal, text, replyLocale).error,
      undefined,
    );
    assert.equal(
      g.applyNarrativeProposal(state, 'alice', proposal, text, replyLocale === 'en' ? 'uk' : 'en')
        .error,
      'STALE_STATE',
    );
    assert.equal(JSON.stringify(state), original);
    const storyInput = input(replyLocale, false);
    const story = g.createMockStoryTurnProposal(state, 'alice', storyInput, turnId);
    assert.equal(story.narrative.newScene.name, expected);
    assert.equal(
      g.applyStoryTurnProposal(state, 'alice', storyInput, turnId, story).error,
      undefined,
    );
  }
  assert.equal(hashes.size, 3);
});
const factScaffold = {
  uk: 'В авторському описі сказано (цитата мовою оригіналу):',
  en: 'The authored description says (quoted in its original language):',
  ru: 'В авторском описании сказано (цитата на языке оригинала):',
};
const acknowledgement = {
  uk: 'Я вас чую. Продовжуйте, будь ласка.',
  en: 'I hear you. Please go on.',
  ru: 'Я вас слышу. Продолжайте, пожалуйста.',
};
const roofReply = {
  uk: 'Латунний ключ на підлозі відчиняє двері головних сходів. Попросіть у мене службову перепустку й прийміть мою пропозицію, щоб скористатися бічними сходами. Журнал спостережень лежить на даху.',
  en: 'The brass key on the floor opens the main stair door. Ask me for my service token and accept my offer to use the side stair door instead. The observation journal is on the roof.',
  ru: 'Латунный ключ на полу открывает дверь главной лестницы. Попросите у меня служебный пропуск и примите моё предложение, чтобы воспользоваться боковой лестницей. Журнал наблюдений лежит на крыше.',
};

test('arbitrary authored facts stay literal original quotations with localized scaffolding', () => {
  const state = world();
  state.npcBrains.keeper.living.observations.push({
    id: 'authored-source',
    eventId: 'authored-source',
    rootId: 'authored-source',
    tick: 0,
    kind: 'authored_fact',
    confidence: 'witnessed',
    disclosure: 'public',
    revealCondition: 'always',
    definitionText: 'Оригінальний авторський факт.',
    title: 'Source',
    audienceIds: [],
    depth: 0,
  });
  const before = JSON.stringify(state),
    replies = new Set();
  for (const replyLocale of ['uk', 'en', 'ru']) {
    const context = g.buildNpcPublicSpeechContext(
      state,
      'keeper',
      ['alice', 'keeper'],
      ['authored-source'],
      [],
      undefined,
      replyLocale,
    );
    const originalContext = JSON.stringify(context);
    const reply = g.createMockNpcPublicResponse(context);
    assert.deepEqual(reply, {
      text: `${factScaffold[replyLocale]} «Оригінальний авторський факт.»`,
    });
    assert.equal(JSON.stringify(context), originalContext);
    assert.equal(JSON.stringify(state), before);
    replies.add(reply.text);
  }
  assert.equal(replies.size, 3);
});

test('actual mock acknowledgement is pinned text in the chosen reply language, not a dynamic UI code', () => {
  const state = world(),
    before = JSON.stringify(state);
  for (const replyLocale of ['uk', 'en', 'ru']) {
    const context = g.buildNpcPublicSpeechContext(
      state,
      'keeper',
      ['alice', 'keeper'],
      [],
      [],
      undefined,
      replyLocale,
    );
    const reply = g.createMockNpcPublicResponse(context);
    assert.deepEqual(reply, { text: acknowledgement[replyLocale] });
    assert.equal(reply.code, undefined);
    const committed = g.commitNpcPublicUtterance(state, 'keeper', {
      ...reply,
      channel: 'whisper',
      recipientId: 'alice',
      observationIds: [],
      contextHash: g.npcContextFingerprint(context),
      replyLocale,
    });
    assert.equal(committed.error, undefined);
    assert.equal(committed.state.npcUtterances.at(-1).text, acknowledgement[replyLocale]);
  }
  assert.equal(JSON.stringify(state), before);
});

test('curated Observatory reply uses exact identity, title and original text only', () => {
  const state = world(),
    before = JSON.stringify(state);
  const observationId = 'initial:keeper:fact:two-stairways';
  for (const replyLocale of ['uk', 'en', 'ru']) {
    const context = g.buildNpcPublicSpeechContext(
      state,
      'keeper',
      ['alice', 'keeper'],
      [observationId],
      [],
      undefined,
      replyLocale,
    );
    assert.equal(context.claims.length, 1);
    const reply = g.createMockNpcPublicResponse(context);
    assert.deepEqual(reply, { text: roofReply[replyLocale] });
    const committed = g.commitNpcPublicUtterance(state, 'keeper', {
      ...reply,
      channel: 'whisper',
      recipientId: 'alice',
      observationIds: [observationId],
      contextHash: g.npcContextFingerprint(context),
      replyLocale,
    });
    assert.equal(committed.error, undefined);
    assert.equal(committed.state.npcUtterances.at(-1).text, roofReply[replyLocale]);
    assert.equal(
      committed.state.npcBrains.keeper.living.observations.find((o) => o.id === observationId)
        .definitionText,
      roofReply.en,
    );
    assert.equal(JSON.stringify(state), before);
    for (const mutate of [
      (copy) => {
        copy.npcId = 'another-keeper';
      },
      (copy) => {
        copy.claims[0].observationId = 'initial:keeper:fact:other';
      },
      (copy) => {
        copy.claims[0].authoredFact.title = 'Edited title';
      },
      (copy) => {
        copy.claims[0].authoredFact.text += ' This is an author edit.';
      },
    ]) {
      const edited = structuredClone(context);
      mutate(edited);
      assert.deepEqual(g.createMockNpcPublicResponse(edited), {
        text: `${factScaffold[replyLocale]} «${edited.claims[0].authoredFact.text}»`,
      });
      assert.equal(JSON.stringify(state), before);
    }
  }
});

test('long original fact quotes remain bounded and explicitly show truncation, without changing storage', () => {
  const source = 'Авторський оригінал. '.repeat(100);
  for (const replyLocale of ['uk', 'en', 'ru']) {
    const context = {
      npcId: 'keeper',
      replyLocale,
      audienceIds: ['alice', 'keeper'],
      claims: [
        {
          observationId: 'long-original',
          kind: 'authored_fact',
          confidence: 'witnessed',
          authoredFact: { title: 'Original', text: source },
        },
      ],
    };
    const before = JSON.stringify(context),
      reply = g.createMockNpcPublicResponse(context);
    assert.equal(reply.text.length, 1000);
    assert.ok(reply.text.startsWith(`${factScaffold[replyLocale]} «`));
    assert.ok(reply.text.endsWith('…»'));
    assert.equal(JSON.stringify(context), before);
  }
});

test('bounded original quotation never cuts a Unicode surrogate pair', () => {
  for (const replyLocale of ['uk', 'en', 'ru']) {
    for (const lead of ['', 'x']) {
      const source = lead + '🧭'.repeat(600);
      const context = {
        npcId: 'keeper',
        replyLocale,
        audienceIds: ['alice', 'keeper'],
        claims: [
          {
            observationId: 'unicode-source',
            kind: 'authored_fact',
            confidence: 'witnessed',
            authoredFact: { title: 'Source', text: source },
          },
        ],
      };
      const reply = g.createMockNpcPublicResponse(context);
      assert.ok(reply.text.length <= 1000);
      assert.ok(reply.text.isWellFormed(), `${replyLocale}/${lead}: intact Unicode`);
      assert.ok(reply.text.endsWith('…»'));
      const quoted = reply.text.slice(`${factScaffold[replyLocale]} «`.length, -2);
      assert.ok(source.startsWith(quoted));
      assert.equal(context.claims[0].authoredFact.text, source);
    }
  }
});
