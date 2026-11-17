import { test, expect } from '@playwright/test';
test('retained standalone dirty-geometry attachment fence (source contract only)', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile('apps/web/components/visual-authoring/location-image.tsx', 'utf8');
  expect(source).toContain("const attachmentMapId = playableDirty ? '' : mapId;");
  expect(source).toContain('value={attachmentMapId}');
  expect(source).toContain('disabled={busy || playableDirty}');
  expect(source).toMatch(
    /\.\.\.\(attachmentMapId\s*\?\s*\{\s*mapId: attachmentMapId,\s*expectedPlayableRevision: prepared\.playable\.revision,\s*expectedArtRevision: prepared\.playable\.artRevision,\s*\}\s*:\s*\{\}\)/,
  );
});
