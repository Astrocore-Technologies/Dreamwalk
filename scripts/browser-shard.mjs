/** File-level balancing keeps each multiplayer scenario on one isolated, single-worker runner. */
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Conservative seconds observed in CI 41633194416; these are scheduling weights, not timeouts.
const seconds = {
  'game-adventure-completion.spec.ts': 280,
  'game-director.spec.ts': 240,
  'game-unified-story.spec.ts': 115,
  'game-cooperation.spec.ts': 100,
  'game-authored.spec.ts': 85,
  'game-turns.spec.ts': 65,
  'game-living.spec.ts': 50,
  'generation-policy-revisions.spec.ts': 60,
  'owner-generation.spec.ts': 55,
  'simple-generation-confirmation.spec.ts': 50,
};
export function partitionBrowserFiles(files, total = 2) {
  if (!Number.isSafeInteger(total) || total < 1 || new Set(files).size !== files.length)
    throw new Error('Invalid browser shard input');
  const groups = Array.from({ length: total }, () => ({ files: [], seconds: 0 }));
  for (const file of [...files].sort(
    (a, b) => (seconds[b] ?? 20) - (seconds[a] ?? 20) || a.localeCompare(b),
  )) {
    const target = groups.reduce((best, group) => (group.seconds < best.seconds ? group : best));
    target.files.push(file);
    target.seconds += seconds[file] ?? 20;
  }
  return groups.map((group) => ({ ...group, files: group.files.sort() }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const match = /^(\d+)\/(\d+)$/.exec(process.argv[2] ?? '');
  if (!match) throw new Error('Expected browser shard index/total');
  const index = Number(match[1]),
    total = Number(match[2]);
  if (index < 1 || index > total || process.argv.length !== 3)
    throw new Error('Invalid browser shard');
  const files = readdirSync('tests/e2e', { recursive: true }).filter((file) =>
    file.endsWith('.spec.ts'),
  );
  const selected = partitionBrowserFiles(files, total)[index - 1];
  if (!selected.files.length) throw new Error('Empty browser shard');
  console.log(
    `Browser shard ${index}/${total}: ${selected.files.length} files, scheduling weight ${selected.seconds}s`,
  );
  console.log(selected.files.join('\n'));
  const paths = selected.files.map(
    (file) => `tests/e2e/${file}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
  );
  const child = spawn(
    process.execPath,
    ['node_modules/@playwright/test/cli.js', 'test', ...paths, '--workers=1'],
    { stdio: 'inherit', env: process.env },
  );
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
