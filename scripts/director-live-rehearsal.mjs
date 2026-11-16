/**
 * Bounded live rehearsal of whole director turns (narrator + replies) on a synthetic story.
 * Default prints the plan and the built request sizes only (no network). `--execute` needs
 * ENSEMBLE_REHEARSAL_APPROVED, carries the spend already booked by the first rehearsal against
 * the owner's USD 0.50 ceiling, never retries and stops at the first failure.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
process.env.NODE_ENV ??= 'test';
const g = require('../packages/game-core/dist');
const APPROVAL = 'usd-0.50-hard-cap-no-retry';
const CAP_MICROS = 500_000;
const CARRIED_MICROS = Number(process.env.REHEARSAL_CARRIED_MICROS ?? 8_769); // first rehearsal, docs/ensemble-rehearsal-20261116.md
const PER_CALL_MICROS = 60_000;
const MAX_CALLS = 6;

/** Synthetic test story. No player data; Hitogami is a god beyond the map, not a walker. */
function storyDraft() {
  const draft = g.createAuthoredDraft('observatory');
  draft.title = 'Test: the Six-Sided Hall';
  draft.npcs = [
    {
      id: 'erik',
      label: 'Эрик',
      mapId: 'observatory',
      x: 6,
      y: 4,
      visual: 'keeper',
      goal: 'help',
      patrolTarget: { x: 6, y: 4 },
      publicProfile: {
        role: 'Кузнец и хранитель зала',
        description: 'Крупный немногословный мастер, который чинит механизмы зала.',
        appearance: 'Широкие плечи, кожаный фартук, ожоги на руках.',
        personality: 'Прямой, ворчливый, но справедливый. Не любит пустых слов.',
        greeting: 'Закрывай дверь, сквозняк.',
      },
      personality: {
        role: 'helper',
        values: ['kindness'],
        taboos: ['steal'],
        speechStyle: 'short and blunt',
        behaviorProfile: 'cookie',
      },
    },
    {
      id: 'lira',
      label: 'Лира',
      mapId: 'observatory',
      x: 4,
      y: 6,
      visual: 'traveler',
      goal: 'patrol',
      patrolTarget: { x: 4, y: 6 },
      publicProfile: {
        role: 'Странствующая картографка',
        description: 'Быстрая на язык картографка, зарисовывает всё, что видит.',
        appearance: 'Рыжая коса, чернильные пятна на пальцах, потёртая сумка.',
        personality: 'Любопытная, насмешливая, быстро доверяет и быстро обижается.',
        greeting: 'О, свежее лицо! Не двигайся, я тебя нарисую.',
      },
      personality: {
        role: 'helper',
        values: ['kindness'],
        taboos: ['harm'],
        speechStyle: 'quick and teasing',
        behaviorProfile: 'cookie',
      },
    },
    {
      id: 'hitogami',
      label: 'Хитогами',
      mapId: 'observatory',
      x: 8,
      y: 6,
      visual: 'keeper',
      goal: 'help',
      plannedPresence: {
        mode: 'beyond',
        hint: 'Божество этого мира. Не ходит по залу, но к нему можно обратиться вслух.',
      },
      publicProfile: {
        role: 'Божество мира',
        description: 'Бог шестигранного мира, говорит образами и редко.',
        appearance: 'Не имеет телесной формы.',
      },
      personality: {
        role: 'helper',
        values: ['kindness'],
        taboos: ['harm'],
        speechStyle: 'cryptic and rare',
        behaviorProfile: 'cookie',
      },
    },
  ];
  draft.objects = draft.objects.filter((o) => o.id !== 'token');
  return draft;
}
const compiled = g.compilePlayableDraft(storyDraft());
if (!compiled.playable) throw Error('DRAFT_INVALID ' + compiled.errors.join(';'));
compiled.playable.narrativePremise = {
  title: 'Шестигранный зал (тест)',
  summary: 'Шестигранный зал, кузнец, картографка и бог, который слышит, когда его зовут вслух.',
  world: 'Мир собран из шестигранных плит. Хитогами — бог этого мира, а не персонаж на карте.',
  genre: 'Фэнтези',
};
function freshState() {
  let state = g.createStateFromPlayable(compiled.playable, ['alice'], {
    keepPlannedPresence: false,
  });
  return g.initializeTurnController(state, ['alice']).state;
}
const turns = [
  { id: 'look', text: '*осматриваю зал и подхожу к столу*' },
  { id: 'mixed', text: 'Здравствуйте! *кладу ладонь на стол* Эрик, что вы тут чините?' },
  { id: 'stranger', text: '*замечаю в дверях вдалеке незнакомца в плаще, он наблюдает за мной*' },
  { id: 'god', text: '*поднимаю голову к потолку* Хитогами, если ты слышишь меня, ответь.' },
];
function directorContext(step) {
  const state = freshState();
  const turnId = randomUUID();
  const input = {
    operationId: randomUUID(),
    text: step.text,
    channel: 'say',
    replyLocale: 'ru',
    expectedCanonRevision: state.narrativeCanon?.revision ?? 0,
    turnFence: g.turnFence(state),
  };
  const ended = g.endPlayerTurn(state, 'alice', g.turnFence(state)).state;
  const worldInput = { ...input, turnFence: g.turnFence(ended) };
  return {
    ...g.buildStoryTurnContext(ended, 'alice', worldInput, turnId),
    worldInput,
    turnBasedDeferredDirector: true,
    turnBased: true,
    storyTurnId: turnId,
    generationPolicy: 'world-batch-v1',
    worldPrepared: true,
  };
}
const { buildOpenAiNpcRequestBody } = require('../apps/api/dist/ai/openai-provider');
const cfg = { model: 'gpt-6-luna', maxOutputTokens: 2048 };
const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1].split(',')
  : null;
