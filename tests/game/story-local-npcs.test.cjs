const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const configModule = require.resolve('../../apps/api/dist/config.js');
require.cache[configModule] = {
  id: configModule,
  filename: configModule,
  loaded: true,
  exports: { config: { DATABASE_URL: 'postgresql://synthetic@127.0.0.1:1/never_connect' } },
};
const { StoryNpcService } = require('../../apps/api/dist/story-authoring/npcs.js');
const { npcSchema, adventureSchema } = require('../../packages/contracts/dist');

function fixture() {
  const owner = randomUUID(),
    storyId = randomUUID(),
    otherStoryId = randomUUID(),
    templateId = randomUUID();
  const now = new Date('2026-01-01T00:00:00Z');
  const npc = (id, storyId = null) => ({
    id,
    owner_id: owner,
    story_id: storyId,
    source_template_id: null,
    data: npcSchema.parse({ name: 'Keeper', secrets: 'Private secret' }),
    edit_revision: 1,
    created_at: now,
    updated_at: now,
  });
  let state = {
    stories: new Map(),
    npcs: new Map([[templateId, npc(templateId)]]),
    ops: new Map(),
  };
  const data = adventureSchema.parse({
    title: 'Synthetic story',
    synopsis: 'A synthetic story for isolated tests.',
    genre: 'Mystery',
    content: { npcIds: [templateId] },
  });
  for (const id of [storyId, otherStoryId])
    state.stories.set(id, {
      id,
      owner_id: owner,
      status: 'draft',
      edit_revision: 1,
      data: structuredClone(data),
    });
  const query = async (sql, p) => {
    const result = (rows = []) => ({ rows, rowCount: rows.length });
    if (sql.startsWith('SELECT * FROM adventures')) {
      const row = state.stories.get(p[0]);
      return result(
        row && row.owner_id === p[1] && row.status !== 'archived' ? [structuredClone(row)] : [],
      );
    }
    if (sql.startsWith('SELECT owner_id,fingerprint,result')) {
      const row = state.ops.get(p.join(':'));
      return result(row ? [structuredClone(row)] : []);
    }
    if (sql.startsWith('INSERT INTO story_npc_operations')) {
      state.ops.set(`${p[0]}:${p[1]}`, {
        owner_id: p[2],
        fingerprint: p[3],
        result: JSON.parse(p[4]),
      });
      return result();
    }
    if (sql.startsWith('INSERT INTO audit')) return result();
    if (sql.startsWith('SELECT * FROM npcs WHERE id=')) {
      const row = state.npcs.get(p[0]);
      return result(
        row &&
          row.owner_id === p[1] &&
          (sql.includes('story_id IS NULL') ? row.story_id === null : row.story_id === p[2])
          ? [structuredClone(row)]
          : [],
      );
    }
    if (sql.startsWith('SELECT * FROM npcs WHERE owner_id='))
      return result(
        [...state.npcs.values()]
          .filter((n) => n.owner_id === p[0] && n.story_id === p[1])
          .map((n) => structuredClone(n)),
      );
    if (sql.startsWith('INSERT INTO npcs')) {
      const row = npc(p[0]);
      if (sql.includes('source_template_id')) {
        row.story_id = p[2];
        row.source_template_id = p[3];
        row.data = JSON.parse(p[4]);
      } else if (sql.includes('story_id')) {
        row.story_id = p[2];
        row.data = JSON.parse(p[3]);
      } else row.data = JSON.parse(p[2]);
      state.npcs.set(row.id, row);
      return result([structuredClone(row)]);
    }
    if (sql.startsWith('UPDATE npcs')) {
      const row = state.npcs.get(p[0]);
      row.data = JSON.parse(p[1]);
      row.edit_revision++;
      return result([structuredClone(row)]);
    }
    if (sql.startsWith('UPDATE adventures')) {
      const row = state.stories.get(p[0]);
      const next = JSON.parse(p[1]);
      if (JSON.stringify(row.data) !== JSON.stringify(next)) row.edit_revision++;
      row.data = next;
      row.status = 'draft';
      return result([{ edit_revision: row.edit_revision }]);
    }
    if (sql.startsWith('SELECT id FROM assets') || sql.startsWith('SELECT id FROM model_profiles'))
      return result();
    throw new Error(`Unexpected synthetic SQL: ${sql}`);
  };
  let queue = Promise.resolve();
  const db = {
    tx: (work) => {
      const pending = queue.then(async () => {
        const saved = structuredClone(state);
        try {
          return await work({ query });
        } catch (error) {
          state = saved;
          throw error;
        }
      });
      queue = pending.catch(() => {});
      return pending;
    },
  };
  return {
    service: new StoryNpcService(db),
    owner,
    storyId,
    otherStoryId,
    templateId,
    get state() {
      return state;
    },
  };
}
const code = (expected) => (error) => error.getResponse?.().code === expected;
test('explicit import creates a story copy, replaces selected template and replays exactly', async () => {
  const f = fixture(),
    original = structuredClone(f.state.npcs.get(f.templateId));
  const input = { requestId: randomUUID(), expectedStoryRevision: 1, templateId: f.templateId };
  const result = await f.service.importTemplate(f.owner, f.storyId, input);
  assert.notEqual(result.npc.id, f.templateId);
  assert.equal(result.npc.sourceTemplateId, f.templateId);
  assert.deepEqual(f.state.stories.get(f.storyId).data.content.npcIds, [result.npc.id]);
  assert.deepEqual(f.state.npcs.get(f.templateId), original);
  assert.deepEqual(f.state.stories.get(f.otherStoryId).data.content.npcIds, [f.templateId]);
  assert.deepEqual(await f.service.importTemplate(f.owner, f.storyId, input), result);
  assert.equal(f.state.npcs.size, 2);
  await assert.rejects(
    f.service.importTemplate(f.owner, f.storyId, { ...input, templateId: randomUUID() }),
    code('IDEMPOTENCY_CONFLICT'),
  );
});
test('local edits and optional exports cannot mutate original template or a different story', async () => {
  const f = fixture();
  const imported = await f.service.importTemplate(f.owner, f.storyId, {
    requestId: randomUUID(),
    expectedStoryRevision: 1,
    templateId: f.templateId,
  });
  const changed = await f.service.update(f.owner, f.storyId, imported.npc.id, {
    requestId: randomUUID(),
    expectedStoryRevision: imported.storyEditRevision,
    expectedNpcRevision: 1,
    patch: { name: 'Story keeper' },
  });
  assert.equal(changed.npc.sourceRevision, 2);
  assert.equal(f.state.npcs.get(f.templateId).data.name, 'Keeper');
  await assert.rejects(
    f.service.update(f.owner, f.otherStoryId, imported.npc.id, {
      requestId: randomUUID(),
      expectedStoryRevision: 1,
      expectedNpcRevision: 2,
      patch: { name: 'Wrong scope' },
    }),
    code('NOT_FOUND'),
  );
  const exported = await f.service.saveAsTemplate(f.owner, f.storyId, imported.npc.id, {
    requestId: randomUUID(),
    expectedStoryRevision: changed.storyEditRevision,
    expectedNpcRevision: 2,
  });
  assert.equal(exported.npc.storyId, null);
  assert.notEqual(exported.npc.id, imported.npc.id);
  assert.notEqual(exported.npc.id, f.templateId);
  assert.equal(exported.npc.name, 'Story keeper');
});
test('stale and concurrent creates are rejected without orphaned NPCs; replay is idempotent', async () => {
  const f = fixture();
  const input = { requestId: randomUUID(), expectedStoryRevision: 1, npc: { name: 'New keeper' } };
  const [first, replay] = await Promise.all([
    f.service.create(f.owner, f.storyId, input),
    f.service.create(f.owner, f.storyId, input),
  ]);
  assert.deepEqual(first, replay);
  await assert.rejects(
    f.service.create(f.owner, f.storyId, { ...input, requestId: randomUUID() }),
    code('STALE_STATE'),
  );
  assert.equal(f.state.npcs.size, 2);
  const update = {
    requestId: randomUUID(),
    expectedStoryRevision: first.storyEditRevision,
    expectedNpcRevision: 1,
    patch: { name: 'Changed keeper' },
  };
  await f.service.update(f.owner, f.storyId, first.npc.id, update);
  await assert.rejects(
    f.service.update(f.owner, f.storyId, first.npc.id, { ...update, requestId: randomUUID() }),
    code('STALE_STATE'),
  );
});
test('unowned stories, global-template editing, foreign references and invalid schemas fail closed', async () => {
  const f = fixture();
  await assert.rejects(f.service.list(randomUUID(), f.storyId), code('NOT_FOUND'));
  await assert.rejects(
    f.service.update(f.owner, f.storyId, f.templateId, {
      requestId: randomUUID(),
      expectedStoryRevision: 1,
      expectedNpcRevision: 1,
      patch: { name: 'Forbidden global edit' },
    }),
    code('NOT_FOUND'),
  );
  await assert.rejects(
    f.service.create(f.owner, f.storyId, {
      requestId: randomUUID(),
      expectedStoryRevision: 1,
      npc: { name: 'Foreign portrait', portraitAssetId: randomUUID() },
    }),
    code('VALIDATION_FAILED'),
  );
  await assert.rejects(
    f.service.create(f.owner, f.storyId, {
      requestId: randomUUID(),
      expectedStoryRevision: 1,
      npc: { name: 'Foreign model', modelProfileId: randomUUID() },
    }),
    code('VALIDATION_FAILED'),
  );
  await assert.rejects(
    f.service.create(f.owner, f.storyId, {
      requestId: randomUUID(),
      expectedStoryRevision: 1,
      npc: { name: 'Child', age: 12 },
    }),
  );
  assert.equal(f.state.npcs.size, 1);
  assert.equal(f.state.ops.size, 0);
});
