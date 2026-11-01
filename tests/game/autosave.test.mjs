import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftSaveController } from '../../apps/web/lib/draft-save-controller.ts';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function make(persist, extra = {}) {
  const states = [];
  const saver = new DraftSaveController({
    initial: { text: 'original' },
    revision: 1,
    initialResult: { text: 'original' },
    debounceMs: 10,
    validate: (draft) => draft.text.length >= 2,
    persist,
    changed: (state) => states.push(state),
    ...extra,
  });
  return { saver, states };
}

test('initial hydrated baseline and clean manual save make no write', async () => {
  let writes = 0;
  const { saver } = make(async () => {
    writes++;
  });
  assert.deepEqual(await saver.flush(), { text: 'original' });
  await sleep(20);
  assert.equal(writes, 0);
  assert.equal(saver.state.dirty, false);
  saver.dispose();
});
test('debounce coalesces rapid edits into one latest write', async () => {
  const writes = [];
  const { saver } = make(async (draft, revision) => {
    writes.push({ draft, revision });
    return { revision: revision + 1, result: draft };
  });
  saver.update({ text: 'first' });
  saver.update({ text: 'latest' });
  await sleep(35);
  assert.deepEqual(writes, [{ draft: { text: 'latest' }, revision: 1 }]);
  assert.equal(saver.state.status, 'saved');
  saver.dispose();
});
test('edits during flight remain queued and use returned CAS revision; flush waits for latest', async () => {
  const first = deferred(),
    second = deferred(),
    writes = [];
  const { saver } = make((draft, revision) => {
    writes.push({ draft, revision });
    return writes.length === 1 ? first.promise : second.promise;
  });
  saver.update({ text: 'first' });
  const pending = saver.flush();
  saver.update({ text: 'latest' });
  const concurrentFlush = saver.flush();
  assert.equal(writes.length, 1);
  first.resolve({ revision: 2, result: { text: 'first' } });
  await sleep(0);
  assert.deepEqual(writes[1], { draft: { text: 'latest' }, revision: 2 });
  second.resolve({ revision: 3, result: { text: 'latest' } });
  assert.deepEqual(await pending, { text: 'latest' });
  assert.deepEqual(await concurrentFlush, { text: 'latest' });
  assert.equal(saver.state.dirty, false);
  saver.dispose();
});
test('invalid draft stays unsaved locally and never reaches transport', async () => {
  let writes = 0;
  const { saver } = make(async (draft, revision) => {
    writes++;
    return { revision: revision + 1, result: draft };
  });
  saver.update({ text: '' });
  assert.equal(saver.state.status, 'invalid');
  assert.equal(saver.state.dirty, true);
  await assert.rejects(saver.flush(), /INVALID_DRAFT/);
  await sleep(20);
  assert.equal(writes, 0);
  saver.update({ text: 'corrected' });
  await saver.flush();
  assert.equal(writes, 1);
  saver.dispose();
});
test('network failure has no retry loop; manual retry uses same last acknowledged revision', async () => {
  const revisions = [];
  const { saver } = make(async (draft, revision) => {
    revisions.push(revision);
    if (revisions.length === 1) throw new Error('offline');
    return { revision: 2, result: draft };
  });
  saver.update({ text: 'pending' });
  await assert.rejects(saver.flush(), /offline/);
  await sleep(35);
  assert.deepEqual(revisions, [1]);
  assert.equal(saver.state.dirty, true);
  assert.equal(saver.state.status, 'error');
  await saver.flush();
  assert.deepEqual(revisions, [1, 1]);
  assert.equal(saver.state.dirty, false);
  saver.dispose();
});
test('CAS conflict stops autosave including further edits and manual retry until explicit reload', async () => {
  let writes = 0;
  const conflict = Object.assign(new Error('conflict'), { code: 'STALE_STATE' });
  const { saver } = make(async () => {
    writes++;
    throw conflict;
  });
  saver.update({ text: 'local' });
  await assert.rejects(saver.flush(), /conflict/);
  saver.update({ text: 'new local input' });
  await sleep(20);
  await assert.rejects(saver.flush(), /conflict/);
  assert.equal(writes, 1);
  assert.equal(saver.state.status, 'conflict');
  assert.equal(saver.state.dirty, true);
  saver.dispose();
});
test('cancelled pending timer does not save after disposal or reverting to acknowledged text', async () => {
  let writes = 0;
  const { saver } = make(async () => {
    writes++;
  });
  saver.update({ text: 'temporary' });
  saver.update({ text: 'original' });
  await sleep(20);
  assert.equal(writes, 0);
  saver.update({ text: 'not sent' });
  saver.dispose();
  await sleep(20);
  assert.equal(writes, 0);
});
test('late acknowledgement does not replace a user revert made during flight', async () => {
  const first = deferred(),
    writes = [];
  const { saver } = make((draft, revision) => {
    writes.push(draft.text);
    return writes.length === 1
      ? first.promise
      : Promise.resolve({ revision: revision + 1, result: draft });
  });
  saver.update({ text: 'temporary' });
  const pending = saver.flush();
  saver.update({ text: 'original' });
  first.resolve({ revision: 2, result: { text: 'temporary' } });
  await pending;
  assert.deepEqual(writes, ['temporary', 'original']);
  assert.equal(saver.state.dirty, false);
  saver.dispose();
});

