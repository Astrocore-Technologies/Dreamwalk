import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { evaluateCharacterQuality } = require('../tests/game/character-quality-fixture.cjs');
if (process.argv.length !== 2)
  throw new Error('This deterministic evaluation accepts no provider or paid mode.');
console.log(JSON.stringify(evaluateCharacterQuality(), null, 2));
