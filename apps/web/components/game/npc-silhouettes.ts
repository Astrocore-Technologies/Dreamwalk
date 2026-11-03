import type { Graphics } from 'pixi.js';
import type { NpcPlaceholder } from '@dreamwalk/contracts';

export const NPC_PLACEHOLDERS: readonly NpcPlaceholder[] = ['neutral', 'male', 'female', 'crowd'];
export const NPC_SILHOUETTE_VARIANTS = 3;
/** Stable across refreshes and independent of private/name/appearance data. */
export function npcSilhouetteKey(entity: { id: string; npcPlaceholder?: NpcPlaceholder }) {
  let hash = 2166136261;
  for (const code of entity.id) hash = Math.imul(hash ^ code.charCodeAt(0), 16777619) >>> 0;
  return `${entity.npcPlaceholder ?? 'neutral'}:${hash % NPC_SILHOUETTE_VARIANTS}`;
}
/** Original reusable vector placeholders, not generated art or collision geometry. */
export function drawNpcSilhouette(g: Graphics, category: NpcPlaceholder, variant: number) {
  const index =
    ((variant % NPC_SILHOUETTE_VARIANTS) + NPC_SILHOUETTE_VARIANTS) % NPC_SILHOUETTE_VARIANTS;
  const color = [0xb9c8d7, 0xd9c5a4, 0xb8cdbb][index]!;
  g.clear();
  g.circle(32, 32, 30).fill({ color: 0x172536, alpha: 0.95 });
  g.circle(32, 32, 29).stroke({ color, width: 2, alpha: 0.8 });
  const person = (x: number, y: number, scale: number, style: NpcPlaceholder) => {
    const head = 7 * scale;
    if (style === 'female') {
      g.roundRect(x - 9 * scale, y - 2 * scale, 18 * scale, 24 * scale, 8 * scale).fill(color);
    }
    g.circle(x, y + head, head).fill(color);
    const shoulders = (style === 'male' ? 15 : style === 'female' ? 11 : 13) * scale;
    g.moveTo(x - shoulders, y + 35 * scale)
      .lineTo(x - shoulders + 2 * scale, y + 23 * scale)
      .quadraticCurveTo(x, y + 13 * scale, x + shoulders - 2 * scale, y + 23 * scale)
      .lineTo(x + shoulders, y + 35 * scale)
      .closePath()
      .fill(color);
    if (index === 1) {
      // A scarf cutout; same shape vocabulary for every category.
      g.moveTo(x - 6 * scale, y + 20 * scale)
        .lineTo(x + 5 * scale, y + 24 * scale)
        .stroke({ color: 0x172536, width: 2 * scale });
    } else if (index === 2) {
      g.roundRect(x - 9 * scale, y + 2 * scale, 18 * scale, 3 * scale, scale).fill(color);
      g.roundRect(x - 5 * scale, y - 2 * scale, 10 * scale, 5 * scale, scale).fill(color);
    }
  };
  if (category === 'crowd') {
    person(18, 14, 0.62, 'neutral');
    person(46, 14, 0.62, 'neutral');
    person(32, 22, 0.75, 'neutral');
  } else {
    person(32, 12, 1, category);
  }
}
