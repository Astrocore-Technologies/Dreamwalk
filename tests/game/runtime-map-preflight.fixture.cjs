/** Real disposable PostgreSQL quote flow; transport is synthetic and never calls OpenAI. */
exports.verifyRuntimeMapPreflight = async ({ pool, owner, player, version }) => {
  const assert = require('node:assert/strict');
  const { randomUUID, createHash } = require('node:crypto');
  const { mkdtemp, writeFile, rm } = require('node:fs/promises');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const sharp = require('sharp');
  const { config } = require('../../apps/api/dist/config');
  const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service');
  const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider');
  const { extendRuntimeMap } = require('../../apps/api/dist/game/runtime-map-context');
  const db = {
    query: async (sql, values) => (await pool.query(sql, values)).rows,
    tx: async (work) => {
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
    },
  };
  const current = (
    await db.query(
      "SELECT c.id,c.state,c.revision,m.actor_id FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id WHERE c.source_version_id=$1 AND m.user_id=$2 AND m.status='accepted' LIMIT 1",
      [version, player],
    )
  )[0];
  const originalState = structuredClone(current.state);
  const state = current.state,
    actor = current.actor_id,
    map = state.maps[state.entities[actor].mapId];
  delete map.backgroundMode;
  delete map.spatialGrounding;
  const dir = await mkdtemp(join(tmpdir(), 'runtime-count-pg-')),
    prior = config.ASSET_DIR;
  config.ASSET_DIR = dir;
  try {
    const bytes = await sharp({
      create: { width: 400, height: 200, channels: 3, background: '#447788' },
    })
      .png()
      .toBuffer();
    await writeFile(join(dir, 'count-fixture.png'), bytes);
    const sha = createHash('sha256').update(bytes).digest('hex'),
      upload = randomUUID(),
      family = randomUUID(),
      revision = randomUUID(),
      slot = `map:${map.id}:background`;
    await db.query(
      "INSERT INTO assets(id,owner_id,filename,mime,width,height,bytes,sha256) VALUES($1,$2,'count-fixture.png','image/png',400,200,$3,$4)",
      [upload, owner, bytes.length, sha],
    );
    await db.query('INSERT INTO art_asset_families(id,owner_id,head_revision) VALUES($1,$2,1)', [
      family,
      owner,
    ]);
    await db.query(
      "INSERT INTO art_asset_revisions(id,family_id,revision,upload_id,metadata,sha256,mime,width,height) VALUES($1,$2,1,$3,$4,$5,'image/png',400,200)",
      [
        revision,
        family,
        upload,
        JSON.stringify({ kind: 'background', camera: 'unrestricted' }),
        sha,
      ],
    );
    await db.query(
      "INSERT INTO art_campaign_pins(campaign_id,slot,revision_id,rights_snapshot) VALUES($1,$2,$3,'{}')",
      [current.id, slot, revision],
    );
    state.artBindings = [
      { slot, revisionId: revision, sha256: sha, mime: 'image/png', width: 400, height: 200 },
    ];
    // Exercise consent in a valid world phase, not an unrelated stale turn fence.
    if (state.turnController) state.turnController.phase = 'world';
    await db.query('UPDATE game_campaigns SET state=$2 WHERE id=$1', [current.id, state]);
    const baseContext = (salt) => ({
      contextHash: 'preflight-' + salt,
      ...(state.turnController
        ? {
            turnFence: {
              roundId: state.turnController.roundId,
              phaseEpoch: state.turnController.phaseEpoch,
              rulesetVersion: state.turnController.ruleset.version,
            },
          }
        : {}),
    });
    const pricing = {
      source: 'https://developers.openai.com/api/docs/pricing',
      reviewedAt: '2026-01-01T00:00:00Z',
      validUntil: '2030-01-01T00:00:00Z',
    };
    const cfg = {
      enabled: true,
      apiKey: 'synthetic-only',
      model: 'synthetic-count-image',
      version: 'count-pg-v1',
      maxInputBytes: 4194304,
      maxModelInputTokens: 100000,
      contextBudgetTokens: 60000,
      maxOutputTokens: 1024,
      maxResponseBytes: 128000,
      inputMicrosPerMillion: 1000000,
      outputMicrosPerMillion: 2000000,
      pricing,
      estimation: {
        kind: 'operator_heuristic',
        textTokensPerKiBUtf8: 1024,
        textProtocolTokens: 4096,
        marginBps: 0,
        fixedMarginMicros: 0,
      },
      runtimeVision: {
        model: 'synthetic-count-image',
        counting: 'operational_exact',
        maxImages: 1,
        detail: 'high',
        billing: 'text_input_rate',
        maxPricedInputTokens: 60000,
        pricing,
      },
    };
    let calls = 0,
      serialLocked = false,
      uncertain = false;
    const transport = async (url) => {
      calls++;
      assert.equal(serialLocked, false, 'campaign serial scope unwound before network');
      assert.equal(url, 'https://api.openai.com/v1/responses/input_tokens');
      await db.tx(async (c) => {
        const lock = (
          await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [
            `npc-ai-quote:${player}`,
          ])
        ).rows[0];
        assert.equal(lock.acquired, true, 'quote transaction lock released before network');
      });
      if (uncertain) throw new Error('injected unknown');
      return new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: 1234 }));
    };
    let provider;
    const make = () => {
      provider = new OpenAiNpcProvider(cfg, transport);
      const engine = new NpcAiEngine(db, provider, {
        externalApproved: true,
        providerUpperMicros: 1000000,
        providerCapMicros: 10000000,
      });
      engine.attachRuntimeStateReader(
        () => state,
        () => Number(current.revision),
      );
      return engine;
    };
    let engine = make();
    const scope = {
      campaignId: current.id,
      npcId: actor,
      subjectKind: 'player',
      origin: 'user',
      purpose: 'narrative',
      requesterUserId: player,
    };
    const prepare = (salt = 'first') =>
      engine.withRuntimeVisionQuote(async () => {
        serialLocked = true;
        try {
          const context = await extendRuntimeMap(
            db,
            current.id,
            state,
            actor,
            baseContext(salt),
            'narrative',
          );
          return await engine.quote(scope, context, player);
        } finally {
          serialLocked = false;
        }
      });
    const walletBefore = (
      await db.query('SELECT balance_subunits,held_subunits FROM spark_wallets WHERE owner_id=$1', [
        player,
      ])
    )[0];
    const quote = await prepare();
    assert.equal(quote.estimateSnapshot.estimatedInputTokens, 1234);
    assert.equal(calls, 1);
    const receipt = (
      await db.query(
        'SELECT * FROM runtime_map_token_counts WHERE actor_id=$1 AND campaign_id=$2',
        [player, current.id],
      )
    )[0];
    assert.equal(receipt.status, 'succeeded');
    assert.equal(
      receipt.provider_fee_micros,
      null,
      'unverified operational fee never becomes a fictional zero invoice',
    );
    assert.equal(receipt.cost_basis, 'unverified_operational');
    assert.equal(String(receipt.input_tokens), '1234');
    assert.equal(receipt.body_sha256, quote.estimateSnapshot.bodySha256);
    assert.equal(
      provider.runtimeCounts.get(receipt.body_sha256).expiresAt,
      new Date(receipt.created_at).getTime() + 600000,
      'fresh cache and durable receipt share the same creation-based expiry',
    );
    assert.deepEqual(
      (
        await db.query(
          'SELECT balance_subunits,held_subunits FROM spark_wallets WHERE owner_id=$1',
          [player],
        )
      )[0],
      walletBefore,
      'a count is not a player charge or hold',
    );
    engine = make();
    const second = await prepare();
    assert.equal(second.estimateSnapshot.fingerprint, quote.estimateSnapshot.fingerprint);
    assert.equal(calls, 1, 'restart hydrates persisted body evidence');
    await db.query(
      "UPDATE runtime_map_token_counts SET created_at=clock_timestamp()-interval '11 minutes' WHERE id=$1",
      [receipt.id],
    );
    engine = make();
    const consentContext = await extendRuntimeMap(
      db,
      current.id,
      state,
      actor,
      baseContext('first'),
      'narrative',
    );
    const queued = await engine.queue({
      scope,
      context: consentContext,
      operationId: randomUUID(),
      quoteId: second.id,
      consent: true,
    });
    assert.equal(
      calls,
      1,
      'valid accepted quote survives count expiry and restart without recount',
    );
    const queuedSnapshot = (
      await db.query('SELECT request_snapshot FROM npc_ai_jobs WHERE id=$1', [queued.id])
    )[0].request_snapshot;
    assert.equal(queuedSnapshot.fingerprint, second.estimateSnapshot.fingerprint);
    await engine.cancel(queued.id);

    uncertain = true;
    await assert.rejects(
      prepare('unknown'),
      (e) => e.getResponse?.().code === 'RUNTIME_MAP_COUNT_UNAVAILABLE',
    );
    assert.equal(calls, 2);
    engine = make();
    await assert.rejects(
      prepare('unknown'),
      (e) => e.getResponse?.().code === 'RUNTIME_MAP_COUNT_UNRESOLVED',
    );
    assert.equal(calls, 2, 'unknown count is never automatically replayed after restart');
    await db.query("UPDATE game_members SET status='revoked' WHERE campaign_id=$1 AND user_id=$2", [
      current.id,
      player,
    ]);
    await assert.rejects(prepare('revoked'), /MAP_VIEW_UNAVAILABLE/);
    assert.equal(calls, 2);
    await db.query(
      "UPDATE game_members SET status='accepted' WHERE campaign_id=$1 AND user_id=$2",
      [current.id, player],
    );
    const gate = await pool.connect();
    await gate.query('BEGIN');
    await gate.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `runtime-map-count:${player}`,
    ]);
    const blocked = prepare('revoke-during-admission');
    const result = blocked.then(
      () => null,
      (error) => error,
    );
    try {
      const deadline = Date.now() + 5000;
      while (
        !(await db.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted")).length
      ) {
        assert.ok(Date.now() < deadline, 'count reached the held actor gate');
        await new Promise((r) => setTimeout(r, 10));
      }
      await db.query(
        "UPDATE game_members SET status='revoked' WHERE campaign_id=$1 AND user_id=$2",
        [current.id, player],
      );
      await gate.query('COMMIT');
      assert.equal((await result).getResponse?.().code, 'FORBIDDEN');
      assert.equal(calls, 2, 'revocation committed during a lock wait prevents count dispatch');
    } finally {
      await gate.query('ROLLBACK');
      gate.release();
    }
    await db.query(
      "UPDATE game_members SET status='accepted' WHERE campaign_id=$1 AND user_id=$2",
      [current.id, player],
    );
    const revisionGate = await pool.connect();
    await revisionGate.query('BEGIN');
    await revisionGate.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `runtime-map-count:${player}`,
    ]);
    const staleResult = prepare('durable-state-changed').then(
      () => null,
      (error) => error,
    );
    try {
      const deadline = Date.now() + 5000;
      while (
        !(await db.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted")).length
      ) {
        assert.ok(Date.now() < deadline, 'count reached gate before durable privacy change');
        await new Promise((r) => setTimeout(r, 10));
      }
      // Account erasure updates durable campaign state/revision outside the hot writer.
      // Remaining members retain access, so authorization alone is insufficient.
      await db.query('UPDATE game_campaigns SET revision=revision+1 WHERE id=$1', [current.id]);
      await revisionGate.query('COMMIT');
      assert.equal((await staleResult).getResponse?.().code, 'RUNTIME_MAP_QUOTE_CHANGED');
      assert.equal(calls, 2, 'a stale hot revision cannot transmit pre-erasure context');
      current.revision = Number(current.revision) + 1;
    } finally {
      await revisionGate.query('ROLLBACK');
      revisionGate.release();
    }
    await db.query(
      "INSERT INTO art_asset_takedowns(revision_id,reason_code) VALUES($1,'rights_issue')",
      [revision],
    );
    // Rebuilding an inaccessible image cannot reuse cached evidence or dispatch a new count.
    const context = await extendRuntimeMap(
      db,
      current.id,
      state,
      actor,
      { contextHash: 'takedown' },
      'narrative',
    );
    assert.equal(context.runtimeMapImage, undefined);
    assert.equal(calls, 2);
  } finally {
    await db.query('UPDATE game_campaigns SET state=$2 WHERE id=$1', [current.id, originalState]);
    config.ASSET_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  }
};
