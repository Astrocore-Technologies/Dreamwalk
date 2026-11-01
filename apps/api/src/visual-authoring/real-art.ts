import sharp from 'sharp';
import { normalizeRaster } from '../assets/raster';
import type { GenerationRequest } from '../image-generation/contracts';
import type { AuthoredGameDraft, VisualGenerationRole } from '@dreamwalk/contracts';

export const locationArtRoles: VisualGenerationRole[] = [
  'background',
  'annex-background',
  'table',
  'counter',
  'shelf',
  'plant',
  'rug',
  'door-open',
  'door-closed',
  'sample-sheet',
  'npc-sheet',
];
export function requiredArtRoles(
  kind: 'character' | 'location',
  status: string,
  plan?: AuthoredGameDraft | null,
): VisualGenerationRole[] {
  if (
    kind === 'location' &&
    plan?.maps.some((m) => m.composition?.provenance === 'ai-generated-plan')
  ) {
    return [
      'background',
      'annex-background',
      ...new Set(plan.maps.flatMap((m) => m.composition?.layers.map((l) => l.visual) ?? [])),
      'quest-item',
      'door-open',
      'door-closed',
      'sample-sheet',
      'npc-sheet',
    ];
  }
  return kind === 'location'
    ? locationArtRoles
    : status === 'concept'
      ? ['concept']
      : ['portrait', 'sheet'];
}
export function isSheet(role: string) {
  return ['sheet', 'sample-sheet', 'npc-sheet'].includes(role);
}
export type AuthoringArtSource = {
  id: string;
  kind: 'character' | 'location';
  adventure_id: string | null;
  revision: number;
  source_hash: string;
  status: string;
  concept_revision_id: string | null;
  brief: {
    name: string;
    description?: string;
    outfit?: string;
    appearance?: string;
    sourcePhotoAssetId?: string;
    sourcePhotoPermission?: boolean;
    allowOutputReuse?: boolean;
  };
  plan: AuthoredGameDraft | null;
  public_grounding?: {
    title?: string;
    synopsis?: string;
    genre?: string;
    world?: string;
    opening?: string;
    locations?: { name: string; description: string }[];
  };
};
/** Only explicitly public source fields and the private owner's brief enter the provider request.
 * NPC secrets, authored private boundaries and hero knowledge never enter this renderer. */