const contexts = turns
  .filter((t) => !only || only.includes(t.id))
  .map((t) => ({ step: t, context: directorContext(t) }));
if (!process.argv.includes('--execute')) {
  console.log(
    JSON.stringify(
      contexts.map(({ step, context }) => ({
        id: step.id,
        requestBytes: Buffer.byteLength(buildOpenAiNpcRequestBody(cfg, 'story_turn', context)),
      })),
      null,
      2,
    ),
  );
  process.exit(0);
}
if (process.env.ENSEMBLE_REHEARSAL_APPROVED !== APPROVAL) throw Error('EXPLICIT_APPROVAL_REQUIRED');
if (contexts.length > MAX_CALLS) throw Error('TOO_MANY_CALLS');
const { OpenAiNpcProvider } = require('../apps/api/dist/ai/openai-provider');
const raw = [];
let spent = CARRIED_MICROS,
  fetches = 0;
const transport = async (url, init) => {
  if (++fetches > MAX_CALLS) throw Error('FETCH_BUDGET_EXHAUSTED');
  if (String(url) !== 'https://api.openai.com/v1/responses') throw Error('UNEXPECTED_ENDPOINT');
  const response = await fetch(url, init);
  // Synthetic content only: keep the raw model text so a schema failure can be diagnosed.
  response
    .clone()
    .text()
    .then((text) => raw.push(text))
    .catch(() => {});
  return response;
};
const provider = new OpenAiNpcProvider(
  {
    enabled: true,
    apiKey: process.env.NPC_AI_API_KEY || 'proxy-injected',
    model: 'gpt-6-luna',
    version: 'director-rehearsal-1',
    maxInputBytes: 64000,
    maxOutputTokens: 2048,
    maxResponseBytes: 400000,
    inputMicrosPerMillion: 250_000,
    outputMicrosPerMillion: 750_000,
  },
  transport,
);
const results = [];
for (const { step, context } of contexts) {
  if (spent + PER_CALL_MICROS > CAP_MICROS) {
    results.push({ id: step.id, skipped: 'CAP' });
    break;
  }
  const started = performance.now();
  let result;
  try {
    result = await provider.generate({
      jobId: `director-${step.id}`,
      purpose: 'story_turn',
      context,
      signal: AbortSignal.timeout(120_000),
      maxCostMicros: PER_CALL_MICROS,
    });
  } catch (error) {
    spent += PER_CALL_MICROS;
    results.push({ id: step.id, thrown: error.code ?? String(error.message).slice(0, 80) });
    break;
  }
  spent += result.usage?.costMicros ?? PER_CALL_MICROS;
  results.push({
    id: step.id,
    text: step.text,
    seconds: Math.round((performance.now() - started) / 10) / 100,
    failureCode: result.failureCode ?? null,
    failureStage: result.failureStage ?? null,
    usage: result.usage ?? null,
    proposal: result.failureCode ? null : result.proposal,
  });
  if (result.failureCode) break;
}
writeFileSync(
  resolve(
    process.argv[process.argv.indexOf('--out') + 1] || '.local/director-rehearsal.json',
  ).replace(/\.json$/, '.raw.json'),
  JSON.stringify(raw),
);
const out = resolve(
  process.argv[process.argv.indexOf('--out') + 1] || '.local/director-rehearsal.json',
);
mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({ spentMicros: spent, capMicros: CAP_MICROS, fetches, results }, null, 2),
);
console.log(
  JSON.stringify({
    spentMicros: spent,
    fetches,
    out,
    ok: results.every((r) => !r.failureCode && !r.thrown),
  }),
);
