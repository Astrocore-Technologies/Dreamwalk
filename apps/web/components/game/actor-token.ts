/**
 * Round actor tokens: a circular frame with the character's face in the middle.
 * Presentation only. Positions, footprints and server occupancy stay in scene-geometry;
 * the frame is merely drawn (and tapped) a little larger than its cell.
 * A visible portrait is cover-cropped into the circle; without one a neutral
 * bust is drawn in the role colour. No identity is inferred from names or text.
 */
export type TokenKind = 'self' | 'player' | 'npc';
export const TOKEN_TEXTURE_SIDE = 128;
/** The frame is drawn this much larger than its cell, around the same centre. */
export const TOKEN_DISPLAY_SCALE = 1.3;
/** Ring/figure colours: you, other players, NPCs. */
export const TOKEN_COLORS: Record<TokenKind, { ring: string; figure: string }> = {
  self: { ring: '#e9c46a', figure: '#e2c675' },
  player: { ring: '#5ec4d4', figure: '#7fd0dc' },
  npc: { ring: '#b58cf0', figure: '#c4a4f5' },
};
const BACKDROP_TOP = '#40335f';
const BACKDROP_BOTTOM = '#1d1730';
const RING_EDGE = '#120d1f';

export function tokenKind(
  entity: { id: string; kind: string },
  actorId: string | undefined,
): TokenKind {
  return entity.kind === 'npc' ? 'npc' : entity.id === actorId ? 'self' : 'player';
}

/** One square crop: centred horizontally, biased to the upper part for tall portraits. */
export function portraitCrop(width: number, height: number) {
  const side = Math.max(1, Math.min(width, height));
  return { sx: (width - side) / 2, sy: (height - side) * 0.25, side };
}

/** A new texture is needed only when the role or the pinned portrait revision changes. */
export function actorTokenKey(kind: TokenKind, portraitRevisionId?: string) {
  return `${kind}|${portraitRevisionId ?? 'bust'}`;
}

export type TokenPortrait = { source: CanvasImageSource; width: number; height: number };

export function drawActorToken(
  ctx: CanvasRenderingContext2D,
  size: number,
  kind: TokenKind,
  portrait?: TokenPortrait,
) {
  const colors = TOKEN_COLORS[kind];
  const ring = Math.max(2, size * 0.075);
  const centre = size / 2;
  const inner = centre - ring;
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.arc(centre, centre, inner, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (portrait && portrait.width > 0 && portrait.height > 0) {
    const { sx, sy, side } = portraitCrop(portrait.width, portrait.height);
    ctx.drawImage(
      portrait.source,
      sx,
      sy,
      side,
      side,
      ring,
      ring,
      size - ring * 2,
      size - ring * 2,
    );
  } else {
    const backdrop = ctx.createLinearGradient(0, 0, 0, size);
    backdrop.addColorStop(0, BACKDROP_TOP);
    backdrop.addColorStop(1, BACKDROP_BOTTOM);
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = colors.figure;
    // Head sits at the centre of the circle; shoulders are clipped by the frame.
    ctx.beginPath();
    ctx.arc(centre, size * 0.43, size * 0.17, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(centre, size * 0.98, size * 0.36, size * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.lineWidth = ring;
  ctx.strokeStyle = colors.ring;
  ctx.beginPath();
  ctx.arc(centre, centre, centre - ring / 2, 0, Math.PI * 2);
  ctx.stroke();
  // A thin dark edge keeps the ring readable on bright scene art.
  ctx.lineWidth = Math.max(1, ring * 0.25);
  ctx.strokeStyle = RING_EDGE;
  ctx.beginPath();
  ctx.arc(centre, centre, centre - ring * 0.12, 0, Math.PI * 2);
  ctx.stroke();
}
