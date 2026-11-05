import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { adminStoryDeletionCopy } from '../../apps/web/components/studio/admin-story-deletion-copy.ts';

test('admin deletion copy covers three locales with explicit restore and retained-save consequences', () => {
  const keys = Object.keys(adminStoryDeletionCopy.ru).sort();
  for (const locale of ['ru', 'en', 'uk']) {
    assert.deepEqual(Object.keys(adminStoryDeletionCopy[locale]).sort(), keys);
    assert.ok(
      Object.values(adminStoryDeletionCopy[locale]).every((value) => value.trim().length > 0),
    );
    assert.ok(adminStoryDeletionCopy[locale].removeLabel.includes('{title}'));
  }
});

test('deletion UI uses guarded dialogs and durable request identities, without browser-native confirmation', async () => {
  const source = await readFile('apps/web/components/studio/admin-story-deletion.tsx', 'utf8');
  assert.match(source, /method: 'DELETE'/);
  assert.match(source, /expectedRevision: story.deletionRevision/);
  assert.match(source, /operation.current \?\?=/);
  assert.match(source, /if \(dialog.pending.current \|\| !operation.current \|\| stale\) return/);
  assert.match(source, /deletionId: target.deletionId/);
  assert.equal((source.match(/onClose=\{dialog.close\}/g) || []).length, 2);
  assert.doesNotMatch(source, /window.confirm|window.alert|dangerouslySetInnerHTML/);
});
