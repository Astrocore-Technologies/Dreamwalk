import test from 'node:test';
import assert from 'node:assert/strict';
import { listCampaigns } from '../../apps/api/src/game/campaign-list.ts';

const adventure = '08f187c3-332c-4b14-81a0-5388df5ef7e4';
test('per-story saves span releases with accepted membership, live owners and existing source ACL', async () => {
  const result = await listCampaigns(
    {
      async query(sql, values) {
        assert.deepEqual(values, ['user', adventure]);
        assert.match(sql, /v.adventure_id=\$2 AND c.status='active' AND m.status='accepted'/);
        assert.match(sql, /m.user_id=\$1/);
        assert.match(sql, /owner.deleted_at IS NULL/);
        assert.match(sql, /adventure_invitations/);
        assert.match(sql, /game_playable_approvals/);
        assert.match(sql, /ORDER BY c.updated_at DESC,c.id DESC LIMIT 100/);
        assert.doesNotMatch(sql, /c.source_version_id=\$2|DELETE|UPDATE |INSERT/);
        return [
          {
            id: 'save',
            adventure_id: adventure,
            source_version_id: 'earlier-version',
            source_revision: 2,
            updated_at: '2026-11-05',
          },
        ];
      },
    },
    'user',
    adventure,
  );
  assert.equal(result.userId, 'user');
  assert.equal(result.adventureId, adventure);
  assert.equal(result.campaigns[0].playableVersionId, 'earlier-version');
  assert.equal(result.campaigns[0].updatedAt, '2026-11-05');
});

test('global campaign listing preserves invitations and creation order', async () => {
  const result = await listCampaigns(
    {
      async query(sql, values) {
        assert.deepEqual(values, ['user']);
        assert.match(sql, /m.status IN \('accepted','pending'\)/);
        assert.match(sql, /ORDER BY c.created_at DESC,c.id DESC LIMIT 100/);
        assert.doesNotMatch(sql, /v.adventure_id=\$2/);
        return [];
      },
    },
    'user',
  );
  assert.deepEqual(result, { userId: 'user', adventureId: null, campaigns: [] });
});

test('malformed or ambiguous story filters cannot reach the database', async () => {
  for (const invalid of ['', 'story', [adventure, adventure], { adventure }, null])
    await assert.rejects(() =>
      listCampaigns(
        {
          query() {
            assert.fail('must validate first');
          },
        },
        'user',
        invalid,
      ),
    );
});
