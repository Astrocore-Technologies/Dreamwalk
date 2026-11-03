/** Built-in zero-cost simulation stays usable for a newly funded account; paid guards stay closed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db, startApi, stopApi, client } from './support-runtime.mjs';
const require = createRequire(import.meta.url);
const { Db } = require('../../apps/api/dist/db.js');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service.js');
const { MockNpcProvider } = require('../../apps/api/dist/ai/provider.js');
test('new 50-Dream account runs free built-in mock without fake paid consent; wrappers remain unverified', async () => {
  const database = new Db();
  try {
    await startApi();
    const user = await client().register();
    const { campaignId } = await user.request('/game/campaigns', { template: 'observatory-v1' });
    await stopApi();
    const scope = {
      campaignId,
      npcId: 'keeper',
      origin: 'user',
      requesterUserId: user.user.id,
      purpose: 'plan',
    };
    const context = { contextHash: randomUUID(), mockProposal: { actions: [{ kind: 'wait' }] } };
    const mock = new MockNpcProvider();
    const engine = new NpcAiEngine(database, mock);
    const quote = await engine.quote(scope, context, user.user.id);
    assert.equal(quote.credits, 0);
    assert.equal(quote.requiresConsent, false);
    // Ordinary free simulation did not previously require a separately authorized paid quote.
    const job = await engine.queue({ scope, context, operationId: randomUUID() });
    await engine.run(job.id, async () => true);
    const saved = (
      await db.query('SELECT status,spark_hold_id FROM npc_ai_jobs WHERE id=$1', [job.id])
    ).rows[0];
    assert.equal(saved.status, 'result_received');
    assert.equal(saved.spark_hold_id, null);
    const wallet = (
      await db.query(
        'SELECT enabled,balance_subunits,held_subunits FROM spark_wallets WHERE owner_id=$1',
        [user.user.id],
      )
    ).rows[0];
    assert.deepEqual(wallet, { enabled: true, balance_subunits: '0', held_subunits: '0' });
    assert.equal(
      (
        await db.query('SELECT balance_subunits FROM dream_wallets WHERE owner_id=$1', [
          user.user.id,
        ])
      ).rows[0].balance_subunits,
      '500000',
    );
    const providers = [
      {
        id: 'fake-free-wrapper',
        version: 'v1',
        external: false,
        generate: mock.generate.bind(mock),
      },
      new MockNpcProvider({ costMicros: 1 }),
      new (class extends MockNpcProvider {})(),
    ];
    for (const provider of providers) {
      const guarded = new NpcAiEngine(database, provider, {
        providerUpperMicros:
          provider instanceof MockNpcProvider && !provider.isFreeSimulation() ? 1 : 0,
        providerCapMicros: 10,
      });
      await assert.rejects(
        guarded.quote(scope, context, user.user.id),
        (e) => e?.getResponse?.().code === 'SPARK_PRICE_UNVERIFIED',
      );
    }
    for (const policy of [{ creditPrice: 1 }, { providerUpperMicros: 1 }]) {
      const guarded = new NpcAiEngine(database, new MockNpcProvider(), policy);
      await assert.rejects(
        guarded.quote(scope, context, user.user.id),
        (e) => e?.getResponse?.().code === 'SPARK_PRICE_UNVERIFIED',
      );
    }
  } finally {
    await stopApi();
    await database.pool.end();
    await db.end();
  }
});