test('invalid edits made during an active save are retained and block the queued write', async () => {
  const first = deferred(),
    writes = [];
  const { saver } = make((draft, revision) => {
    writes.push({ draft, revision });
    return writes.length === 1
      ? first.promise
      : Promise.resolve({ revision: revision + 1, result: draft });
  });
  saver.update({ text: 'valid first' });
  const pending = saver.flush();
  saver.update({ text: '' });
  first.resolve({ revision: 2, result: { text: 'valid first' } });
  await assert.rejects(pending, /INVALID_DRAFT/);
  assert.equal(writes.length, 1);
  assert.equal(saver.state.status, 'invalid');
  assert.equal(saver.state.dirty, true);
  saver.update({ text: 'fixed latest' });
  await saver.flush();
  assert.equal(writes[1].revision, 2);
  saver.dispose();
});

test('Studio lifecycle and builder actions flush the shared CAS writer before using saved state', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../../apps/web/components/studio.tsx', import.meta.url),
    'utf8',
  );
  const section = (from, to) => {
    const start = source.indexOf(from),
      end = source.indexOf(to, start);
    assert.ok(start >= 0 && end > start, `Missing source boundaries: ${from} / ${to}`);
    return source.slice(start, end);
  };
  const archive = section(
    "async function setStatus(status: 'draft' | 'archived')",
    '  const savedOriginal',
  );
  assert.match(archive, /const saved = await autosave.flush\(\)/);
  assert.match(archive, /expectedEditRevision: saved.editRevision/);
  assert.doesNotMatch(archive, /\.\.\.draft/);
  const duplicate = section('async function duplicate()', 'async function setStatus(status:');
  assert.ok(duplicate.indexOf('await autosave.flush()') < duplicate.indexOf('/duplicate'));
  const publish = section('async function publish()', 'async function duplicate()');
  const save = section('async function save()', 'async function publish()');
  assert.match(save, /if \(!isNew\) \{\s*const saved = await autosave.flush\(\)/);
  assert.match(save, /catch \(e\) \{[\s\S]*return null;/);
  assert.match(publish, /const saved = await save\(\);\s*if \(!saved\) return;/);
  assert.match(publish, /studio\/adventures\/\$\{saved.id\}\/submit/);
  assert.ok(publish.indexOf('if (!saved) return;') < publish.indexOf('/submit'));
  assert.doesNotMatch(publish, /JSON.stringify\(draft\)|\.\.\.draft/);
  assert.match(source, /JSON.stringify\(\{ \.\.\.value, expectedEditRevision: revision \}\)/);
  assert.match(
    source,
    /<StoryPlayableBuilder\b[^>]*beforePrepare=\{autosave.flush\}[^>]*onApplied=\{refreshArtModeration\}/,
  );
  assert.match(source, /<PrivateRelease\b[^>]*beforePublish=\{autosave.flush\}/);
  assert.match(source, /resource.data !== acknowledged.current/);
  assert.match(source, /enabled: !isNew && hydration > 0/);
  assert.match(source, /document.addEventListener\('click', navigate, true\)/);
});

test('actual Studio publish waits for save, aborts failed save and submits only the acknowledged ID', async () => {
  const { readFile } = await import('node:fs/promises');
  const { default: ts } = await import('typescript');
  const source = await readFile(
    new URL('../../apps/web/components/studio.tsx', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('async function publish()');
  const end = source.indexOf('async function duplicate()', start);
  assert.ok(start >= 0 && end > start);
  // Execute the real handler in memory with inert UI/API dependencies, not a reimplementation.
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const makePublish = (save, calls) =>
    new Function(
      'save',
      'api',
      'setConfirm',
      'setBusy',
      'resource',
      'toast',
      't',
      'setError',
      'errorMessage',
      `${code}; return publish;`,
    )(
      save,
      async (path, options) => {
        calls.push({ path, options });
        return { id: 'acknowledged-id' };
      },
      () => {},
      () => {},
      { setData: () => {} },
      () => {},
      (value) => value,
      () => {},
      (value) => value,
    );
  const pendingSave = deferred(),
    calls = [];
  const pendingPublish = makePublish(() => pendingSave.promise, calls)();
  await Promise.resolve();
  assert.deepEqual(calls, [], 'Submission cannot race an in-flight save');
  pendingSave.resolve({ id: 'acknowledged-id', editRevision: 7 });
  await pendingPublish;
  assert.deepEqual(calls, [
    { path: '/studio/adventures/acknowledged-id/submit', options: { method: 'POST', body: '{}' } },
  ]);
  const blocked = [];
  await makePublish(async () => null, blocked)();
  assert.deepEqual(blocked, [], 'Invalid/conflicted/interrupted save must not submit stale state');
});
