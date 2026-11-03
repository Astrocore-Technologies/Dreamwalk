/** Called only by the disposable paid-start PostgreSQL suite; all rows roll back. */
exports.verifyRuntimeMapAcl = async ({ pool, owner, player, storyId, version }) => {
  const assert = require('node:assert/strict');
  const { randomUUID, createHash } = require('node:crypto');
  const { mkdtemp, writeFile, rm } = require('node:fs/promises');
  const { tmpdir } = require('node:os'),
    { join } = require('node:path');
  const sharp = require('sharp');
  const {
    extendRuntimeMap,
    runtimeMapStillCurrent,
  } = require('../../apps/api/dist/game/runtime-map-context');
  const { config } = require('../../apps/api/dist/config');
  const directory = await mkdtemp(join(tmpdir(), 'runtime-vision-pg-'));
  const priorDirectory = config.ASSET_DIR;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    config.ASSET_DIR = directory;
    const current = (
      await c.query(
        "SELECT c.id,c.state,m.actor_id FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id WHERE c.source_version_id=$1 AND m.user_id=$2 AND m.status='accepted' LIMIT 1",
        [version, player],
      )
    ).rows[0];
    assert.ok(current);
    const state = current.state,
      actorId = current.actor_id,
      map = state.maps[state.entities[actorId].mapId];
    delete map.backgroundMode;
    delete map.spatialGrounding;
    const bytes = await sharp({
      create: { width: 400, height: 200, channels: 3, background: '#5577aa' },
    })
      .png()
      .toBuffer();
    await writeFile(join(directory, 'synthetic.png'), bytes);
    const sha = createHash('sha256').update(bytes).digest('hex'),
      upload = randomUUID(),
      family = randomUUID(),
      revision = randomUUID(),
      slot = `map:${map.id}:background`;
    await c.query(
      "INSERT INTO assets(id,owner_id,filename,mime,width,height,bytes,sha256) VALUES($1,$2,'synthetic.png','image/png',400,200,$3,$4)",
      [upload, owner, bytes.length, sha],
    );
    await c.query('INSERT INTO art_asset_families(id,owner_id,head_revision) VALUES($1,$2,1)', [
      family,
      owner,
    ]);
    await c.query(
      "INSERT INTO art_asset_revisions(id,family_id,revision,upload_id,metadata,sha256,mime,width,height) VALUES($1,$2,1,$3,$4,$5,'image/png',400,200)",
      [
        revision,
        family,
        upload,
        JSON.stringify({ kind: 'background', camera: 'unrestricted' }),
        sha,
      ],
    );
    await c.query(
      "INSERT INTO art_campaign_pins(campaign_id,slot,revision_id,rights_snapshot) VALUES($1,$2,$3,'{}')",
      [current.id, slot, revision],
    );
    state.artBindings = [
      { slot, revisionId: revision, sha256: sha, mime: 'image/png', width: 400, height: 200 },
    ];
    const query = async (sql, args) => (await c.query(sql, args)).rows;
    const context = await extendRuntimeMap(
      { query },
      current.id,
      state,
      actorId,
      { contextHash: 'pg-acl' },
      'narrative',
    );
    assert.ok(context.runtimeMapImage);
    const check = () => runtimeMapStillCurrent(query, current.id, state, context);
    assert.equal(await check(), true);
    await c.query("UPDATE game_members SET status='revoked' WHERE campaign_id=$1 AND user_id=$2", [
      current.id,
      player,
    ]);
    assert.equal(await check(), false, 'revoked membership cannot reuse quoted image');
    await assert.rejects(
      extendRuntimeMap(
        { query },
        current.id,
        state,
        actorId,
        { contextHash: 'denied' },
        'narrative',
      ),
      /MAP_VIEW_UNAVAILABLE/,
    );
    await c.query("UPDATE game_members SET status='accepted' WHERE campaign_id=$1 AND user_id=$2", [
      current.id,
      player,
    ]);
    await c.query(
      "UPDATE adventure_invitations SET status='revoked' WHERE adventure_id=$1 AND recipient_id=$2",
      [storyId, player],
    );
    assert.equal(await check(), false, 'revoked private source cannot reuse quoted image');
    await c.query(
      "UPDATE adventure_invitations SET status='accepted' WHERE adventure_id=$1 AND recipient_id=$2",
      [storyId, player],
    );
    assert.equal(await check(), true);
    const wrong = structuredClone(state);
    wrong.artBindings[0].slot = `map:another-location:background`;
    assert.equal(
      await runtimeMapStillCurrent(query, current.id, wrong, context),
      false,
      'other-map pin is never a current image',
    );
    await c.query(
      "INSERT INTO art_asset_takedowns(revision_id,reason_code) VALUES($1,'rights_issue')",
      [revision],
    );
    assert.equal(await check(), false, 'takedown prevents dispatch despite saved bytes');
  } finally {
    await c.query('ROLLBACK');
    c.release();
    config.ASSET_DIR = priorDirectory;
    await rm(directory, { recursive: true, force: true });
  }
};
