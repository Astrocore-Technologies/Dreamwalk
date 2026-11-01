/** Disposable PostgreSQL proof of manual-world expiry recovery. No provider is constructed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db } from './support-runtime.mjs';
const require = createRequire(import.meta.url);
const { LiveTestService } = require('../../apps/api/dist/live-test/service.js');

await test('expired manual-world recovery protects consent, jobs and financial evidence', async (t) => {
  const ownerId = randomUUID(),
    campaignId = randomUUID(),
    sessionId = randomUUID();
  const scopeId = `manual-expiry-fixture-${randomUUID()}`;
  const configuration = {
    enabled: true,
    ownerId,
    sessionId,
    expiresAt: new Date(Date.now() + 3600000),
  };
  const service = new LiveTestService({}, configuration);
  async function transaction(work) {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const result = await work(c);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  }
  async function request() {
    const id = randomUUID();
    await db.query(
      "INSERT INTO game_npc_decision_requests(id,campaign_id,npc_id,purpose,cause_key,context,status) VALUES($1,$2,$3,'plan',$4,'{}','queued')",
      [id, campaignId, `npc-${id}`, id],
    );
    return id;
  }
  const reject = (id) =>
    transaction((c) =>
      service.rejectUndispatchedRequest(c, id, 'MANUAL_AUTHORIZATION_UNAVAILABLE'),
    );
  async function reservation(c, requestId) {
    const id = randomUUID();
    await c.query(
      "INSERT INTO generation_budget_reservations(id,scope_id,actor_id,kind,operation_key,upper_micros,status) VALUES($1,$2,$3,'text',$4,100,'held')",
      [id, scopeId, ownerId, `manual-text:${requestId}`],
    );
    return id;
  }
  try {
    await db.query('INSERT INTO users(id,email,password_hash,name,handle) VALUES($1,$2,$3,$4,$5)', [
      ownerId,
      `${ownerId}@example.test`,
      'synthetic-no-login',
      'Expiry fixture',
      `expiry_${ownerId}`,
    ]);
    await db.query(
      "INSERT INTO game_campaigns(id,owner_id,playable_version,state) VALUES($1,$2,'synthetic','{}')",
      [campaignId, ownerId],
    );
    await db.query(
      'INSERT INTO generation_budget_scopes(id,approved,total_cap_micros,image_cap_micros,text_cap_micros) VALUES($1,true,1000000,1000000,1000000)',
      [scopeId],
    );
    await db.query(
      "INSERT INTO live_test_sessions(id,owner_id,scope_id,expires_at,cap_micros,state) VALUES($1,$2,$3,$4,1000000,'active')",
      [sessionId, ownerId, scopeId, configuration.expiresAt],
    );

    await t.test(
      'active no-permit request remains available for explicit owner consent',
      async () => {
        const id = await request();
        assert.equal(await reject(id), false);
        assert.equal(
          (await db.query('SELECT status FROM game_npc_decision_requests WHERE id=$1', [id]))
            .rows[0].status,
          'queued',
        );
      },
    );
    await t.test(
      'expired stored grant allows terminal handling without a permit or any ledger writes',
      async () => {
        await db.query(
          "UPDATE live_test_sessions SET expires_at=now()-interval '1 minute' WHERE id=$1",
          [sessionId],
        );
        assert.equal(await reject(await request()), true);
        assert.equal(
          Number(
            (
              await db.query(
                'SELECT count(*) n FROM generation_budget_reservations WHERE scope_id=$1',
                [scopeId],
              )
            ).rows[0].n,
          ),
          0,
        );
      },
    );
    await t.test('stopped grant allows the same safe zero-cost terminal handling', async () => {
      await db.query("UPDATE live_test_sessions SET state='stopped',expires_at=$2 WHERE id=$1", [
        sessionId,
        configuration.expiresAt,
      ]);
      assert.equal(await reject(await request()), true);
    });
    await t.test(
      'a linked or in-flight job is protected even without a manual permit',
      async () => {
        for (const status of ['reserved', 'running', 'reconciling']) {
          const id = await request(),
            jobId = randomUUID();
          await db.query(
            `INSERT INTO npc_ai_jobs(id,campaign_id,npc_id,operation_id,request_hash,request_meta,origin,purpose,context_hash,context,provider_id,provider_version,policy_version,status,reservation_expires_at,provider_budget_status,provider_upper_micros)
           VALUES($1,$2,$3,$4,'fixture',$5,'system','plan','fixture','{}','synthetic','1','fixture',$6,now()+interval '1 hour','unknown',100)`,
            [jobId, campaignId, `npc-${id}`, id, JSON.stringify({ runtimeRequestId: id }), status],
          );
          assert.equal(await reject(id), false);
          const after = (
            await db.query(
              'SELECT status,provider_budget_status,provider_upper_micros FROM npc_ai_jobs WHERE id=$1',
              [jobId],
            )
          ).rows[0];
          assert.equal(after.status, status);
          assert.equal(after.provider_budget_status, 'unknown');
          assert.equal(Number(after.provider_upper_micros), 100);
        }
      },
    );
    await t.test(
      'orphaned ledger evidence is not mistaken for a free unapproved request',
      async () => {
        const id = await request(),
          held = await transaction((c) => reservation(c, id));
        assert.equal(await reject(id), false);
        assert.equal(
          (await db.query('SELECT status FROM generation_budget_reservations WHERE id=$1', [held]))
            .rows[0].status,
          'held',
        );
      },
    );
    await t.test(
      'consent committed while waiting for the session lock is observed and protected',
      async () => {
        const id = await request(),
          permitId = randomUUID(),
          writer = await db.connect(),
          reader = await db.connect();
        let finishInitialRead;
        const initialRead = new Promise((resolve) => {
          finishInitialRead = resolve;
        });
        let pending;
        try {
          await writer.query('BEGIN');
          await writer.query('SELECT id FROM live_test_sessions WHERE id=$1 FOR UPDATE', [
            sessionId,
          ]);
          const held = await reservation(writer, id);
          await writer.query(
            "INSERT INTO live_test_text_permits(id,session_id,campaign_id,request_id,operation_id,context_hash,round_id,phase_epoch,reservation_id,state) VALUES($1,$2,$3,$4,$5,'fixture','round-1',2,$6,'authorized')",
            [permitId, sessionId, campaignId, id, randomUUID(), held],
          );
          await reader.query('BEGIN');
          pending = service.rejectUndispatchedRequest(
            {
              query: async (sql, params) => {
                const result = await reader.query(sql, params);
                if (sql.startsWith('SELECT session_id FROM live_test_text_permits'))
                  finishInitialRead();
                return result;
              },
            },
            id,
            'MANUAL_AUTHORIZATION_UNAVAILABLE',
          );
          await initialRead;
          await writer.query('COMMIT');
          assert.equal(await pending, false);
          await reader.query('COMMIT');
          assert.equal(
            (await db.query('SELECT state FROM live_test_text_permits WHERE id=$1', [permitId]))
              .rows[0].state,
            'authorized',
          );
          assert.equal(
            (
              await db.query('SELECT status FROM generation_budget_reservations WHERE id=$1', [
                held,
              ])
            ).rows[0].status,
            'held',
          );
        } finally {
          await writer.query('ROLLBACK');
          if (pending) await pending.catch(() => {});
          await reader.query('ROLLBACK');
          writer.release();
          reader.release();
        }
      },
    );
  } finally {
    await db.end();
  }
});
