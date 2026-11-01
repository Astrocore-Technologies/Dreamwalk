/** Real isolated PostgreSQL only. No API, provider, credential source or persistent user data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { exportNpcAiData, purgeNpcAiData } from '../../scripts/npc-ai-data-requests.mjs';
const require = createRequire(import.meta.url);
const {
  exportImageGeneration,
  eraseImageGeneration,
} = require('../../apps/api/dist/image-generation/data-requests.js');
import { db } from './support-runtime.mjs';
import {
  exportManualLiveData,
  purgeManualLiveData,
} from '../../scripts/manual-live-data-requests.mjs';

await test('owner generation export and erasure preserve financial liabilities without retaining erased handles', async (t) => {
  const c = await db.connect();
  await c.query('BEGIN');
  t.after(async () => {
    await c.query('ROLLBACK');
    c.release();
    await db.end();
  });
  const ownerId = randomUUID(),
    otherId = randomUUID(),
    campaignId = randomUUID();
  const ownerHandle = `erase_owner_${randomUUID().slice(0, 8)}`,
    otherHandle = `retained_owner_${randomUUID().slice(0, 8)}`;
  for (const [id, handle] of [
    [ownerId, ownerHandle],
    [otherId, otherHandle],
  ])
    await c.query('INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,$3,$4,$5)', [
      id,
      `${id}@example.test`,
      'synthetic-no-login',
      'Synthetic erasure fixture',
      handle,
    ]);
  await c.query(
    "INSERT INTO game_campaigns(id,owner_id,playable_version,state) VALUES($1,$2,'synthetic-erasure','{}')",
    [campaignId, ownerId],
  );
  const sessions = {
    own: {
      id: randomUUID(),
      scope: `erase-owned-${randomUUID()}`,
      owner: ownerId,
      handle: ownerHandle,
      hash: 'a'.repeat(64),
    },
    manual: {
      id: randomUUID(),
      scope: `erase-manual-${randomUUID()}`,
      owner: ownerId,
      handle: null,
      hash: null,
    },
    affectedOther: {
      id: randomUUID(),
      scope: `erase-affected-${randomUUID()}`,
      owner: otherId,
      handle: otherHandle,
      hash: 'b'.repeat(64),
    },
    unrelatedOther: {
      id: randomUUID(),
      scope: `erase-unrelated-${randomUUID()}`,
      owner: otherId,
      handle: otherHandle,
      hash: 'c'.repeat(64),
    },
  };
  for (const [kind, s] of Object.entries(sessions)) {
    await c.query(
      'INSERT INTO generation_budget_scopes(id,approved,total_cap_micros,text_cap_micros,image_cap_micros,blocked) VALUES($1,true,1000000,700000,600000,true)',
      [s.scope],
    );
    if (kind === 'manual')
      await c.query(
        "INSERT INTO live_test_sessions(id,owner_id,scope_id,expires_at,cap_micros,state) VALUES($1,$2,$3,now()+interval '1 hour',1000000,'active')",
        [s.id, s.owner, s.scope],
      );
    else
      await c.query(
        "INSERT INTO live_test_sessions(id,owner_id,scope_id,mode,owner_handle,config_hash,expires_at,cap_micros,text_cap_micros,image_cap_micros,state,stop_code) VALUES($1,$2,$3,'owner',$4,$5,NULL,900000,700000,600000,'stopped','GENERATION_UNKNOWN_COST')",
        [s.id, s.owner, s.scope, s.handle, s.hash],
      );
  }
  const reservationIds = [];
  for (const s of [sessions.own, sessions.affectedOther]) {
    for (const [kind, status, upper, actual] of [
      ['image', 'held', 120000, null],
      ['text', 'settled', 80000, 65000],
    ]) {
      const id = randomUUID();
      reservationIds.push(id);
      await c.query(
        'INSERT INTO generation_budget_reservations(id,scope_id,actor_id,kind,operation_key,upper_micros,actual_micros,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, s.scope, s.owner, kind, randomUUID(), upper, actual, status],
      );
    }
  }
  // This other owner's permit makes its authorization an affected dependency. Its
  // handle must remain intact even though existing erasure semantics stop it.
  const requestId = randomUUID(),
    permitId = randomUUID(),
    permitReservation = randomUUID();
  await c.query(
    "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,context,status) VALUES($1,$2,'synthetic-npc','plan',$3,'{}','queued')",
    [requestId, campaignId, randomUUID()],
  );
  await c.query(
    "INSERT INTO generation_budget_reservations(id,scope_id,actor_id,kind,operation_key,upper_micros,actual_micros,status) VALUES($1,$2,$3,'text',$4,45000,NULL,'held')",
    [permitReservation, sessions.affectedOther.scope, otherId, randomUUID()],
  );
  reservationIds.push(permitReservation);
  await c.query(
    "INSERT INTO live_test_text_permits(id,session_id,campaign_id,request_id,operation_id,context_hash,round_id,phase_epoch,reservation_id,state,dispatched_at) VALUES($1,$2,$3,$4,$5,'private-context','private-round',2,$6,'unknown',now())",
    [permitId, sessions.affectedOther.id, campaignId, requestId, randomUUID(), permitReservation],
  );
  // New financial-history snapshots deliberately omit account identity and private
  // request data. These explicit synthetic acknowledgements roll back with the test.
  for (const session of [sessions.own, sessions.affectedOther, sessions.unrelatedOther])
    await c.query(
      `INSERT INTO generation_policy_revisions(id,authorization_id,scope_id,revision,profile_hash,
      config_fingerprint,previous_hash,profile_snapshot,operation_id,request_hash)
      VALUES($1,$2,$3,1,$4,$4,NULL,$5,$6,$4)`,
      [
        randomUUID(),
        session.id,
        session.scope,
        session.hash,
        JSON.stringify({
          totalCapMicros: 900000,
          text: { model: 'synthetic-history-text' },
          image: { model: 'synthetic-history-image' },
        }),
        randomUUID(),
      ],
    );

  const textSnapshot = (label) => {
    const bodySha256 = createHash('sha256').update(label).digest('hex');
    return {
      schemaVersion: 1,
      id: `text-estimate-v1:${bodySha256}`,
      fingerprint: bodySha256,
      bodySha256,
      costBasis: 'operator_estimate',
      providerEnforcesQuotedCap: false,
      serializedBytes: Buffer.byteLength(label),
      model: 'synthetic-private-input-text',
      inputMicrosPerMillion: 500000,
      outputMicrosPerMillion: 2000000,
      estimatedTotalMicros: 10000,
      reserveMicros: 15000,
      inputMicros: 2000,
      outputMicros: 8000,
      marginBps: 2500,
      percentageMarginMicros: 2500,
      fixedMarginMicros: 2500,
      pricing: {
        source: 'https://pricing.example.test/text',
        reviewedAt: '2026-11-01T00:00:00Z',
        validUntil: '2030-01-01T00:00:00Z',
      },
    };
  };
  const snapshotFixtures = {
    permit: textSnapshot('SYNTHETIC_PRIVATE_AFFECTED_PERMIT'),
    authoringOwn: textSnapshot('SYNTHETIC_PRIVATE_OWN_AUTHORING'),
    authoringOther: textSnapshot('SYNTHETIC_PRIVATE_OTHER_AUTHORING'),
    npcOwn: textSnapshot('SYNTHETIC_PRIVATE_OWN_NPC'),
    npcOther: textSnapshot('SYNTHETIC_PRIVATE_OTHER_NPC'),
  };
  await c.query(
    'UPDATE live_test_text_permits SET request_snapshot=$2,generation_policy_revision=1,generation_policy_hash=$3 WHERE id=$1',
    [permitId, JSON.stringify(snapshotFixtures.permit), sessions.affectedOther.hash],
  );
  const authoringFixtures = [];
  for (const [actor, session, snapshot] of [
    [ownerId, sessions.own, snapshotFixtures.authoringOwn],
    [otherId, sessions.unrelatedOther, snapshotFixtures.authoringOther],
  ]) {
    const quoteId = randomUUID(),
      jobId = randomUUID(),
      reservationId = randomUUID();
    reservationIds.push(reservationId);
    await c.query(
      "INSERT INTO generation_budget_reservations(id,scope_id,actor_id,kind,operation_key,upper_micros,status) VALUES($1,$2,$3,'text',$4,15000,'held')",
      [reservationId, session.scope, actor, randomUUID()],
    );
    await c.query(
      `INSERT INTO live_authoring_text_quotes(id,actor_id,session_id,operation_id,request_hash,project_revision,source_hash,readset_hash,context_hash,context,provider_version,upper_micros,expires_at,request_snapshot,generation_policy_revision,generation_policy_hash)
       VALUES($1,$2,$3,$4,'private-request',1,'private-source','private-readset','private-context','{"private":"synthetic"}','synthetic-provider',15000,now()+interval '1 hour',$5,1,$6)`,
      [quoteId, actor, session.id, randomUUID(), JSON.stringify(snapshot), session.hash],
    );
    await c.query(
      `INSERT INTO live_authoring_text_jobs(id,actor_id,session_id,operation_id,quote_id,request_hash,project_revision,source_hash,readset_hash,context_hash,context,provider_version,reservation_id,status,dispatched_at,request_snapshot,generation_policy_revision,generation_policy_hash)
       VALUES($1,$2,$3,$4,$5,'private-request',1,'private-source','private-readset','private-context','{"private":"synthetic"}','synthetic-provider',$6,'unknown',now(),$7,1,$8)`,
      [
        jobId,
        actor,
        session.id,
        randomUUID(),
        quoteId,
        reservationId,
        JSON.stringify(snapshot),
        session.hash,
      ],
    );
    authoringFixtures.push({ actor, session, snapshot, quoteId, jobId, reservationId });
  }
  const otherCampaignId = randomUUID();
  await c.query(
    "INSERT INTO game_campaigns(id,owner_id,playable_version,state) VALUES($1,$2,'synthetic-unrelated-erasure','{}')",
    [otherCampaignId, otherId],
  );
  const npcFixtures = [];
  for (const [actor, payer, campaign, snapshot] of [
    [ownerId, otherId, campaignId, snapshotFixtures.npcOwn],
    [otherId, otherId, otherCampaignId, snapshotFixtures.npcOther],
  ]) {
    const quoteId = randomUUID(),
      jobId = randomUUID();
    await c.query(
      `INSERT INTO npc_ai_quotes(id,campaign_id,npc_id,user_id,context_hash,purpose,provider_id,policy_version,credits,upper_micros,expires_at,request_snapshot)
       VALUES($1,$2,'synthetic-private-npc',$3,'private-context','plan','synthetic-provider','synthetic-policy',0,15000,now()+interval '1 hour',$4)`,
      [quoteId, campaign, actor, JSON.stringify(snapshot)],
    );
    await c.query(
      `INSERT INTO npc_ai_jobs(id,campaign_id,npc_id,operation_id,request_hash,quote_id,origin,requester_user_id,payer_user_id,purpose,context_hash,context,provider_id,provider_version,policy_version,status,credits,reservation_status,reservation_expires_at,provider_upper_micros,provider_actual_micros,provider_budget_status,request_snapshot)
       VALUES($1,$2,'synthetic-private-npc',$3,'private-request',$4,'user',$5,$6,'plan','private-context','{"private":"synthetic"}','synthetic-provider','synthetic-provider','synthetic-policy','committed',0,'captured',now()+interval '1 hour',15000,7000,'spent',$7)`,
      [jobId, campaign, randomUUID(), quoteId, actor, payer, JSON.stringify(snapshot)],
    );
    npcFixtures.push({ actor, payer, campaign, quoteId, jobId, snapshot });
  }
  const pricingSnapshot = {
    schemaVersion: 1,
    id: 'synthetic-public-pricing',
    fingerprint: 'f'.repeat(64),
    model: 'synthetic-cost-evidence-image',
    inputTextMicrosPerMillion: 5000000,
    inputImageMicrosPerMillion: 8000000,
    outputImageMicrosPerMillion: 30000000,
    pricing: {
      source: 'https://pricing.example.test/image',
      reviewedAt: '2026-11-01T00:00:00Z',
      validUntil: '2030-01-01T00:00:00Z',
    },
    providerEnforcesQuotedCap: false,
  };
  const imageFixtures = [];
  for (const [actor, session, reservationId] of [
    [ownerId, sessions.own, reservationIds[0]],
    [otherId, sessions.affectedOther, reservationIds[2]],
  ]) {
    const adventureId = randomUUID(),
      quoteId = randomUUID(),
      jobId = randomUUID();
    const promptSha256 = createHash('sha256')
      .update(`SYNTHETIC_PRIVATE_IMAGE_${actor}`)
      .digest('hex');
    const snapshot = {
      schemaVersion: 1,
      id: `image-estimate-v1:${promptSha256}`,
      fingerprint: promptSha256,
      promptSha256,
      promptUtf8Bytes: 48,
      referenceCount: 0,
      basis: 'operator_heuristic',
      costBasis: 'operator_estimate',
      estimatedTotalMicros: 80000,
      reserveMicros: 120000,
      percentageMarginMicros: 20000,
      fixedMarginMicros: 5000,
      referenceAllowanceMicros: 15000,
      model: pricingSnapshot.model,
      pricingProfileId: pricingSnapshot.id,
      pricingProfileHash: pricingSnapshot.fingerprint,
      providerEnforcesQuotedCap: false,
    };
    await c.query(
      "INSERT INTO adventures(id,owner_id,slug,title,genre,data) VALUES($1,$2,$3,'Synthetic image erasure','mystery','{}')",
      [adventureId, actor, `synthetic-image-erasure-${adventureId}`],
    );
    await c.query(
      `INSERT INTO image_generation_quotes(id,actor_id,adventure_id,request_hash,input,reference_hashes,mode,policy_version,upper_micros,expires_at,cost_basis,estimated_total_micros,estimate_snapshot,pricing_profile_snapshot,generation_policy_revision,generation_policy_hash)
       VALUES($1,$2,$3,'private-request','{"prompt":"synthetic-private"}','[]','external','synthetic-policy',NULL,now()+interval '1 hour','approved_estimate',80000,$4,$5,1,$6)`,
      [
        quoteId,
        actor,
        adventureId,
        JSON.stringify(snapshot),
        JSON.stringify(pricingSnapshot),
        session.hash,
      ],
    );
    await c.query(
      `INSERT INTO image_generation_jobs(id,actor_id,adventure_id,operation_id,quote_id,request_hash,input,reference_hashes,mode,policy_version,status,reservation_id,upper_micros,expires_at,upload_id,family_id,revision_id,cost_basis,estimated_total_micros,estimate_snapshot,pricing_profile_snapshot,generation_policy_revision,generation_policy_hash)
       VALUES($1,$2,$3,$4,$5,'private-request','{"prompt":"synthetic-private"}','[]','external','synthetic-policy','unknown',$6,120000,now()+interval '1 hour',$7,$8,$9,'approved_estimate',80000,$10,$11,1,$12)`,
      [
        jobId,
        actor,
        adventureId,
        randomUUID(),
        quoteId,
        reservationId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        JSON.stringify(snapshot),
        JSON.stringify(pricingSnapshot),
        session.hash,
      ],
    );
    imageFixtures.push({ actor, quoteId, jobId, snapshot, pricingSnapshot });
  }
  const redactedSnapshot = (snapshot, key) => {
    const safe = { ...snapshot };
    delete safe[key];
    delete safe.id;
    delete safe.fingerprint;
    return { ...safe, privateInputErased: true };
  };

  const rows = async (sql, values = []) => (await c.query(sql, values)).rows;
  const beforePolicyHistory = await rows(
    'SELECT * FROM generation_policy_revisions WHERE authorization_id=ANY($1::uuid[]) ORDER BY authorization_id,revision',
    [Object.values(sessions).map((session) => session.id)],
  );
  const beforeSessions = await rows(
    'SELECT * FROM live_test_sessions WHERE id=ANY($1::uuid[]) ORDER BY id',
    [Object.values(sessions).map((s) => s.id)],
  );
  const beforeReservations = await rows(
    'SELECT * FROM generation_budget_reservations WHERE id=ANY($1::uuid[]) ORDER BY id',
    [reservationIds],
  );
  const beforeScopes = await rows(
    'SELECT * FROM generation_budget_scopes WHERE id=ANY($1::text[]) ORDER BY id',
    [Object.values(sessions).map((s) => s.scope)],
  );

  await t.test(
    'request exports include only owned evidence and hide foreign requester hashes from payer-only records',
    async () => {
      const own = await exportManualLiveData(c, ownerId);
      const other = await exportManualLiveData(c, otherId);
      assert.deepEqual(own.authoring[0].request_snapshot, snapshotFixtures.authoringOwn);
      assert.deepEqual(own.authoringQuotes[0].request_snapshot, snapshotFixtures.authoringOwn);
      assert.equal(own.authoring[0].generation_policy_revision, 1);
      assert.equal(own.authoring[0].generation_policy_hash, sessions.own.hash);
      assert.deepEqual(other.permits[0].request_snapshot, snapshotFixtures.permit);
      assert.ok(!JSON.stringify(own).includes(snapshotFixtures.authoringOther.bodySha256));
      assert.ok(!JSON.stringify(other).includes(snapshotFixtures.authoringOwn.bodySha256));
      const ownImages = await exportImageGeneration(c, ownerId);
      assert.deepEqual(ownImages.jobs[0].estimate_snapshot, imageFixtures[0].snapshot);
      assert.deepEqual(ownImages.quotes[0].pricing_profile_snapshot, pricingSnapshot);
      assert.equal(ownImages.jobs[0].generation_policy_hash, sessions.own.hash);
      assert.ok(!JSON.stringify(ownImages).includes(imageFixtures[1].snapshot.promptSha256));
      const ownNpc = await exportNpcAiData(c, ownerId);
      const otherNpc = await exportNpcAiData(c, otherId);
      assert.deepEqual(ownNpc[0].request_snapshot, snapshotFixtures.npcOwn);
      const payerOnly = otherNpc.find((job) => job.id === npcFixtures[0].jobId);
      assert.equal(payerOnly.request_snapshot.privateInputRedacted, true);
      assert.equal(payerOnly.request_snapshot.bodySha256, undefined);
      assert.equal(payerOnly.request_snapshot.fingerprint, undefined);
      assert.equal(payerOnly.request_snapshot.model, snapshotFixtures.npcOwn.model);
      assert.ok(!JSON.stringify(otherNpc).includes(snapshotFixtures.npcOwn.bodySha256));
      assert.ok(!JSON.stringify(ownNpc).includes(snapshotFixtures.npcOther.bodySha256));
    },
  );

  await t.test(
    'export includes only the requesting owner mode, own handle, immutable hash, purpose caps and nullable expiry',
    async () => {
      const result = await exportManualLiveData(c, ownerId);
      assert.deepEqual(
        result.sessions.map((s) => s.id).sort(),
        [sessions.own.id, sessions.manual.id].sort(),
      );
      const own = result.sessions.find((s) => s.id === sessions.own.id),
        manual = result.sessions.find((s) => s.id === sessions.manual.id);
      assert.equal(own.mode, 'owner');
      assert.equal(own.owner_handle, ownerHandle);
      assert.equal(own.config_hash, sessions.own.hash);
      assert.equal(own.expires_at, null);
      assert.equal(Number(own.cap_micros), 900000);
      assert.equal(Number(own.text_cap_micros), 700000);
      assert.equal(Number(own.image_cap_micros), 600000);
      assert.equal(manual.mode, 'manual');
      assert.equal(manual.owner_handle, null);
      assert.equal(manual.config_hash, null);
      assert.ok(manual.expires_at instanceof Date);
      assert.equal(manual.text_cap_micros, null);
      assert.equal(manual.image_cap_micros, null);
      assert.ok(!JSON.stringify(result).includes(otherHandle));
      const other = await exportManualLiveData(c, otherId);
      assert.equal(other.sessions.length, 2);
      assert.ok(other.sessions.every((s) => s.owner_handle === otherHandle));
      assert.ok(!JSON.stringify(other).includes(ownerHandle));
      assert.deepEqual(
        result.policyRevisions.map((revision) => revision.authorization_id),
        [sessions.own.id],
      );
      assert.equal(other.policyRevisions.length, 2);
      assert.ok(
        other.policyRevisions.every((revision) => revision.authorization_id !== sessions.own.id),
      );
      assert.ok(!JSON.stringify(result.policyRevisions).includes(ownerHandle));
      assert.ok(!JSON.stringify(other.policyRevisions).includes(otherHandle));
    },
  );
  await t.test(
    'erasure tombstones only the erased owner handle and leaves another affected owner identity intact',
    async () => {
      await purgeManualLiveData(c, ownerId, [{ id: campaignId }]);
      assert.deepEqual(
        await rows(
          'SELECT * FROM generation_policy_revisions WHERE authorization_id=ANY($1::uuid[]) ORDER BY authorization_id,revision',
          [Object.values(sessions).map((session) => session.id)],
        ),
        beforePolicyHistory,
      );
      const after = await rows(
        'SELECT * FROM live_test_sessions WHERE id=ANY($1::uuid[]) ORDER BY id',
        [Object.values(sessions).map((s) => s.id)],
      );
      for (const row of after) {
        const before = beforeSessions.find((s) => s.id === row.id);
        if (row.id === sessions.unrelatedOther.id) {
          assert.deepEqual(row, before);
          continue;
        }
        const { state, stop_code, owner_handle, ...financial } = row;
        const {
          state: _oldState,
          stop_code: _oldStop,
          owner_handle: _oldHandle,
          ...beforeFinancial
        } = before;
        assert.deepEqual(financial, beforeFinancial);
        assert.equal(state, 'stopped');
        assert.equal(stop_code, 'DATA_ERASED');
        assert.equal(
          owner_handle,
          row.id === sessions.own.id
            ? 'erased'
            : row.id === sessions.manual.id
              ? null
              : otherHandle,
        );
      }
      const own = await exportManualLiveData(c, ownerId);
      assert.ok(!JSON.stringify(own).includes(ownerHandle));
      assert.equal(own.sessions.find((s) => s.mode === 'owner').owner_handle, 'erased');
      assert.equal(
        (await exportManualLiveData(c, otherId)).sessions.find(
          (s) => s.id === sessions.affectedOther.id,
        ).owner_handle,
        otherHandle,
      );
    },
  );

  await t.test(
    'manual text erasure removes only private-input snapshot hashes and keeps pricing, byte counts and unknown reserves',
    async () => {
      const permit = (
        await rows('SELECT request_snapshot FROM live_test_text_permits WHERE id=$1', [permitId])
      )[0];
      assert.deepEqual(
        permit.request_snapshot,
        redactedSnapshot(snapshotFixtures.permit, 'bodySha256'),
      );
      const owned = authoringFixtures[0],
        unrelated = authoringFixtures[1];
      for (const table of ['live_authoring_text_quotes', 'live_authoring_text_jobs']) {
        const id = table.endsWith('quotes') ? owned.quoteId : owned.jobId;
        const row = (
          await rows(
            `SELECT request_snapshot,generation_policy_revision,generation_policy_hash FROM ${table} WHERE id=$1`,
            [id],
          )
        )[0];
        assert.deepEqual(row.request_snapshot, redactedSnapshot(owned.snapshot, 'bodySha256'));
        assert.equal(row.generation_policy_revision, 1);
        assert.equal(row.generation_policy_hash, sessions.own.hash);
        const otherId = table.endsWith('quotes') ? unrelated.quoteId : unrelated.jobId;
        assert.deepEqual(
          (await rows(`SELECT request_snapshot FROM ${table} WHERE id=$1`, [otherId]))[0]
            .request_snapshot,
          unrelated.snapshot,
        );
      }
    },
  );
  await t.test(
    'NPC erasure removes affected private linkage while preserving costs and unrelated requester evidence',
    async () => {
      const financial = 'id,provider_upper_micros,provider_actual_micros,provider_budget_status';
      const before = await rows(`SELECT ${financial} FROM npc_ai_jobs WHERE id=$1`, [
        npcFixtures[0].jobId,
      ]);
      const unrelated = await rows('SELECT * FROM npc_ai_jobs WHERE id=$1', [npcFixtures[1].jobId]);
      await purgeNpcAiData(c, ownerId, [{ id: campaignId }]);
      assert.deepEqual(
        await rows(`SELECT ${financial} FROM npc_ai_jobs WHERE id=$1`, [npcFixtures[0].jobId]),
        before,
      );
      assert.deepEqual(
        (
          await rows('SELECT request_snapshot FROM npc_ai_jobs WHERE id=$1', [npcFixtures[0].jobId])
        )[0].request_snapshot,
        redactedSnapshot(snapshotFixtures.npcOwn, 'bodySha256'),
      );
      assert.deepEqual(
        await rows('SELECT * FROM npc_ai_jobs WHERE id=$1', [npcFixtures[1].jobId]),
        unrelated,
      );
      assert.deepEqual(
        await rows('SELECT * FROM npc_ai_quotes WHERE id=$1', [npcFixtures[0].quoteId]),
        [],
      );
      assert.deepEqual(
        (
          await rows('SELECT request_snapshot FROM npc_ai_quotes WHERE id=$1', [
            npcFixtures[1].quoteId,
          ])
        )[0].request_snapshot,
        snapshotFixtures.npcOther,
      );
    },
  );
  await t.test(
    'confirmed image erasure preserves pricing and financial receipts, with no foreign-owner changes',
    async () => {
      await c.query('SAVEPOINT snapshot_image_erasure');
      try {
        const own = imageFixtures[0],
          foreign = imageFixtures[1];
        const otherBefore = await rows('SELECT * FROM image_generation_jobs WHERE id=$1', [
          foreign.jobId,
        ]);
        const financial =
          'id,reservation_id,upper_micros,actual_micros,cost_basis,estimated_total_micros,status,generation_policy_revision,generation_policy_hash';
        const before = await rows(`SELECT ${financial} FROM image_generation_jobs WHERE id=$1`, [
          own.jobId,
        ]);
        await assert.rejects(() => eraseImageGeneration(c, ownerId), /CONFIRMED_ERASURE_REQUIRED/);
        await c.query("SET LOCAL dreamwalk.erasure='confirmed'");
        await c.query('UPDATE users SET deleted_at=now() WHERE id=$1', [ownerId]);
        await eraseImageGeneration(c, ownerId);
        for (const table of ['image_generation_quotes', 'image_generation_jobs']) {
          const id = table.endsWith('quotes') ? own.quoteId : own.jobId;
          const row = (
            await rows(
              `SELECT estimate_snapshot,pricing_profile_snapshot FROM ${table} WHERE id=$1`,
              [id],
            )
          )[0];
          assert.deepEqual(row.estimate_snapshot, redactedSnapshot(own.snapshot, 'promptSha256'));
          assert.deepEqual(row.pricing_profile_snapshot, pricingSnapshot);
        }
        assert.deepEqual(
          await rows(`SELECT ${financial} FROM image_generation_jobs WHERE id=$1`, [own.jobId]),
          before,
        );
        assert.deepEqual(
          await rows('SELECT * FROM image_generation_jobs WHERE id=$1', [foreign.jobId]),
          otherBefore,
        );
        assert.deepEqual(
          await rows(
            'SELECT * FROM generation_policy_revisions WHERE authorization_id=ANY($1::uuid[]) ORDER BY authorization_id,revision',
            [Object.values(sessions).map((session) => session.id)],
          ),
          beforePolicyHistory,
        );
      } finally {
        await c.query('ROLLBACK TO SAVEPOINT snapshot_image_erasure');
        await c.query('RELEASE SAVEPOINT snapshot_image_erasure');
      }
    },
  );

  await t.test(
    'held unknown costs, actual spend, scope blocks and all financial IDs/caps remain unchanged',
    async () => {
      assert.deepEqual(
        await rows(
          'SELECT * FROM generation_budget_reservations WHERE id=ANY($1::uuid[]) ORDER BY id',
          [reservationIds],
        ),
        beforeReservations,
      );
      assert.deepEqual(
        await rows('SELECT * FROM generation_budget_scopes WHERE id=ANY($1::text[]) ORDER BY id', [
          Object.values(sessions).map((s) => s.scope),
        ]),
        beforeScopes,
      );
      const permit = (
        await rows('SELECT * FROM live_test_text_permits WHERE id=$1', [permitId])
      )[0];
      assert.equal(permit.state, 'unknown');
      assert.equal(permit.reservation_id, permitReservation);
      assert.equal(permit.request_id, null);
      assert.equal(permit.context_hash, 'erased');
      assert.equal(permit.round_id, 'erased');
      assert.equal(permit.result_code, 'DATA_ERASED');
    },
  );
  await t.test(
    'repeated erasure is idempotent and still cannot erase the other owner handle',
    async () => {
      const before = await rows(
        'SELECT * FROM live_test_sessions WHERE id=ANY($1::uuid[]) ORDER BY id',
        [Object.values(sessions).map((s) => s.id)],
      );
      await purgeManualLiveData(c, ownerId, [{ id: campaignId }]);
      assert.deepEqual(
        await rows(
          'SELECT * FROM generation_policy_revisions WHERE authorization_id=ANY($1::uuid[]) ORDER BY authorization_id,revision',
          [Object.values(sessions).map((session) => session.id)],
        ),
        beforePolicyHistory,
      );
      assert.deepEqual(
        await rows('SELECT * FROM live_test_sessions WHERE id=ANY($1::uuid[]) ORDER BY id', [
          Object.values(sessions).map((s) => s.id),
        ]),
        before,
      );
      assert.deepEqual(
        await rows(
          'SELECT * FROM generation_budget_reservations WHERE id=ANY($1::uuid[]) ORDER BY id',
          [reservationIds],
        ),
        beforeReservations,
      );
    },
  );
});
