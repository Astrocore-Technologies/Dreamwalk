const { test } = require('node:test');
const assert = require('node:assert/strict');
const { proseReport, overlap } = require('../../packages/game-core/dist');

// Real lines from a live session (before the voice rules): two characters answer the same
// message with the same sentence, and almost every reply ends in a question.
const live = [
  {
    speaker: 'Рокси',
    text: '— Ты в деревне Буэна, в регионе Фиттоа, Королевство Асура. Тебя интересует, как называется это место, или ты пытаешься понять, как сюда попал?',
  },
  {
    speaker: 'Хитогами',
    text: '— Ты в деревне Буэна, в регионе Фиттоа, королевство Асура. А вот как именно ты сюда попал — этого я по одному вопросу не пойму. Что последнее помнишь?',
  },
  {
    speaker: 'Рокси',
    text: '— Мы смотрим потому что ты только что ранил его, а теперь называешь злодеем. Я не знаю, что такое аниме и откуда тебе знаком этот человек. Что именно ты о нём вспомнил?',
  },
  {
    speaker: 'Пол',
    text: '— Мы смотрим потому что ты только что ударил его, а теперь называешь злодеем. Если вспомнил аниме — расскажи, что именно там было. Может, поймём, почему ты так уверен.',
  },
];
const varied = [
  {
    speaker: 'Рокси',
    text: 'Рокси резко перехватывает посох и встаёт между тобой и белой фигурой.',
  },
  { speaker: 'Пол', text: '— Брось нож. Сейчас же. Руки на виду, парень.' },
  {
    speaker: 'Хитогами',
    text: 'Хитогами разглядывает рану и тихо смеётся: — Давно меня так не встречали.',
  },
];

test('the live session shows mirrored replies and a question at the end of most of them', () => {
  const report = proseReport(live);
  assert.deepEqual(report.mirroredPairs, [
    [0, 1],
    [2, 3],
  ]);
  assert.ok(report.questionEndRate >= 0.5);
});

test('distinct replies are not flagged', () => {
  const report = proseReport(varied);
  assert.deepEqual(report.mirroredPairs, []);
  assert.equal(report.questionEndRate, 0);
  assert.equal(report.selfRepeats, 0);
});

test('overlap counts shared word triples and ignores punctuation and case', () => {
  assert.equal(
    overlap('Мы смотрим потому что ты ранил его', 'мы СМОТРИМ, потому что ты ударил'),
    0.75,
  );
  assert.equal(overlap('', 'что-то'), 0);
});
