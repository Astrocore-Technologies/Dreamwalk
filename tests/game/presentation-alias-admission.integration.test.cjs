// Disposable local PostgreSQL; narrow queue/source fence, not full migration or provider proof.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { rmSync } = require('node:fs');
const path = require('node:path');
const core = require('@dreamwalk/game-core');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service');
const { StoryTurnRuntime } = require('../../apps/api/dist/game/story-turn-runtime');
const { digest } = require('../../apps/api/dist/ai/context');
const {
  capturePresentationAliases,
  assertPresentationAliasAuthority,
} = require('../../apps/api/dist/game/presentation-aliases');

test(
  'PostgreSQL native queue alias fence rolls back before spend, locks membership lifetime and keeps exact replay guarded',
  { timeout: 90000 },
  async () => {
    const net = require('node:net'),
      { once } = require('node:events'),
      { Pool } = require('pg');
    const { startLocalPostgres } = await import('../../scripts/postgres-local.mjs');
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const cluster = 'alias-admission-' + randomUUID();
    process.env.LOCAL_POSTGRES_CLUSTER = cluster;
    process.env.LOCAL_POSTGRES_PORT = String(port);
    delete process.env.DATABASE_URL;
    const database = await startLocalPostgres();
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const ends = [];
    pool.on('connect', (client) =>
      ends.push(new Promise((resolve) => client.once('end', resolve))),
    );
    const tx = async (work) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const value = await work(c);
        await c.query('COMMIT');
        return value;
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      } finally {
        c.release();
      }
    };
    const db = { tx, query: async (...args) => (await pool.query(...args)).rows };
    const owner = randomUUID(),
      viewer = randomUUID(),
      adventure = randomUUID(),
      version = randomUUID(),
      campaign = randomUUID();
    const draft = core.createCompleteObservatoryDraft();
    delete draft.supportingNpcPolicy;
    const compiled = core.compilePlayableDraft(draft).playable;
    compiled.entities.key.label = 'Старинный пропуск';
    delete compiled.entities.key.labelTranslations;
    const state = core.createStateFromPlayable(compiled, ['alice', 'bob']);
    state.narrativeSource = { versionId: version, checksum: 'c'.repeat(64) };
    delete state.turnController;
    Object.assign(state.entities.alice, { x: 5, y: 4 });
    Object.assign(state.entities.key, { x: 5, y: 5 });
    const pkg = JSON.parse(JSON.stringify({ schemaVersion: 1, compiled }));
    const input = {
      operationId: randomUUID(),
      text: '*take Brass pass*',
      channel: 'say',
      replyLocale: 'en',
      expectedCanonRevision: 0,
    };
    let planned = 0,
      admissions = 0;
    try {
      // Only exact columns reached by actual queue authorize/replay and alias source load.
      await pool.query(`
      CREATE TABLE users(id uuid PRIMARY KEY,deleted_at timestamptz,translation_epoch uuid NOT NULL DEFAULT gen_random_uuid());
      CREATE TABLE adventures(id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id),deleted_at timestamptz,status text NOT NULL,visibility text NOT NULL,published_snapshot jsonb,private_release_id uuid,translation_epoch uuid NOT NULL DEFAULT gen_random_uuid());
      CREATE TABLE game_playable_versions(id uuid PRIMARY KEY,adventure_id uuid NOT NULL REFERENCES adventures(id),package jsonb NOT NULL,checksum text NOT NULL,audience text NOT NULL);
      CREATE TABLE game_playable_approvals(playable_version_id uuid PRIMARY KEY REFERENCES game_playable_versions(id));
      CREATE TABLE adventure_private_releases(id uuid PRIMARY KEY,adventure_id uuid NOT NULL REFERENCES adventures(id),playable_version_id uuid NOT NULL REFERENCES game_playable_versions(id),snapshot jsonb NOT NULL DEFAULT '{}');
      CREATE TABLE adventure_invitations(id uuid PRIMARY KEY,adventure_id uuid NOT NULL REFERENCES adventures(id),recipient_id uuid NOT NULL REFERENCES users(id),status text NOT NULL,translation_epoch uuid NOT NULL DEFAULT gen_random_uuid(),UNIQUE(adventure_id,recipient_id));
      CREATE TABLE game_campaigns(id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id),source_version_id uuid NOT NULL REFERENCES game_playable_versions(id),state jsonb NOT NULL,status text NOT NULL,translation_epoch uuid NOT NULL DEFAULT gen_random_uuid());
      CREATE TABLE game_snapshots(campaign_id uuid PRIMARY KEY REFERENCES game_campaigns(id),state jsonb NOT NULL,checksum text NOT NULL);
      CREATE TABLE game_members(campaign_id uuid NOT NULL REFERENCES game_campaigns(id),user_id uuid NOT NULL REFERENCES users(id),actor_id text NOT NULL,status text NOT NULL,translation_epoch uuid NOT NULL DEFAULT gen_random_uuid(),PRIMARY KEY(campaign_id,user_id));
      CREATE TABLE npc_ai_jobs(id uuid PRIMARY KEY,campaign_id uuid NOT NULL,operation_id uuid NOT NULL,request_hash text NOT NULL,npc_id text NOT NULL,origin text NOT NULL,subject_kind text NOT NULL,requester_user_id uuid,purpose text NOT NULL,context jsonb NOT NULL,request_meta jsonb NOT NULL);
      CREATE TABLE alias_admission_marker(id uuid PRIMARY KEY);
      CREATE TABLE game_story_turns(id uuid PRIMARY KEY,campaign_id uuid NOT NULL,requester_user_id uuid NOT NULL,operation_id uuid NOT NULL,request_hash text NOT NULL,context jsonb NOT NULL,quote_result jsonb NOT NULL,status text NOT NULL,erased_at timestamptz,result_code text);
    `);
      await pool.query('INSERT INTO users(id) VALUES($1),($2)', [owner, viewer]);
      await pool.query(
        "INSERT INTO adventures(id,owner_id,status,visibility,published_snapshot) VALUES($1,$2,'published','public','{}')",
        [adventure, owner],
      );
      await pool.query("INSERT INTO game_playable_versions VALUES($1,$2,$3,$4,'review')", [
        version,
        adventure,
        pkg,
        digest(pkg),
      ]);
      await pool.query('INSERT INTO game_playable_approvals VALUES($1)', [version]);
      await pool.query(
        "INSERT INTO game_campaigns(id,owner_id,source_version_id,state,status) VALUES($1,$2,$3,$4,'active')",
        [campaign, viewer, version, state],
      );
      await pool.query('INSERT INTO game_snapshots VALUES($1,$2,$3)', [
        campaign,
        state,
        digest(state),
      ]);
      await pool.query(
        "INSERT INTO game_members(campaign_id,user_id,actor_id,status) VALUES($1,$2,'alice','accepted')",
        [campaign, viewer],
      );
      const aliases = await capturePresentationAliases(
        db,
        {
          readyFields: async () => [
            {
              source: { kind: 'playable', id: version },
              partition: 'released-descriptions',
              path: 'entity/key/label',
              sourceText: compiled.entities.key.label,
              text: 'Brass pass',
              translationKey: '1'.repeat(64),
            },
          ],
        },
        campaign,
        { title: compiled.title, playableVersionId: version },
        state,
        'alice',
        viewer,
        input,
      );
      assert.ok(aliases);
      const context = core.buildStoryTurnContext(state, 'alice', input, input.operationId, aliases);
      const scope = {
        campaignId: campaign,
        npcId: 'alice',
        subjectKind: 'player',
        origin: 'user',
        purpose: 'story_turn',
        requesterUserId: viewer,
      };
      const request = { scope, operationId: input.operationId, context };
      const engine = Object.create(NpcAiEngine.prototype);
      engine.db = db;
      engine.provider = { id: 'synthetic', version: 'v1', external: false };
      engine.policy = { maxContextBytes: 1000000 };
      engine.requestPlan = async () => {
        planned++;
        throw Error('Unexpected request planning');
      };
      // DTO rendering is outside this transaction test. Authorization/queue SQL are real.
      engine.dto = async (_c, row) => ({ id: row.id });
      const writer = await pool.connect();
      try {
        await writer.query("SET lock_timeout='100ms'");
        await assert.rejects(
          () =>
            engine.queue(request, async (c) => {
              admissions++;
              await assertPresentationAliasAuthority(
                c,
                campaign,
                viewer,
                'alice',
                aliases,
                input.text,
              );
              await c.query('INSERT INTO alias_admission_marker VALUES($1)', [randomUUID()]);
              await assert.rejects(
                () =>
                  writer.query(
                    'UPDATE game_members SET translation_epoch=gen_random_uuid() WHERE campaign_id=$1',
                    [campaign],
                  ),
                (error) => error.code === '55P03',
              );
              throw Error('SYNTHETIC_ADMISSION_REJECTED');
            }),
          /SYNTHETIC_ADMISSION_REJECTED/,
        );
      } finally {
        writer.release();
      }
      assert.equal(planned, 0);
      assert.equal(admissions, 1);
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM alias_admission_marker')).rows[0].n,
        0,
        'same transaction rolled back',
      );
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM npc_ai_jobs')).rows[0].n,
        0,
        'no new native job',
      );
      await pool.query(
        'UPDATE game_members SET translation_epoch=gen_random_uuid() WHERE campaign_id=$1',
        [campaign],
      );
      await assert.rejects(
        () =>
          engine.queue(request, (c) =>
            assertPresentationAliasAuthority(c, campaign, viewer, 'alice', aliases, input.text),
          ),
        /INVALID_PRESENTATION_ALIASES/,
      );
      assert.equal(planned, 0);
      const jobId = randomUUID();
      const requestHash = digest({
        scope,
        context,
        quoteId: null,
        consent: false,
        requestKey: '',
        sponsorId: null,
        runtimeRequestId: null,
        acceptedWorldBatchId: null,
      });
      await pool.query('INSERT INTO npc_ai_jobs VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [
        jobId,
        campaign,
        input.operationId,
        requestHash,
        'alice',
        'user',
        'player',
        viewer,
        'story_turn',
        context,
        {},
      ]);
      assert.deepEqual(
        await engine.queue(request, async () =>
          assert.fail('existing operation never repeats alias admission'),
        ),
        { id: jobId },
      );
      assert.equal(planned, 0);
      // Replayed quotes also reauthorize AFTER initial access and reread locked rows.
      const quoteResult = {
        status: 'quoted',
        quote: { expiresAt: new Date(Date.now() + 300000).toISOString() },
      };
      await pool.query(
        "INSERT INTO game_story_turns(id,campaign_id,requester_user_id,operation_id,request_hash,context,quote_result,status) VALUES($1,$2,$3,$4,$5,'{}',$6,'quoted')",
        [randomUUID(), campaign, viewer, input.operationId, digest(input), quoteResult],
      );
      let revokeBetweenAccessAndReplay = false;
      const runtime = new StoryTurnRuntime(
        db,
        {},
        {
          serial: (_id, work) => work(),
          access: async () => ({ user: { id: viewer }, actorId: 'alice', ownerId: viewer }),
          load: async () => {
            if (revokeBetweenAccessAndReplay)
              await pool.query("UPDATE game_members SET status='revoked' WHERE campaign_id=$1", [
                campaign,
              ]);
            return { state };
          },
          presentationAliases: async () => assert.fail('old quote never recaptures'),
        },
      );
      assert.deepEqual(await runtime.quote({ headers: {} }, campaign, input), quoteResult);
      revokeBetweenAccessAndReplay = true;
      await assert.rejects(() => runtime.quote({ headers: {} }, campaign, input), /FORBIDDEN/);
      await assert.rejects(
        () =>
          engine.queue(request, async () => assert.fail('revoked authorization precedes callback')),
        /FORBIDDEN/,
      );
      assert.equal(planned, 0);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM npc_ai_jobs')).rows[0].n, 1);
      assert.equal(
        (await pool.query('SELECT checksum FROM game_snapshots WHERE campaign_id=$1', [campaign]))
          .rows[0].checksum,
        digest(state),
      );
      assert.deepEqual(
        (await pool.query('SELECT package FROM game_playable_versions WHERE id=$1', [version]))
          .rows[0].package,
        pkg,
      );
    } finally {
      await pool.end();
      await Promise.all(ends);
      await database.stop();
      rmSync(path.resolve(__dirname, '../../.local', cluster), { recursive: true, force: true });
    }
  },
);
