const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultImageStylePrompt } = require('../dist');
test('all artwork defaults are anime and yield to explicit author style', () => {
  for (const subject of ['character', 'location', 'cover', 'battlemap', 'asset']) {
    const prompt = defaultImageStylePrompt(subject);
    assert.match(prompt, /drawn 2D anime/);
    assert.match(prompt, /Explicit author art style takes precedence/);
    assert.match(prompt, /preserve required camera and gameplay geometry/);
  }
});
test('character, cover and map treatments remain distinct', () => {
  assert.match(defaultImageStylePrompt('character'), /cel shading, expressive faces/);
  assert.match(defaultImageStylePrompt('cover'), /painterly scenery and lighting; no lettering/);
  assert.match(defaultImageStylePrompt('battlemap'), /painterly scenery, clean shapes/);
  assert.doesNotMatch(defaultImageStylePrompt('battlemap'), /faces|portrait|perspective/);
});
