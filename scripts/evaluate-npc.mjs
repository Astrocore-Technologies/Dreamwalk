import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { cpus, arch } from 'node:os';
const require = createRequire(import.meta.url);
const g = require('../packages/game-core/dist');
const args = process.argv.slice(2);
const limits = { campaigns: [1, 16, 4], ticks: [1, 300, 100], runs: [1, 5, 3] };
const config = {};
for (const [key, [min, max, fallback]] of Object.entries(limits)) {
  const index = args.indexOf(`--${key}`),
    value = index < 0 ? fallback : Number(args[index + 1]);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`--${key} must be integer ${min}..${max}`);
  config[key] = value;
}
if (args.some((arg, index) => index % 2 === 0 && !Object.hasOwn(limits, arg.slice(2))))
  throw new Error('Unknown benchmark option');
function fixture(profile) {
  const d = g.createAuthoredDraft('courtyard');
  d.npcBehavior = 'reactive-v1';
  d.objects.find((o) => o.id === 'key').x = 5;
  d.objects.find((o) => o.id === 'key').y = 5;
  if (profile)
    d.npcs[0].personality = {
      role: 'patrol',
      values: ['duty'],
      taboos: ['steal'],
      speechStyle: 'plain',
      behaviorProfile: profile,
    };
  const c = g.compilePlayableDraft(d);
  assert.deepEqual(c.errors, []);
  const s = g.createStateFromPlayable(c.playable, ['alice', 'bob']);
  Object.assign(s.entities.alice, { x: 6, y: 5 });
  return s;
}
function act(s, id, action, operation = 'action') {
  const r = g.applyAction(s, id, action);
  assert.equal(r.error, undefined);
  return g.recordNpcEvents(s, r.state, r.events, operation).state;
}
function advance(s, count) {
  for (let i = 0; i < count; i++) {
    const t = g.tick(s);
    s = g.recordNpcEvents(s, t.state, t.events, `tick-${t.state.tick}`).state;
    s = g.stepLivingNpcs(s).state;
    for (const id of Object.keys(s.npcBrains ?? {})) {
      const r = g.stepNpcPlan(s, id);
      s = g.recordNpcEvents(s, r.state, r.events, `step-${s.tick}-${id}`).state;
    }
  }
  return s;
}
const rubric = [];
function evaluate(id, criterion, fn) {
  const start = performance.now();
  fn();
  rubric.push({
    id,
    criterion,
    result: 'pass',
    elapsedMs: Number((performance.now() - start).toFixed(3)),
  });
}
evaluate('character', 'Stable authored profile changes choices, without changing model', () => {
  let cookie = fixture('cookie'),
    apple = fixture('green-apple');
  cookie = act(cookie, 'alice', { kind: 'talk', targetId: 'keeper' });
  apple = act(apple, 'alice', { kind: 'talk', targetId: 'keeper' });
  assert.equal(g.stepLivingNpcs(cookie).state.npcBrains.keeper.living.obligations.length, 1);
  assert.equal(g.stepLivingNpcs(apple).state.npcBrains.keeper.living.obligations.length, 0);
});
evaluate('personal', 'Observed action changes only the identified actor relationship', () => {
  let s = fixture();
  s.npcBrains.keeper.living.personality.role = 'guard';
  s = act(s, 'alice', { kind: 'pick_up', targetId: 'key' });
  assert.equal(s.npcBrains.keeper.living.relationships.alice.trust, -1);
  assert.equal(s.npcBrains.keeper.living.relationships.bob, undefined);
});
evaluate('limited-knowledge', 'Unseen theft later produces absence, never invented culprit', () => {
  let s = fixture();
  Object.assign(s.entities.bob, { x: 5, y: 4 });
  s = act(s, 'alice', { kind: 'distract', targetId: 'keeper' }, 'distract');
  s = act(s, 'bob', { kind: 'pick_up', targetId: 'key' }, 'hidden-pickup');
  assert.equal(
    s.npcBrains.keeper.living.observations.some((o) => o.kind === 'item_taken'),
    false,
  );
  s.tick = 41;
  s = g.refreshLivingPerception(s).state;
  const absence = s.npcBrains.keeper.living.observations.find((o) => o.kind === 'item_missing');
  assert.ok(absence);
  assert.equal(absence.actorId, undefined);
});
evaluate(
  'correction',
  'Contradictory direct evidence disputes a rumor with provenance retained',
  () => {
    let s = fixture();
    s = g.applyNpcSpeech(s, 'alice', 'keeper', {
      channel: 'whisper',
      claim: { kind: 'item_taken', actorId: 'bob', targetId: 'key' },
    }).state;
    s = act(s, 'alice', { kind: 'pick_up', targetId: 'key' });
    assert.equal(
      s.npcBrains.keeper.living.beliefs.find((b) => b.subjectId === 'bob').status,
      'disputed',
    );
    assert.ok(s.npcBrains.keeper.living.observations.some((o) => o.kind === 'claim'));
  },
);
evaluate(
  'commitment-recovery',
  'Conditional accepted promise survives JSON restart and executes once',
  () => {
    let s = fixture();
    s = act(s, 'alice', { kind: 'talk', targetId: 'keeper' });
    const evidence = s.npcBrains.keeper.living.observations.find((o) => o.kind === 'addressed').id;
    s = g.proposeNpcObligation(
      s,
      'keeper',
      'alice',
      'token',
      [evidence],
      [{ kind: 'elapsed', ticks: 10 }],
      100,
    ).state;
    const id = s.npcBrains.keeper.living.obligations[0].id;
    s = g.respondNpcObligation(s, 'alice', 'keeper', id, 'accept').state;
    s = JSON.parse(JSON.stringify(s));
    s = advance(s, 30);
    assert.equal(s.entities.token.ownerId, 'alice');
    assert.equal(s.entities.alice.inventory.filter((x) => x === 'token').length, 1);
    assert.equal(s.npcBrains.keeper.living.obligations[0].status, 'fulfilled');
  },
);
evaluate('grounding', 'Invented summary prose is rejected rather than rewriting memory', () => {
  let s = fixture();
  s = act(s, 'alice', { kind: 'talk', targetId: 'keeper' });
  const summary = g.createNpcMemorySummary(s, 'keeper');
  assert.equal(
    g.validateNpcSummary(s, 'keeper', {
      ...summary,
      narrative: 'A nonexistent treasure has appeared.',
    }),
    false,
  );
  assert.equal(g.validateNpcSummary(s, 'keeper', summary), true);
});
evaluate(
  'confirmation',
  'Natural-language intent has no effect until explicit confirmation',
  () => {
    const s = fixture(),
      before = JSON.stringify(s),
      p = g.proposePlayerTextIntent(s, 'alice', 'take key');
    assert.ok(p);
    assert.equal(JSON.stringify(s), before);
    assert.equal(g.confirmPlayerTextIntent(s, 'alice', p, false).error, 'FORBIDDEN');
    assert.equal(
      g.confirmPlayerTextIntent(s, 'alice', p, true).state.entities.key.ownerId,
      'alice',
    );
  },
);
advance(fixture(), 30);
const timings = [];
let totalTicks = 0;
const cpuStart = process.cpuUsage();
for (let run = 0; run < config.runs; run++) {
  const states = Array.from({ length: config.campaigns }, () => fixture());
  const started = performance.now();
  for (let i = 0; i < states.length; i++) {
    states[i] = advance(states[i], config.ticks);
    assert.deepEqual(g.validateMapState(states[i]), []);
  }
  const elapsed = performance.now() - started;
  timings.push(Number(elapsed.toFixed(3)));
  totalTicks += config.campaigns * config.ticks;
}
const cpu = process.cpuUsage(cpuStart),
  totalMs = timings.reduce((a, b) => a + b, 0),
  artifacts = {};
for (const name of ['index', 'living', 'living-policy', 'living-reasoning'])
  artifacts[name] = createHash('sha256')
    .update(await readFile(new URL(`../packages/game-core/dist/${name}.js`, import.meta.url)))
    .digest('hex');
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      scope:
        'Deterministic mock behavior and in-process core benchmark; no LLM quality or production capacity claim',
      ruleset: 'hybrid-v3',
      environment: { node: process.version, architecture: arch(), logicalCpus: cpus().length },
      artifacts,
      config: { ...config, npcsPerCampaign: 1, playersPerCampaign: 2 },
      rubric,
      benchmark: {
        runMs: timings,
        totalTicks,
        totalMeasuredMs: Number(totalMs.toFixed(3)),
        meanMsPerCampaignTick: Number((totalMs / totalTicks).toFixed(6)),
        cpuUserMs: Number((cpu.user / 1000).toFixed(3)),
        cpuSystemMs: Number((cpu.system / 1000).toFixed(3)),
      },
      unverified: [
        'real-provider naturalness and character quality',
        'real-provider latency and monetary cost',
        'multi-process/database/WebSocket load capacity',
      ],
    },
    null,
    2,
  ),
);
