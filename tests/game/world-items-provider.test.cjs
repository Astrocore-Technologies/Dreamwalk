process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider');
const { GameService } = require('../../apps/api/dist/game/game.service');
const g = require('../../packages/game-core/dist');
const { compileStoryPlan, storyPlanDefinition } = require('../../apps/api/dist/game/story-plan');
const { normalizeStaticSprite } = require('../../apps/api/dist/visual-authoring/static-sprite');
const {
  readCharacterVisualSource,
} = require('../../apps/api/dist/visual-authoring/character-source');
const {
  buildArtRequest,
  requiredArtRoles,
} = require('../../apps/api/dist/visual-authoring/real-art');
const sharp = require('sharp');
const npc = '11111111-1111-4111-a111-111111111111';
const source = {
  title: 'Repair station',
  content: {
    world: 'A quiet orbital repair station.',
    rules: 'Do not conjure resources.',
    locations: [{ id: 'workshop', name: 'Workshop', description: 'A bench and an engineer.' }],
    npcIds: [npc],
    scenes: [
      {
        id: 'opening',
        name: 'Arrival',
        locationId: 'workshop',
        description: 'The engineer is fixing a radio.',
      },
    ],
    startSceneId: 'opening',
    boundaries: [],
  },
  npcs: [
    {
      id: npc,
      name: 'Ari',
      role: 'Engineer',
      description: 'A busy technician.',
      appearance: 'A blue work suit.',
    },
  ],
};
const plan = {
  version: 1,
  rooms: [
    {
      locationId: 'workshop',
      width: 10,
      height: 8,
      spawns: [
        { x: 2, y: 2 },
        { x: 3, y: 2 },
        { x: 2, y: 3 },
        { x: 3, y: 3 },
      ],
      blocked: [],
      surfaces: [{ id: 'bench', visual: 'table', x: 4, y: 4, width: 1, height: 1, solid: true }],
    },
  ],
  connections: [],
  npcs: [
    {
      sourceNpcId: npc,
      locationId: 'workshop',
      x: 4,
      y: 3,
      stock: [{ definitionId: 'battery', quantity: 1 }],
    },
  ],
  items: [
    {
      id: 'battery',
      label: 'Battery',
      description: 'A spare power cell.',
      visual: 'battery',
      portable: true,
      edible: false,
      restoreVitality: 0,
    },
  ],
};
test('general story proposal compiles source identities and finite capabilities, rejects substitutions and disconnected rooms', () => {
  const { draft } = compileStoryPlan(source, plan);
  assert.equal(draft.npcs[0].sourceNpcId, npc);
  assert.equal(draft.npcs[0].label, 'Ari');
  assert.equal(draft.npcs[0].itemStock[0].definitionId, 'battery');
  assert.deepEqual(draft.objects, []);
  assert.equal(draft.maps[0].sourceLocationId, 'workshop');
  assert.throws(
    () =>
      compileStoryPlan(source, { ...plan, npcs: [{ ...plan.npcs[0], sourceNpcId: randomUUID() }] }),
    /SOURCE_MISMATCH/,
  );
  const s = structuredClone(source);
  s.content.locations.push({ id: 'hangar', name: 'Hangar', description: 'A hangar.' });
  const p = structuredClone(plan);
  p.rooms.push({ ...p.rooms[0], locationId: 'hangar' });
  assert.throws(() => compileStoryPlan(s, p), /DISCONNECTED/);
  p.connections = [{ a: 'workshop', b: 'hangar', atA: { x: 7, y: 4 }, atB: { x: 1, y: 4 } }];
  assert.equal(compileStoryPlan(s, p).draft.maps.length, 2);
  assert.ok(storyPlanDefinition.schema.properties);
  assert.ok(storyPlanDefinition.instructions.includes('source location and NPC IDs'));
});
test('real NPC adapter protocol accepts typed item intents through fake transport and actual server decision evaluator', async () => {
  const { playable } = compileStoryPlan(source, plan);
  let s = g.createStateFromPlayable(playable, ['alice']);
  Object.assign(s.entities.alice, { x: 3, y: 3 });
  s = g.endPlayerTurn(s, 'alice', g.turnFence(s)).state;
  const service = Object.create(GameService.prototype);
  service.ai = { contextBudgetBytes: () => 64000 };
  const context = service.speechContext(
    s,
    npc,
    'alice',
    'say',
    [],
    undefined,
    undefined,
    undefined,
    'ru',
  );
  let calls = 0;
  const provider = new OpenAiNpcProvider(
    {
      enabled: true,
      apiKey: 'synthetic-fixture-key',
      model: 'synthetic-model',
      version: 'items-test',
      maxInputBytes: 64000,
      maxOutputTokens: 500,
      maxResponseBytes: 64000,
      inputMicrosPerMillion: 1,
      outputMicrosPerMillion: 1,
    },
    async (url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      assert.ok(body.text.format.schema.properties.itemIntents);
      assert.match(body.instructions, /Russian/);
      assert.ok(body.input.includes('battery'));
      return new Response(
        JSON.stringify({
          id: 'synthetic-request',
          status: 'completed',
          service_tier: 'default',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    text: 'Вот запасная батарея.',
                    itemIntents: [
                      {
                        kind: 'give_stock',
                        definitionId: 'battery',
                        itemId: null,
                        recipientId: 'alice',
                        surfaceId: null,
                        x: null,
                        y: null,
                      },
                    ],
                  }),
                },
              ],
            },
          ],
          usage: { input_tokens: 50, output_tokens: 35 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  );
  const result = await provider.generate({
    jobId: randomUUID(),
    purpose: 'speech',
    context,
    signal: new AbortController().signal,
    maxCostMicros: 100,
  });
  assert.equal(calls, 1);
  assert.equal(result.proposal.itemIntents[0].kind, 'give_stock');
  const evaluated = await service.evaluateDecision('synthetic-campaign', s, {
    id: randomUUID(),
    npcId: npc,
    purpose: 'speech',
    context,
    contextHash: context.contextHash,
    proposal: result.proposal,
  });
  assert.equal(evaluated.accepted, true);
  assert.equal(evaluated.next.entities.alice.inventory.length, 1);
  const id = evaluated.next.entities.alice.inventory[0];
  assert.equal(evaluated.next.entities[id].label, 'Battery');
  assert.equal(evaluated.next.npcUtterances.at(-1).text, 'Вот запасная батарея.');
  const stale = await service.evaluateDecision(
    'synthetic-campaign',
    g.finishWorldPhase(evaluated.next, g.turnFence(evaluated.next)).state,
    {
      id: randomUUID(),
      npcId: npc,
      purpose: 'speech',
      context,
      contextHash: context.contextHash,
      proposal: result.proposal,
    },
  );
  assert.equal(stale.accepted, false);
  assert.equal(calls, 1);
});
test('static sprite normalization preserves alpha and rejects opaque or empty art', async () => {
  const rgba = Buffer.alloc(100 * 160 * 4);
  for (let y = 20; y < 145; y++)
    for (let x = 30; x < 70; x++) {
      const i = (y * 100 + x) * 4;
      rgba[i] = 120;
      rgba[i + 1] = 160;
      rgba[i + 2] = 190;
      rgba[i + 3] = 255;
    }
  const bytes = await sharp(rgba, { raw: { width: 100, height: 160, channels: 4 } })
    .png()
    .toBuffer();
  const normalized = await normalizeStaticSprite(bytes);
  assert.equal(normalized.width, 46);
  assert.equal(normalized.height, 131);
  assert.equal((await sharp(normalized.bytes).metadata()).hasAlpha, true);
  const opaque = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  await assert.rejects(() => normalizeStaticSprite(opaque), /ALPHA_REQUIRED/);
  const empty = await sharp({
    create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
  await assert.rejects(() => normalizeStaticSprite(empty), /ALPHA_REQUIRED/);
});
test('appearance source allowlist excludes private fields and source changes fence regeneration', async () => {
  const data = {
    name: 'Engineer',
    appearance: 'Blue suit',
    portraitAssetId: null,
    personality: 'PRIVATE_PERSONALITY',
    secrets: 'PRIVATE_SECRET',
    biography: 'PRIVATE_BIO',
  };
  const c = { query: async () => ({ rows: [{ data }] }) };
  const a = await readCharacterVisualSource(c, 'owner', { kind: 'npc', id: npc });
  assert.equal(JSON.stringify(a).includes('PRIVATE_'), false);
  data.appearance = 'Red suit';
  assert.notEqual(
    (await readCharacterVisualSource(c, 'owner', { kind: 'npc', id: npc })).hash,
    a.hash,
  );
  const request = buildArtRequest(
    {
      id: randomUUID(),
      kind: 'character',
      adventure_id: null,
      revision: 1,
      source_hash: 'a'.repeat(64),
      status: 'concept',
      concept_revision_id: null,
      brief: {
        name: 'Engineer',
        description: 'Blue suit',
        appearance: 'Blue suit',
        renderMode: 'static',
      },
      plan: null,
    },
    'concept',
  );
  assert.match(request.prompt, /static playable character sprite/);
  assert.equal(request.background, 'transparent');
  assert.equal(request.kind, 'sprite');
  assert.deepEqual(requiredArtRoles('character', 'approved', null, { renderMode: 'static' }), []);
});

test('consume is admitted by intent, narrative and story provider contracts', () => {
  const { openAiOutputSchema } = require('../../apps/api/dist/ai/openai-provider');
  const { narrativeActionSchema } = require('../../packages/contracts/dist');
  for (const purpose of ['intent', 'narrative', 'story_turn'])
    assert.ok(JSON.stringify(openAiOutputSchema(purpose)).includes('"consume"'), purpose);
  assert.equal(
    narrativeActionSchema.safeParse({ kind: 'consume', targetId: 'meal' }).success,
    true,
  );
});

test('the actual turn-based story post and intent context expose consume with the same budget', () => {
  const { StoryTurnRuntime } = require('../../apps/api/dist/game/story-turn-runtime');
  const p = structuredClone(plan);
  Object.assign(p.items[0], { edible: true, restoreVitality: 1, visual: 'food' });
  let s = g.createStateFromPlayable(compileStoryPlan(source, p).playable, ['alice']);
  Object.assign(s.entities.alice, { x: 3, y: 3, vitality: 3 });
  s = g.endPlayerTurn(s, 'alice', g.turnFence(s)).state;
  const given = g.materializeNpcItems(
    s,
    npc,
    'alice',
    [{ kind: 'give_stock', definitionId: 'battery', recipientId: 'alice' }],
    'text-story',
  );
  assert.equal(given.error, undefined);
  s = g.finishWorldPhase(given.state, g.turnFence(given.state)).state;
  const service = Object.create(GameService.prototype);
  service.ai = { contextBudgetBytes: () => 64000 };
  const ctx = service.intentContext(s, 'alice', 'eat Battery', randomUUID());
  assert.ok(ctx.allowedActions.includes('consume'));
  assert.ok(ctx.ownInventory.some((e) => e.id === 'item-text-story-0'));
  const runtime = Object.create(StoryTurnRuntime.prototype),
    turnId = randomUUID(),
    input = {
      operationId: randomUUID(),
      text: '*eat Battery*',
      channel: 'say',
      expectedCanonRevision: 0,
      replyLocale: 'en',
      turnFence: g.turnFence(s),
    };
  const preview = g.buildStoryTurnContext(s, 'alice', input, turnId);
  assert.equal(preview.actionPreview[0].action.kind, 'consume');
  const result = runtime.simulateTurnPost(s, 'alice', input, turnId, 'synthetic-owner');
  assert.deepEqual(
    result.actions.map((a) => a.action.kind),
    ['consume'],
  );
  assert.equal(result.state.entities['item-text-story-0'], undefined);
  assert.deepEqual(result.state.entities.alice.inventory, []);
  assert.equal(result.state.turnController.resources.alice.main, 0);
  assert.equal(result.state.entities.alice.vitality, 4);
  assert.equal(result.requests.length, 0);
  assert.ok(
    result.state.npcBrains[npc].living.observations.some((o) => o.kind === 'item_consumed'),
  );
});