export function buildArtRequest(
  p: AuthoringArtSource,
  role: VisualGenerationRole,
  styleReferenceRevisionId?: string,
): GenerationRequest {
  const sheet = isSheet(role),
    portrait = role === 'portrait',
    background = role.endsWith('background');
  const stage = role === 'concept' ? 'concept' : 'parts';
  const base =
    p.kind === 'character'
      ? `Character: ${p.brief.name}. Outfit: ${(p.brief.outfit ?? '').slice(0, 350)}. Appearance: ${(p.brief.appearance ?? '').slice(0, 250)}. Description: ${p.brief.description ?? ''}.`
      : `Location: ${p.brief.name}. Public story: ${JSON.stringify(p.public_grounding ?? {}).slice(0, 600)}. Description: ${p.brief.description ?? ''}.`;
  const subject =
    role === 'npc-sheet'
      ? p.plan?.npcs.find((n) => n.id === 'alchemist')
      : role === 'quest-item'
        ? p.plan?.objects.find((o) => o.id === 'rain-journal')
        : role.startsWith('door-')
          ? p.plan?.objects.find((o) => o.id === 'atelier-door')
          : undefined;
  const publicSubject = subject
    ? ` Public subject: ${subject.label}. ${subject.publicProfile?.role ?? ''}. ${subject.publicProfile?.description ?? ''}. ${subject.publicProfile?.appearance ?? ''}.`
    : '';
  const map = p.plan?.maps.find(
    (m) => m.id === (role === 'annex-background' ? 'annex' : 'atelier'),
  );
  const spatial =
    background && map
      ? `Room: ${map.label}. ${map.description ?? ''}. Locked spatial plan ${map.width}x${map.height}; entrances ${JSON.stringify(map.exits.map((e) => ({ x: e.x, y: e.y })))}; furniture footprints ${JSON.stringify(map.composition?.layers ?? [])}. Draw the room shell/floor only. Leave furniture/door/NPC layers absent; these are composited separately. Image does not change collision.`
      : '';
  const instruction = sheet
    ? 'Transparent square sprite atlas, exactly SIX columns and FOUR rows, evenly aligned cells. Rows in order SOUTH, WEST, EAST, NORTH. Each row: columns 1-2 idle and 3-6 walk. SAME attractive adult full-body character, consistent clothing and proportions in all 24 cells. Feet at consistent cell baseline. No text, grid, labels, shadows outside cells or cropped limbs. Transparent margin around EVERY cell.'
    : portrait
      ? 'One head and shoulders portrait of the APPROVED reference character; preserve face, outfit and drawn style.'
      : role === 'concept'
        ? 'One attractive adult full-body concept, entire body and boots visible, neutral stance, transparent background. Approval reference only; not a walking asset.'
        : background
          ? spatial
          : `One separate ${role} object layer for that locked location, oblique top-down RPG perspective, transparent background, no room or floor; coherent palette and light. ${styleReferenceRevisionId ? 'Use the attached room image only as the palette, lighting and perspective reference.' : ''}`;
  // Instructions have priority: long author prose cannot remove format/identity requirements.
  const prompt =
    `Hand-drawn polished 2D fantasy RPG illustration, NOT pixel art. ${instruction}\n${publicSubject} ${base}`.slice(
      0,
      2000,
    );
  return {
    ...(p.adventure_id ? { adventureId: p.adventure_id } : {}),
    authoringContext: {
      projectId: p.id,
      expectedProjectRevision: p.revision,
      sourceHash: p.source_hash,
      stage,
      role,
    },
    prompt,
    title: `${p.brief.name} - ${role}`.slice(0, 120),
    kind: portrait
      ? 'portrait'
      : background
        ? 'background'
        : sheet || role === 'concept'
          ? 'sprite'
          : 'object',
    camera: portrait ? 'portrait' : 'top-down',
    background: portrait || background ? 'opaque' : 'transparent',
    tags: ['authoring', p.kind, role],
    referenceRevisionIds:
      p.kind === 'character' && role !== 'concept' && p.concept_revision_id
        ? [p.concept_revision_id]
        : styleReferenceRevisionId
          ? [styleReferenceRevisionId]
          : [],
    privateReferenceAssetIds:
      role === 'concept' && p.brief.sourcePhotoAssetId ? [p.brief.sourcePhotoAssetId] : [],
    rights: {
      basis: 'generated',
      licenseLabel: 'Owner-approved generated art',
      attribution: '',
      allowAuthorReuse: p.brief.allowOutputReuse ?? false,
      attested: true,
    },
    mode: 'external',
    declineReuse: false,
  };
}
export type RasterCheck = {
  valid: boolean;
  code?: string;
  width: number;
  height: number;
  nonemptyFrames?: number;
};
/** Structural checks never assert that the 24 drawings depict a consistent person or correct motion. */
export async function checkArtRaster(bytes: Buffer, role: string): Promise<RasterCheck> {
  const image = sharp(bytes, { limitInputPixels: 4096 * 4096 }),
    meta = await image.metadata();
  const width = meta.width ?? 0,
    height = meta.height ?? 0;
  const result = (valid: boolean, code?: string, nonemptyFrames?: number) => ({
    valid,
    ...(code ? { code } : {}),
    width,
    height,
    ...(nonemptyFrames !== undefined ? { nonemptyFrames } : {}),
  });
  if (!width || !height || (meta.pages ?? 1) !== 1) return result(false, 'INVALID_RASTER');
  const transparent = role !== 'portrait' && !role.endsWith('background');
  const { data, info } = await image
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (transparent) {
    if (!meta.hasAlpha) return result(false, 'ALPHA_REQUIRED');
    let clear = false,
      visible = false;
    for (let i = 3; i < data.length; i += info.channels) {
      clear ||= data[i] < 255;
      visible ||= data[i] > 0;
    }
    if (!clear || !visible) return result(false, 'ALPHA_REQUIRED');
  }
  if (!isSheet(role)) return result(true);
  if (width !== height || width < 768 || width > 2048) return result(false, 'ATLAS_DIMENSIONS');
  let nonempty = 0;
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 6; col++) {
      const left = Math.round((col * width) / 6),
        right = Math.round(((col + 1) * width) / 6);
      const top = Math.round((row * height) / 4),
        bottom = Math.round(((row + 1) * height) / 4);
      let visible = 0,
        clear = 0;
      for (let y = top; y < bottom; y++)
        for (let x = left; x < right; x++) {
          const alpha = data[(y * width + x) * info.channels + 3];
          if (alpha > 16) visible++;
          else clear++;
        }
      const pixels = (right - left) * (bottom - top);
      if (visible > pixels * 0.01 && clear > pixels * 0.01) nonempty++;
    }
  return result(
    nonempty === 24,
    nonempty === 24 ? undefined : 'ATLAS_EMPTY_OR_OPAQUE_FRAME',
    nonempty,
  );
}
/** Cheap deterministic normalization; no generation, retries or invented frames. */
export async function normalizeArtAtlas(bytes: Buffer) {
  const width = (await sharp(bytes).metadata()).width!;
  const cells = [];
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 6; col++) {
      const left = Math.round((col * width) / 6),
        right = Math.round(((col + 1) * width) / 6);
      const top = Math.round((row * width) / 4),
        bottom = Math.round(((row + 1) * width) / 4);
      cells.push({
        input: await sharp(bytes)
          .extract({ left, top, width: right - left, height: bottom - top })
          .resize(128, 192)
          .png()
          .toBuffer(),
        left: col * 128,
        top: row * 192,
      });
    }
  return normalizeRaster(
    await sharp({
      create: { width: 768, height: 768, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite(cells)
      .png()
      .toBuffer(),
    'image/png',
    true,
  );
}
