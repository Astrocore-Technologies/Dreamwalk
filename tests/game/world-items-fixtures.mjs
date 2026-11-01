/** Synthetic local acceptance fixtures, not generated art or a live model decision. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url),
  sharp = require('sharp');
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service'),
  { VisualAuthoringService } = require('../../apps/api/dist/visual-authoring/service'),
  { normalizeRaster, storeRasterTx } = require('../../apps/api/dist/assets/raster'),
  { buildArtRequest } = require('../../apps/api/dist/visual-authoring/real-art'),
  { compileStoryPlan } = require('../../apps/api/dist/game/story-plan');
export function database(pool) {
  return {
    query: async (sql, v = []) => (await pool.query(sql, v)).rows,
    tx: async (work) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await work(c);
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    },
  };
}
export async function spriteFixture(db, owner, target) {
  const databaseAdapter = database(db),
    assets = new AssetReuseService(databaseAdapter),
    visuals = new VisualAuthoringService(databaseAdapter, assets, { setAuthoringValidator() {} });
  const project = await visuals.prepareCharacterSprite(owner.user.id, {
    operationId: randomUUID(),
    target,
    appearance: 'An adult in a blue coat, brown trousers and dark boots.',
    sourcePhotoPermission: false,
    allowOutputReuse: false,
  });
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><ellipse cx="100" cy="53" rx="25" ry="30" fill="#d6af8e"/><path d="M72 38Q78 6 106 18Q133 26 126 52L111 32Z" fill="#4c3534"/><path d="M70 88Q100 70 130 88L148 190L122 201L119 158L116 242L84 242L81 158L78 201L52 190Z" fill="#526f8f" stroke="#263849" stroke-width="4"/><path d="M84 236L99 236L98 275L79 275Z M102 236L117 236L123 275L104 275Z" fill="#5a4b43"/><path d="M79 268L99 268L97 285L69 285Z M104 268L123 268L133 285L104 285Z" fill="#29262e"/><path d="M98 89L96 198M74 151L127 151" stroke="#c2ad84" stroke-width="4"/></svg>';
  const bytes = await sharp(Buffer.from(svg)).png().toBuffer(),
    raster = await normalizeRaster(bytes, 'image/png', true);
  const revision = await databaseAdapter.tx(async (c) => {
    await assets.lockAuthor(c, owner.user.id);
    const uploadId = randomUUID();
    await storeRasterTx(c, owner.user.id, uploadId, raster);
    return assets.registerTx(c, owner.user.id, {
      operationId: randomUUID(),
      uploadId,
      metadata: {
        title: 'Synthetic static sprite fixture',
        kind: 'sprite',
        style: 'drawn2D',
        camera: 'top-down',
        tags: ['test-fixture'],
        variant: 'static-fixture',
        provenance: {
          source: 'generated',
          provider: 'synthetic-offline-fixture',
          reference: 'No external provider calls',
        },
        rights: {
          basis: 'generated',
          licenseLabel: 'Test fixture',
          attribution: '',
          allowAuthorReuse: false,
          attested: true,
        },
      },
    });
  });
  const row = (await db.query('SELECT * FROM visual_authoring_projects WHERE id=$1', [project.id]))
      .rows[0],
    request = buildArtRequest(row, 'concept');
  await db.query(
    "INSERT INTO visual_authoring_stage_items(project_id,role,stage,expected_project_revision,request,reused_revision_id) VALUES($1,'concept','concept',1,$2,$3)",
    [project.id, JSON.stringify(request), revision.id],
  );
  const approved = await visuals.approve(owner.user.id, project.id, {
    operationId: randomUUID(),
    expectedRevision: 1,
    consent: true,
  });
  const completeInput = {
    operationId: randomUUID(),
    expectedRevision: approved.revision,
    consent: true,
    visualReview: true,
  };
  const pkg = await visuals.complete(owner.user.id, project.id, completeInput);
  assert.equal(pkg.representation, 'static');
  assert.equal(pkg.animation, undefined);
  assert.deepEqual(
    pkg.parts.map((p) => p.role),
    ['sprite'],
  );
  const repeat = await visuals.complete(owner.user.id, project.id, completeInput);
  assert.equal(repeat.id, pkg.id);
  const equip = {
    operationId: randomUUID(),
    heroId: target.id,
    targetType: target.kind,
    createTarget: false,
  };
  await visuals.equip(owner.user.id, pkg.id, equip);
  await visuals.equip(owner.user.id, pkg.id, equip);
  return pkg;
}
export async function bridgeFixture(db, owner) {
  const npc = await owner.request('/npcs', {
    name: 'Engineer',
    appearance: 'Blue coat and boots.',
    personality: 'Patient.',
    secrets: 'SOURCE_SECRET_MUST_NOT_ENTER_VISUAL_BRIEF',
  });
  await spriteFixture(db, owner, { kind: 'npc', id: npc.id });
  const story = await owner.request('/studio/adventures', {
    title: 'Generic bridge QA',
    content: {
      world: 'A repair workshop and small waiting room.',
      rules: 'Items are finite.',
      locations: [
        {
          id: 'workshop',
          name: 'Repair workshop',
          description: 'A workbench with spare batteries.',
        },
        { id: 'waiting', name: 'Waiting room', description: 'A quiet waiting area.' },
      ],
      npcIds: [npc.id],
      scenes: [
        {
          id: 'arrival',
          name: 'Arrival',
          locationId: 'workshop',
          description: 'The engineer greets a guest.',
        },
      ],
      startSceneId: 'arrival',
      boundaries: [],
    },
  });
  const prepare = await owner.request('/story-builds/adventures/' + story.id + '/prepare', {
    operationId: randomUUID(),
  });
  assert.equal(prepare.providerCalls, 0);
  const row = (
    await db.query('SELECT * FROM story_playable_builds WHERE project_id=$1', [prepare.id])
  ).rows[0];
  assert.equal(JSON.stringify(row.source_snapshot.source.npcs).includes('SOURCE_SECRET'), false);
  const room = (id) => ({
    locationId: id,
    width: 10,
    height: 8,
    spawns: [
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 2, y: 3 },
      { x: 3, y: 3 },
    ],
    blocked: [],
    surfaces: [],
  });
  const proposal = {
    version: 1,
    rooms: [room('workshop'), room('waiting')],
    connections: [{ a: 'workshop', b: 'waiting', atA: { x: 8, y: 4 }, atB: { x: 1, y: 4 } }],
    npcs: [
      {
        sourceNpcId: npc.id,
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
        description: 'A spare battery.',
        visual: 'battery',
        portable: true,
        edible: false,
        restoreVitality: 0,
      },
    ],
  };
  const checked = compileStoryPlan(row.source_snapshot.source, proposal);
  await db.query(
    "UPDATE story_playable_builds SET status='proposed',proposal=$2,draft=$3 WHERE project_id=$1",
    [prepare.id, JSON.stringify(checked.proposal), JSON.stringify(checked.draft)],
  );
  const apply = {
    operationId: randomUUID(),
    sourceHash: row.source_hash,
    reviewed: true,
    imageReuseConsent: true,
  };
  const applied = await owner.request('/story-builds/' + prepare.id + '/apply', apply);
  assert.equal(applied.applied, true);
  assert.deepEqual(await owner.request('/story-builds/' + prepare.id + '/apply', apply), applied);
  const version = await owner.request('/studio/adventures/' + story.id + '/playable-versions', {
    expectedRevision: applied.playableRevision,
  });
  const campaign = await owner.request('/game/campaigns', { playableVersionId: version.versionId });
  const payload = (
    await db.query('SELECT state FROM game_campaigns WHERE id=$1', [campaign.campaignId])
  ).rows[0].state;
  assert.equal(Object.keys(payload.maps).length, 2);
  assert.equal(payload.entities[npc.id].characterAnimation, undefined);
  assert.ok(payload.artBindings.some((b) => b.slot === 'entity:' + npc.id + ':sprite'));
  assert.equal(payload.entities[npc.id].label, 'Engineer');
  const hero = await owner.request('/heroes', { name: 'Test hero' });
  await spriteFixture(db, owner, { kind: 'hero', id: hero.id });
  return { npcId: npc.id, heroId: hero.id };
}
