/** Real isolated PostgreSQL only. No API, provider, credential source or persistent user data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  const rows = async (sql, values = []) => (await c.query(sql, values)).rows;
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
    },
  );
  await t.test(
    'erasure tombstones only the erased owner handle and leaves another affected owner identity intact',
    async () => {
      await purgeManualLiveData(c, ownerId, [{ id: campaignId }]);
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
