import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Deliberately source-contract checks, NOT an HTTP/DB concurrency or privacy proof.
// Scope assertions to parsed methods/SQL literals so unrelated comments cannot satisfy them.
async function parse(path) {
  const source = await readFile(new URL('../../' + path, import.meta.url), 'utf8');
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function nodes(root, predicate) {
  const found = [];
  function visit(node) {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}
function method(file, name) {
  const found = nodes(file, (n) => ts.isMethodDeclaration(n) && n.name.getText(file) === name);
  assert.equal(found.length, 1, `one method ${name}`);
  return found[0].body;
}
function sql(root) {
  return nodes(root, (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)).map(
    (n) => n.text.replace(/\s+/g, ' ').trim(),
  );
}
function oneSql(root, fragment) {
  const found = sql(root).filter((s) => s.includes(fragment));
  assert.equal(found.length, 1, `one SQL literal containing ${fragment}`);
  return found[0];
}
function compact(node) {
  return node.getText().replace(/\s+/g, ' ');
}
const invitations = await parse('apps/api/src/invitations.ts');
const auth = await parse('apps/api/src/auth.ts');
const content = await parse('apps/api/src/content.ts');
const playable = await parse('apps/api/src/game/playable.service.ts');
const access = await parse('apps/api/src/game/source-access.ts');
const admin = await parse('apps/api/src/admin.ts');

test('invitation projection uses only frozen release metadata, never a missing-release draft fallback', () => {
  const projection = oneSql(invitations, 'AS adventure_slug');
  assert.match(projection, /pr\.snapshot/);
  assert.match(projection, /pr\.id=a\.private_release_id/);
  assert.doesNotMatch(projection, /a\.(?:data|title|synopsis)\b/);
  const invite = method(invitations, 'invite');
  assert.match(compact(invite), /!row\.private_release_id/);
  assert.match(compact(invite), /!current\.private_release_id/);
  assert.match(oneSql(invite, 'SELECT visibility,status,private_release_id'), /FOR UPDATE/);
  const payloads = nodes(
    invite,
    (n) => ts.isCallExpression(n) && n.expression.getText() === 'JSON.stringify',
  );
  const notification = payloads.find((n) => n.getText().includes('adventureMetadata'));
  assert.ok(notification);
  assert.match(notification.getText(), /row\.private_snapshot/);
  assert.doesNotMatch(notification.getText(), /row\.(?:data|title|synopsis)\b/);
});

test('recipient list and acceptance require a live release and cannot resurrect revoked invitations', () => {
  const received = oneSql(method(invitations, 'received'), 'i.recipient_id=$1');
  for (const guard of [
    "i.status IN('pending','accepted')",
    "a.visibility='private'",
    'a.private_release_id IS NOT NULL',
    "a.status<>'archived'",
  ])
    assert.ok(received.includes(guard));
  const respond = method(invitations, 'respond');
  assert.match(compact(respond), /!adventure\.private_release_id/);
  assert.match(oneSql(respond, 'SELECT visibility,status,private_release_id'), /FOR UPDATE/);
  const update = oneSql(respond, 'UPDATE adventure_invitations');
  assert.ok(update.includes("status IN('pending','accepted')"));
  assert.ok(update.includes('recipient_id=$2'));
  const revoke = oneSql(method(invitations, 'revoke'), 'UPDATE adventure_invitations');
  assert.ok(revoke.includes("status='revoked'"));
});

test('notification reads replace historic invitation payload with current frozen metadata and guard access', () => {
  const query = oneSql(auth, 'jsonb_build_object');
  for (const guard of [
    'n.user_id=$1',
    "n.type='invitation'",
    "pr.snapshot->>'title'",
    "pr.snapshot - 'content' - 'publicNpcs'",
    'pr.id IS NOT NULL',
    "a.visibility='private'",
    "a.status<>'archived'",
    'i.recipient_id=$1',
    "i.status IN ('pending','accepted')",
  ])
    assert.ok(query.includes(guard), guard);
  assert.doesNotMatch(query, /a\.(?:data|title|synopsis)\b/);
  assert.match(query, /ELSE n\.payload END/);
});

test('new private starts bind to current release while existing saves require an actual historical release and invitation', () => {
  const start = method(playable, 'resolveForStart');
  const query = oneSql(start, 'AS privately_released');
  assert.ok(query.includes('pr.playable_version_id=v.id AND pr.id=a.private_release_id'));
  assert.match(compact(start), /!row\.private_release_id/);
  assert.match(compact(start), /!row\.privately_released/);
  assert.match(oneSql(start, 'SELECT id FROM adventure_invitations'), /status='accepted'/);
  const fn = nodes(
    access,
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'sourceAccessSql',
  )[0];
  assert.ok(fn);
  const text = compact(fn);
  for (const guard of [
    'a.private_release_id IS NOT NULL',
    'pr.playable_version_id=v.id AND pr.adventure_id=a.id',
    "i.status='accepted'",
    "a.status<>'archived'",
    'author.deleted_at IS NULL',
  ])
    assert.ok(text.includes(guard), guard);
});

test('detail version history is owner-only and invitee NPC display reads frozen snapshot', () => {
  const detail = method(content, 'detail');
  const history = nodes(
    detail,
    (n) => ts.isPropertyAssignment(n) && n.name.getText() === 'versions',
  )[0];
  assert.ok(history);
  assert.match(compact(history), /access !== 'owner'/);
  assert.match(
    compact(detail),
    /access === 'invited' \? row\.private_snapshot : row\.published_snapshot/,
  );
});

test('Sparks wallet GET is owner-filtered and read-only, with missing-wallet zero projection', () => {
  const wallet = method(admin, 'sparksWallet');
  assert.match(compact(wallet), /this\.auth\.require\(req\)/);
  const queries = sql(wallet).filter((s) => /^(?:SELECT|INSERT|UPDATE|DELETE|MERGE)\b/.test(s));
  assert.equal(queries.length, 2);
  assert.ok(queries.every((query) => /^SELECT /.test(query) && /WHERE owner_id=\$1/.test(query)));
  assert.match(
    queries[1],
    /^SELECT .* FROM spark_ledger WHERE owner_id=\$1 ORDER BY id DESC LIMIT 100$/,
  );
  assert.match(queries[0], /^SELECT .* FROM spark_wallets WHERE owner_id=\$1$/);
  const calls = nodes(wallet, ts.isCallExpression).map((n) => n.expression.getText());
  assert.ok(!calls.some((c) => /ensureWallet|reserve|settle|capture|\.tx$/.test(c)));
  assert.match(compact(wallet), /row\?\.balance_subunits \?\? '0'/);
  assert.match(compact(wallet), /purchaseAvailable: false/);
});

test('ordinary private Start selects only the explicitly released version, never the newest test', async () => {
  const source = await readFile(
    new URL('../../apps/web/components/game/adventure-launch.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /version\.approved/);
  assert.match(source, /version\.id === adventure\.playableVersionId/);
});
