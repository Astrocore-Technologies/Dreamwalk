/**
 * Bounded live rehearsal of the character-reply ensemble on the real model.
 * Default: prints the plan only (no network). `--execute` needs ENSEMBLE_REHEARSAL_APPROVED
 * and a key reaching the official endpoint. Hard USD cap, no retries, stops on any failure,
 * synthetic content only (no real player data). Never writes a key anywhere.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const APPROVAL = 'usd-0.50-hard-cap-no-retry';
const CAP_MICROS = 500_000; // USD 0.50, the owner's ceiling for this whole rehearsal
const PER_CALL_MICROS = 30_000; // adapter refuses any request whose upper bound exceeds this
const MAX_CALLS = 8;
const persona = {
  roxy: {
    label: 'Рокси',
    persona:
      'Дерзкая и быстрая на язык служанка-волшебница. Говорит коротко, с насмешкой, любит поддеть. Не доверяет чужакам, но тянется к тем, кто смел.',
    knows: ['В башне недавно пропал ключ от верхней двери.'],
  },
  paul: {
    label: 'Пол',
    persona:
      'Осторожный старый хранитель обсерватории. Говорит размеренно, длинными фразами, избегает прямых ответов, когда боится.',
    knows: ['Ключ от верхней двери он сам спрятал под третьей ступенью лестницы.'],
  },
  hitogami: {
    label: 'Хитогами',
    persona:
      'Божество этого мира: не ходит и не спорит, говорит редко, образами и загадками, не называет вещи прямо.',
    knows: ['Мир отвечает на смелость.'],
  },
};
const scene = {
  place: 'Обсерватория, круглый зал с тусклыми линзами и винтовой лестницей наверх.',
  present: ['Рокси', 'Пол', 'Хитогами', 'Игрок (Вестник)'],
};
const speechContext = (npc, text, channel = 'say', extra = {}) => ({
  contextHash: `rehearsal-${npc}-${Buffer.from(text).toString('base64').slice(0, 12)}`,
  language: 'ru',
  self: { id: npc, ...persona[npc] },
  scene,
  channel,
  heard: [{ speaker: 'Игрок (Вестник)', channel, text }],
  responseOptional: npc === 'hitogami',
  ...extra,
});
const ensemble = (lead, text, channel = 'say') => ({
  ...speechContext(lead, text, channel),
  ensemble: {
    members: Object.keys(persona)
      .filter((id) => id !== lead)
      .map((id) => ({
        npcId: id,
        label: persona[id].label,
        context: speechContext(id, text, channel),
      })),
  },
});
const messages = {
  greet: 'Здравствуйте! Я только что пришёл. Что здесь происходит?',
  knife: '*выхватываю нож и приставляю к горлу Пола* Говорите, где ключ!',
  calm: 'Спасибо, я просто осмотрюсь.',
};
const steps = [
  { id: 'ensemble-greet', mode: 'ensemble', message: 'greet' },
  { id: 'single-roxy-greet', mode: 'single', npc: 'roxy', message: 'greet' },
  { id: 'single-paul-greet', mode: 'single', npc: 'paul', message: 'greet' },
  { id: 'single-hitogami-greet', mode: 'single', npc: 'hitogami', message: 'greet' },
  { id: 'ensemble-knife', mode: 'ensemble', message: 'knife' },
  { id: 'ensemble-calm', mode: 'ensemble', message: 'calm' },
];
const contextFor = (step) =>
  step.mode === 'ensemble'
    ? ensemble('paul', messages[step.message])
    : speechContext(step.npc, messages[step.message]);
if (!process.argv.includes('--execute')) {
  console.log(
    JSON.stringify(
      { approval: APPROVAL, capMicros: CAP_MICROS, perCallMicros: PER_CALL_MICROS, steps },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (process.env.ENSEMBLE_REHEARSAL_APPROVED !== APPROVAL) throw Error('EXPLICIT_APPROVAL_REQUIRED');
if (steps.length > MAX_CALLS) throw Error('TOO_MANY_CALLS');
const { OpenAiNpcProvider } = require('../apps/api/dist/ai/openai-provider');
const { proseReport } = require('../packages/game-core/dist');
let spent = 0,
  fetches = 0;
// One counted transport: an attempt is never repeated, whatever the outcome.
const transport = async (url, init) => {
  if (++fetches > MAX_CALLS) throw Error('FETCH_BUDGET_EXHAUSTED');
  if (String(url) !== 'https://api.openai.com/v1/responses') throw Error('UNEXPECTED_ENDPOINT');
  return fetch(url, init);
};
const provider = new OpenAiNpcProvider(
  {
    enabled: true,
    apiKey: process.env.NPC_AI_API_KEY || 'proxy-injected',
    model: 'gpt-6-luna',
    version: 'ensemble-rehearsal-1',
    maxInputBytes: 64000,
    maxOutputTokens: 2048,
    maxResponseBytes: 400000,
    inputMicrosPerMillion: 250_000,
    outputMicrosPerMillion: 750_000,
  },
  transport,
);
const results = [];
for (const step of steps) {
  if (spent + PER_CALL_MICROS > CAP_MICROS) {
    results.push({ id: step.id, skipped: 'CAP' });
    break;
  }
  const started = performance.now();
  let result;
  try {
    result = await provider.generate({
      jobId: `rehearsal-${step.id}`,
      purpose: 'speech',
      context: contextFor(step),
      signal: AbortSignal.timeout(90_000),
      maxCostMicros: PER_CALL_MICROS,
    });
  } catch (error) {
    // Unknown outcome: charge the ceiling, record it and stop. Nothing is retried.
    spent += PER_CALL_MICROS;
    results.push({ id: step.id, thrown: error.code ?? String(error.message).slice(0, 80) });
    break;
  }
  const seconds = (performance.now() - started) / 1000;
  spent += result.usage?.costMicros ?? PER_CALL_MICROS; // unknown cost is charged at the ceiling
  const proposal = result.proposal ?? {};
  const lines = result.failureCode
    ? []
    : [
        { speaker: step.npc ?? 'paul', text: String(proposal.text ?? '') },
        ...(proposal.ensembleLines ?? []).map((l) => ({ speaker: l.speakerId, text: l.text })),
      ].filter((l) => l.text);
  results.push({
    id: step.id,
    seconds: Math.round(seconds * 10) / 10,
    failureCode: result.failureCode ?? null,
    usage: result.usage ?? null,
    lines,
    report: lines.length ? proseReport(lines) : null,
  });
  if (result.failureCode) break; // never continue past a failure
}
const out = resolve(
  process.argv[process.argv.indexOf('--out') + 1] || '.local/ensemble-rehearsal.json',
);
mkdirSync(resolve(out, '..'), { recursive: true });
const summary = { spentMicros: spent, capMicros: CAP_MICROS, fetches, results };
writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(
  JSON.stringify({ spentMicros: spent, fetches, out, ok: results.every((r) => !r.failureCode) }),
);
