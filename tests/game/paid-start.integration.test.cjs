// Fresh disposable PostgreSQL, injected provider only. Never reads production credentials.
const test = require('node:test'),
  assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readdir, readFile } = require('node:fs/promises');
const { once } = require('node:events');
const net = require('node:net');
const { Pool } = require('pg');
const code = (value) => (e) => e.getResponse?.().code === value;
test(
  'player-funded preparation uses immutable published source and exactly-once launch',
  { timeout: 90000 },
  async (t) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((r) => server.close(r));
    process.env.NODE_ENV = 'test';
    process.env.LOCAL_POSTGRES_CLUSTER = 'paid-start-' + randomUUID();
    process.env.LOCAL_POSTGRES_PORT = String(port);
    delete process.env.DATABASE_URL;
    const { startLocalPostgres } = await import('../../scripts/postgres-local.mjs');
    const cluster = await startLocalPostgres();
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const cm = require.resolve('../../apps/api/dist/config.js');
    require.cache[cm] = {
      id: cm,
      filename: cm,
      loaded: true,
      exports: {
        config: {
          DATABASE_URL: process.env.DATABASE_URL,
          NODE_ENV: 'test',
          WEB_ORIGIN: 'http://localhost',
          ASSET_DIR: '/tmp/unused-paid-start',
        },
      },
    };
    const db = {
      query: async (q, p) => (await pool.query(q, p)).rows,
      tx: async (work) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const v = await work(c);
          await c.query('COMMIT');
          return v;
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally {
          c.release();
        }
      },
    };
    const { PlayableService } = require('../../apps/api/dist/game/playable.service.js');
    const {
      PrivateReleaseService,
    } = require('../../apps/api/dist/story-authoring/private-release.js');
    const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service.js');
    const { PaidStartService } = require('../../apps/api/dist/game/paid-start.service.js');
    const { GameService } = require('../../apps/api/dist/game/game.service.js');
    const { GenerationAuthority } = require('../../apps/api/dist/generation/service.js');
    const { activateReleaseDeployment } = require('../images/release-deployment-fixture.cjs');
    const { readGenerationConfig } = require('../../apps/api/dist/generation/config.js');
    const { AuthoringTextEngine } = require('../../apps/api/dist/live-test/authoring-text.js');
    const { storyPlanDefinition } = require('../../apps/api/dist/game/story-plan.js');
    const { adventureSchema, npcSchema } = require('../../packages/contracts/dist');
    const { ownerProfile } = await import('../images/owner-config-fixture.mjs');
    const auth = { require: async (r) => r.user };
    const art = new AssetReuseService(db);
    const playable = new PlayableService(db, auth, art),
      releases = new PrivateReleaseService(db, playable);
    const cfg = readGenerationConfig({
      GENERATION_MODE: 'release',
      GENERATION_CONFIG_JSON: JSON.stringify({ ...ownerProfile(), aggregateCapMicros: 10000000 }),
    });
    let calls = 0,
      uncertain = false;
    const { ProviderFailure } = require('../../apps/api/dist/ai/types.js');
    const npcId = randomUUID();
    const proposal = {
      version: 1,
      rooms: [
        {
          locationId: 'inn',
          width: 24,
          height: 24,
          spawns: [
            { x: 1, y: 1 },
            { x: 2, y: 1 },
            { x: 3, y: 1 },
            { x: 4, y: 1 },
          ],
          blocked: [],
          surfaces: [],
        },
      ],
      connections: [],
      npcs: [{ sourceNpcId: npcId, locationId: 'inn', x: 5, y: 5, stock: [] }],
      items: [],
    };
    const provider = {
      version: 'paid-start-fixture',
      generate: async () => {
        calls++;
        if (uncertain) throw new ProviderFailure('PROVIDER_USAGE_UNKNOWN', true);
        return {
          proposal,
          requestId: 'injected-' + calls,
          usage: { inputTokens: 10, outputTokens: 10, costMicros: 30, costEvidence: 'reported' },
        };
      },
    };
    const engine = new AuthoringTextEngine(
      db,
      new GenerationAuthority(db, cfg),
      provider,
      storyPlanDefinition,
    );
    const service = new PaidStartService(db, playable, engine);
    const game = new GameService(db, auth, playable, {}, art);
    const owner = randomUUID(),
      player = randomUUID(),
      other = randomUUID(),
      storyId = randomUUID();
    const request = (id) => ({ user: { id, role: 'user' } });
    let version, preparation;
    try {
      for (const f of (await readdir('packages/db/migrations'))
        .filter((x) => x.endsWith('.sql'))
        .sort())
        await pool.query(await readFile('packages/db/migrations/' + f, 'utf8'));
      await db.tx((c) => activateReleaseDeployment(c, cfg));
      for (const id of [owner, player, other]) {
        await pool.query(
          "INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,'synthetic','Fixture',$3)",
          [id, id + '@example.invalid', 'u' + id.replaceAll('-', '').slice(0, 20)],
        );
        await pool.query(
          'INSERT INTO spark_wallets(owner_id,enabled,balance_subunits) VALUES($1,true,500000)',
          [id],
        );
      }
      await pool.query('INSERT INTO npcs(id,owner_id,data) VALUES($1,$2,$3)', [
        npcId,
        owner,
        JSON.stringify(
          npcSchema.parse({
            name: 'Keeper',
            secrets: 'NEVER_PUBLIC_SECRET',
            biography: 'NEVER_PUBLIC_BIOGRAPHY',
          }),
        ),
      ]);
      const data = adventureSchema.parse({
        title: 'Paid-start inn',
        synopsis: 'A small inn for an injected test.',
        visibility: 'private',
        content: {
          npcIds: [npcId],
          locations: [{ id: 'inn', name: 'Inn', description: 'An empty inn.' }],
          scenes: [
            { id: 'entry', name: 'Arrival', description: 'Enter the inn.', locationId: 'inn' },
          ],
          startSceneId: 'entry',
        },
      });
      await pool.query(
        "INSERT INTO adventures(id,owner_id,title,synopsis,slug,genre,status,visibility,data) VALUES($1,$2,$3,$4,$5,'mystery','draft','private',$6)",
        [storyId, owner, data.title, data.synopsis, 'paid-' + storyId, JSON.stringify(data)],
      );
      await t.test('author publishes source without provider call or wallet write', async () => {
        const result = await releases.publish(owner, storyId, {
          operationId: randomUUID(),
          expectedEditRevision: 1,
          expectedGameRevision: 0,
          expectedArtRevision: 0,
        });
        version = result.playableVersionId;
        assert.equal(calls, 0);
        const stored = (
          await db.query('SELECT package FROM game_playable_versions WHERE id=$1', [version])
        )[0].package;
        assert.equal(stored.kind, 'launch-source');
        assert.equal(stored.compiled, null);
        assert.equal(
          (
            await db.query('SELECT balance_subunits FROM spark_wallets WHERE owner_id=$1', [owner])
          )[0].balance_subunits,
          '500000',
        );
        assert.equal(
          (await db.query('SELECT * FROM adventure_game_drafts WHERE adventure_id=$1', [storyId]))
            .length,
          0,
        );
      });
      await t.test('private access is enforced before preparing or quoting', async () => {
        await assert.rejects(
          service.prepare(player, { operationId: randomUUID(), playableVersionId: version }),
          code('FORBIDDEN'),
        );
        await pool.query(
          "INSERT INTO adventure_invitations(id,adventure_id,owner_id,recipient_id,status) VALUES($1,$2,$3,$4,'accepted')",
          [randomUUID(), storyId, owner, player],
        );
        const input = { operationId: randomUUID(), playableVersionId: version };
        preparation = await service.prepare(player, input);
        assert.equal((await service.prepare(player, input)).id, preparation.id);
        assert.equal(preparation.status, 'prepared');
        const beforeRestore = await pool.query(
          'SELECT count(*)::int AS n FROM game_start_preparations',
        );
        assert.equal((await service.byOperation(player, input.operationId)).id, preparation.id);
        assert.equal(await service.byOperation(other, input.operationId), null);
        assert.equal(await service.byOperation(player, randomUUID()), null);
        const afterRestore = await pool.query(
          'SELECT count(*)::int AS n FROM game_start_preparations',
        );
        assert.equal(afterRestore.rows[0].n, beforeRestore.rows[0].n);
        assert.equal((await service.state(player, preparation.id)).jobs.length, 0);
        await assert.rejects(service.state(other, preparation.id), code('NOT_FOUND'));
        await assert.rejects(
          game.create(request(player), { playableVersionId: version }),
          code('START_PREPARATION_REQUIRED'),
        );
      });
      await t.test(
        'player status/export and generic editor never expose foreign author NPC internals',
        async () => {
          const {
            VisualAuthoringService,
          } = require('../../apps/api/dist/visual-authoring/service.js');
          const visuals = new VisualAuthoringService(db, art, { setAuthoringValidator: () => {} });
          await assert.rejects(visuals.get(player, preparation.id), code('NOT_FOUND'));
          assert.ok(!(await visuals.list(player)).some((p) => p.id === preparation.id));
          await assert.rejects(
            visuals.approve(player, preparation.id, {
              operationId: randomUUID(),
              expectedRevision: 1,
              consent: true,
            }),
            code('NOT_FOUND'),
          );
          const {
            exportVisualAuthoring,
          } = require('../../apps/api/dist/visual-authoring/data-requests.js');
          const view = await service.state(player, preparation.id),
            exported = await db.tx((c) => exportVisualAuthoring(c, player));
          assert.doesNotMatch(
            JSON.stringify({ view, exported }),
            /NEVER_PUBLIC_(SECRET|BIOGRAPHY)/,
          );
        },
      );
      await t.test('frozen source survives author edits; player only is charged once', async () => {
        await pool.query(
          "UPDATE adventures SET title='Edited later',edit_revision=edit_revision+1 WHERE id=$1",
          [storyId],
        );
        const quote = await service.quote(player, preparation.id, { operationId: randomUUID() });
        assert.ok(quote.sparks);
        assert.equal(calls, 0);
        const input = { operationId: randomUUID(), quoteId: quote.id, consent: true };
        await service.dispatch(player, preparation.id, input);
        await service.dispatch(player, preparation.id, input);
        const state = await service.state(player, preparation.id);
        assert.equal(state.status, 'ready');
        assert.equal(calls, 1);
        assert.equal(
          (
            await db.query('SELECT balance_subunits FROM spark_wallets WHERE owner_id=$1', [player])
          )[0].balance_subunits,
          '499940',
        );
        assert.equal(
          (
            await db.query('SELECT balance_subunits FROM spark_wallets WHERE owner_id=$1', [owner])
          )[0].balance_subunits,
          '500000',
        );
        assert.equal(
          (await db.query('SELECT * FROM adventure_game_drafts WHERE adventure_id=$1', [storyId]))
            .length,
          0,
        );
      });
      await t.test(
        'simultaneous starts link one campaign; repeat start never pays or creates again',
        async () => {
          const body = {
            playableVersionId: version,
            startPreparationId: preparation.id,
            turnBased: true,
          };
          const [a, b] = await Promise.all([
            game.create(request(player), body),
            game.create(request(player), body),
          ]);
          assert.equal(a.campaignId, b.campaignId);
          assert.equal(calls, 1);
          assert.equal(
            (await db.query('SELECT id FROM game_campaigns WHERE source_version_id=$1', [version]))
              .length,
            1,
          );
          const saved = (
            await db.query('SELECT state FROM game_campaigns WHERE id=$1', [a.campaignId])
          )[0].state;
          assert.equal(saved.narrativePremise.title, 'Paid-start inn');
          await assert.rejects(game.create(request(other), body), code('NOT_FOUND'));
        },
      );
      await t.test(
        'runtime map pixels obey real membership, private-source revocation and takedown SQL',
        async () => {
          await require('./runtime-map-acl.fixture.cjs').verifyRuntimeMapAcl({
            pool,
            owner,
            player,
            storyId,
            version,
          });
        },
      );
      await t.test(
        'runtime exact count uses a durable one-quote preflight outside game locks',
        async () => {
          await require('./runtime-map-preflight.fixture.cjs').verifyRuntimeMapPreflight({
            pool,
            owner,
            player,
            version,
          });
        },
      );
      await t.test(
        'a paid initial plan is reused for this same player and source without another charge',
        async () => {
          const p = await service.prepare(player, {
            operationId: randomUUID(),
            playableVersionId: version,
          });
          assert.equal(p.reused, true);
          assert.equal(p.status, 'ready');
          const previous = await service.state(player, preparation.id);
          const next = await game.create(request(player), {
            playableVersionId: version,
            startPreparationId: p.id,
            turnBased: true,
          });
          assert.notEqual(next.campaignId, previous.campaignId);
          assert.equal(calls, 1);
          assert.equal(
            (
              await db.query('SELECT balance_subunits FROM spark_wallets WHERE owner_id=$1', [
                player,
              ])
            )[0].balance_subunits,
            '499940',
          );
        },
      );
      await t.test('untrusted source art cannot enter a published package', async () => {
        const badId = randomUUID();
        await pool.query(
          "INSERT INTO adventures(id,owner_id,title,synopsis,slug,genre,status,visibility,data) VALUES($1,$2,'Bad source','Fixture',$3,'mystery','draft','private',$4)",
          [badId, owner, 'bad-' + badId, JSON.stringify(data)],
        );
        await pool.query(
          'INSERT INTO art_story_asset_drafts(adventure_id,revision,bindings) VALUES($1,1,$2)',
          [badId, JSON.stringify([{ slot: 'map:inn:background', revisionId: randomUUID() }])],
        );
        await assert.rejects(
          releases.publish(owner, badId, {
            operationId: randomUUID(),
            expectedEditRevision: 1,
            expectedGameRevision: 0,
            expectedArtRevision: 1,
          }),
        );
        assert.equal(
          (await db.query('SELECT id FROM game_playable_versions WHERE adventure_id=$1', [badId]))
            .length,
          0,
        );
      });
      await t.test(
        'unknown usage retains reservation and cannot repeat dispatch with a new operation',
        async () => {
          await pool.query(
            "INSERT INTO adventure_invitations(id,adventure_id,owner_id,recipient_id,status) VALUES($1,$2,$3,$4,'accepted')",
            [randomUUID(), storyId, owner, other],
          );
          const p = await service.prepare(other, {
            operationId: randomUUID(),
            playableVersionId: version,
          });
          const q = await service.quote(other, p.id, { operationId: randomUUID() });
          uncertain = true;
          const input = { operationId: randomUUID(), quoteId: q.id, consent: true };
          await service.dispatch(other, p.id, input);
          await service.dispatch(other, p.id, input);
          const state = await service.state(other, p.id);
          assert.equal(state.jobs[0].status, 'unknown');
          assert.equal(calls, 2);
          const wallet = (
            await db.query('SELECT held_subunits FROM spark_wallets WHERE owner_id=$1', [other])
          )[0];
          assert.ok(BigInt(wallet.held_subunits) > 0n);
          await assert.rejects(service.quote(other, p.id, { operationId: randomUUID() }), (e) =>
            ['START_ALREADY_DISPATCHED', 'GENERATION_ACCOUNT_REVIEW_REQUIRED'].includes(
              e.getResponse?.().code,
            ),
          );
          await assert.rejects(
            game.create(request(other), { playableVersionId: version, startPreparationId: p.id }),
            code('START_PREPARATION_REQUIRED'),
          );
          uncertain = false;
        },
      );
      await t.test('prepared source and captured result are immutable', async () => {
        await assert.rejects(
          pool.query('UPDATE game_start_preparations SET actor_id=$2 WHERE id=$1', [
            preparation.id,
            owner,
          ]),
          /Immutable game start source/,
        );
        await assert.rejects(
          pool.query("UPDATE game_start_preparations SET compiled='{}' WHERE id=$1", [
            preparation.id,
          ]),
          /Immutable game start source/,
        );
      });
      await t.test(
        'compatible authored plan is reused free even without an enabled wallet',
        async () => {
          const { compileStoryPlan } = require('../../apps/api/dist/game/story-plan.js');
          const stored = (
            await db.query('SELECT package FROM game_playable_versions WHERE id=$1', [version])
          )[0].package;
          const draft = compileStoryPlan(stored.plannerSource, proposal).draft;
          await pool.query(
            'INSERT INTO adventure_game_drafts(adventure_id,revision,draft) VALUES($1,1,$2)',
            [storyId, JSON.stringify(draft)],
          );
          const released = await releases.publish(owner, storyId, {
            operationId: randomUUID(),
            expectedEditRevision: 2,
            expectedGameRevision: 1,
            expectedArtRevision: 0,
          });
          await pool.query('UPDATE spark_wallets SET enabled=false WHERE owner_id=$1', [owner]);
          const p = await service.prepare(owner, {
            operationId: randomUUID(),
            playableVersionId: released.playableVersionId,
          });
          assert.equal(p.reused, true);
          assert.equal(p.status, 'ready');
          const started = await game.create(request(owner), {
            playableVersionId: released.playableVersionId,
            startPreparationId: p.id,
            turnBased: true,
          });
          assert.ok(started.campaignId);
          assert.equal(calls, 2);
          assert.equal(
            (
              await db.query('SELECT balance_subunits FROM spark_wallets WHERE owner_id=$1', [
                owner,
              ])
            )[0].balance_subunits,
            '500000',
          );
        },
      );
      await t.test(
        'edited source publishes a new immutable source instead of requiring the removed builder',
        async () => {
          const before = await db.query(
            'SELECT id,checksum,package FROM game_playable_versions WHERE adventure_id=$1 ORDER BY id',
            [storyId],
          );
          const row = (await db.query('SELECT * FROM adventures WHERE id=$1', [storyId]))[0];
          row.data.content.locations.push({
            id: 'yard',
            name: 'Yard',
            description: 'A quiet enclosed yard.',
          });
          await pool.query(
            'UPDATE adventures SET data=$2,edit_revision=edit_revision+1 WHERE id=$1',
            [storyId, JSON.stringify(row.data)],
          );
          const fresh = (
            await db.query('SELECT edit_revision FROM adventures WHERE id=$1', [storyId])
          )[0];
          const released = await releases.publish(owner, storyId, {
            operationId: randomUUID(),
            expectedEditRevision: Number(fresh.edit_revision),
            expectedGameRevision: 1,
            expectedArtRevision: 0,
          });
          const source = (
            await db.query('SELECT package FROM game_playable_versions WHERE id=$1', [
              released.playableVersionId,
            ])
          )[0].package;
          assert.equal(source.kind, 'launch-source');
          assert.equal(source.compiled, null);
          assert.deepEqual(
            source.plannerSource.content.locations.map((l) => l.id),
            ['inn', 'yard'],
          );
          assert.deepEqual(
            await db.query(
              'SELECT id,checksum,package FROM game_playable_versions WHERE id=ANY($1::uuid[]) ORDER BY id',
              [before.map((v) => v.id)],
            ),
            before,
          );
          assert.equal(calls, 2);
        },
      );
      await t.test(
        'standalone legacy authored maps remain free without narrative source links',
        async () => {
          const { createAuthoredDraft } = require('../../packages/game-core/dist');
          const legacyId = randomUUID();
          const legacyData = adventureSchema.parse({
            title: 'Standalone mechanics',
            visibility: 'private',
          });
          await pool.query(
            "INSERT INTO adventures(id,owner_id,title,synopsis,slug,genre,status,visibility,data) VALUES($1,$2,'Standalone mechanics','Fixture',$3,'mystery','draft','private',$4)",
            [legacyId, owner, 'legacy-' + legacyId, JSON.stringify(legacyData)],
          );
          const draft = createAuthoredDraft('courtyard');
          for (const map of draft.maps) delete map.sourceLocationId;
          draft.npcs[0].sourceNpcId = npcId;
          await pool.query(
            'INSERT INTO adventure_game_drafts(adventure_id,revision,draft) VALUES($1,1,$2)',
            [legacyId, JSON.stringify(draft)],
          );
          const row = (await db.query('SELECT * FROM adventures WHERE id=$1', [legacyId]))[0];
          const v = await db.tx((c) => playable.freeze(c, row, 'private', 1));
          assert.ok(
            (await db.query('SELECT package FROM game_playable_versions WHERE id=$1', [v]))[0]
              .package.compiled,
          );
          const result = await game.create(request(owner), {
            playableVersionId: v,
            turnBased: false,
          });
          assert.ok(result.campaignId);
          assert.equal(calls, 2);
        },
      );
      await t.test(
        'public launch source still requires the current approved publication',
        async () => {
          const publicId = randomUUID(),
            dataPublic = { ...data, visibility: 'public' };
          await pool.query(
            "INSERT INTO adventures(id,owner_id,title,synopsis,slug,genre,status,visibility,data) VALUES($1,$2,'Public source','Fixture',$3,'mystery','pending_review','public',$4)",
            [publicId, owner, 'pub-' + publicId, JSON.stringify(dataPublic)],
          );
          const row = (await db.query('SELECT * FROM adventures WHERE id=$1', [publicId]))[0];
          const v = await db.tx((c) => playable.freeze(c, row, 'review'));
          await assert.rejects(
            service.prepare(other, { operationId: randomUUID(), playableVersionId: v }),
            code('FORBIDDEN'),
          );
          const av = randomUUID();
          await pool.query(
            'INSERT INTO adventure_versions(id,adventure_id,version,snapshot) VALUES($1,$2,1,$3)',
            [av, publicId, JSON.stringify({ ...dataPublic, playableVersionId: v })],
          );
          await pool.query(
            'INSERT INTO game_playable_approvals(playable_version_id,adventure_version_id) VALUES($1,$2)',
            [v, av],
          );
          await pool.query(
            "UPDATE adventures SET status='published',published_snapshot=$2 WHERE id=$1",
            [publicId, JSON.stringify({ ...dataPublic, playableVersionId: v })],
          );
          const p = await service.prepare(other, {
            operationId: randomUUID(),
            playableVersionId: v,
          });
          assert.equal(p.status, 'prepared');
          await pool.query("UPDATE adventures SET status='archived' WHERE id=$1", [publicId]);
          await assert.rejects(
            service.quote(other, p.id, { operationId: randomUUID() }),
            code('NOT_FOUND'),
          );
        },
      );
      await t.test('source access revocation blocks future preparation', async () => {
        await pool.query(
          "UPDATE adventure_invitations SET status='revoked' WHERE adventure_id=$1 AND recipient_id=$2",
          [storyId, player],
        );
        await assert.rejects(
          service.prepare(player, { operationId: randomUUID(), playableVersionId: version }),
          code('FORBIDDEN'),
        );
      });
      await t.test(
        'confirmed source-author erasure scrubs foreign-payer planning data but not receipts',
        async () => {
          const {
            eraseVisualAuthoring,
          } = require('../../apps/api/dist/visual-authoring/data-requests.js');
          const { purgeGameData } = await import('../../scripts/game-data-requests.mjs');
          await pool.query('UPDATE spark_wallets SET enabled=true WHERE owner_id=$1', [owner]);
          const latest = (
            await db.query(
              'SELECT playable_version_id FROM adventure_private_releases WHERE adventure_id=$1 ORDER BY created_at DESC LIMIT 1',
              [storyId],
            )
          )[0];
          const queuedPreparation = await service.prepare(owner, {
            operationId: randomUUID(),
            playableVersionId: latest.playable_version_id,
          });
          const queuedQuote = await service.quote(owner, queuedPreparation.id, {
            operationId: randomUUID(),
          });
          const queuedJob = await engine.enqueue(
            owner,
            { operationId: randomUUID(), quoteId: queuedQuote.id, consent: true },
            service.guard(owner),
          );
          assert.equal(queuedJob.status, 'queued');
          assert.ok(
            BigInt(
              (
                await db.query('SELECT held_subunits FROM spark_wallets WHERE owner_id=$1', [owner])
              )[0].held_subunits,
            ) > 0n,
          );
          const before = await db.query(
            'SELECT id,status,reserved_subunits,captured_subunits FROM spark_holds WHERE owner_id=ANY($1::uuid[]) ORDER BY id',
            [[player, other]],
          );
          await assert.rejects(
            db.tx((c) => eraseVisualAuthoring(c, owner)),
            /CONFIRMED_ERASURE_REQUIRED/,
          );
          await db.tx(async (c) => {
            await c.query('UPDATE users SET deleted_at=now() WHERE id=$1', [owner]);
            await c.query("SET LOCAL dreamwalk.erasure='confirmed'");
            await eraseVisualAuthoring(c, owner);
            await purgeGameData(c, owner);
          });
          assert.equal((await db.query('SELECT id FROM game_start_preparations')).length, 0);
          const counts = await db.query(
            'SELECT actor_id,campaign_id,body_sha256,status,result_code FROM runtime_map_token_counts',
          );
          assert.ok(counts.length >= 2);
          assert.ok(
            counts.every(
              (r) =>
                !r.actor_id &&
                !r.campaign_id &&
                !r.body_sha256 &&
                ['erased', 'unknown'].includes(r.status) &&
                r.result_code === 'DATA_ERASED',
            ),
          );

          assert.equal(
            (
              await db.query('SELECT held_subunits FROM spark_wallets WHERE owner_id=$1', [owner])
            )[0].held_subunits,
            '0',
          );
          assert.equal(
            (
              await db.query('SELECT status FROM live_authoring_text_jobs WHERE id=$1', [
                queuedJob.id,
              ])
            )[0].status,
            'cancelled',
          );
          assert.equal(calls, 2);
          const jobs = await db.query(
            'SELECT context,proposal,result,error_code FROM live_authoring_text_jobs WHERE actor_id=$1',
            [player],
          );
          assert.ok(
            jobs.every(
              (j) =>
                j.error_code === 'DATA_ERASED' &&
                JSON.stringify(j.context) === '{}' &&
                !j.proposal &&
                !j.result,
            ),
          );
          assert.deepEqual(
            await db.query(
              'SELECT id,status,reserved_subunits,captured_subunits FROM spark_holds WHERE owner_id=ANY($1::uuid[]) ORDER BY id',
              [[player, other]],
            ),
            before,
          );
        },
      );
    } finally {
      await game.onModuleDestroy();
      await pool.end();
      await cluster.stop();
    }
  },
);
