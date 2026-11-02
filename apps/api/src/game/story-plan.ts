import { z } from 'zod';
import {
  contentSchema,
  mapMatchesIntent,
  worldItemDefinitionsSchema,
  npcItemStockSchema,
  authoredGameDraftSchema,
  turnRulesSchema,
  validateStoryLoreReferences,
  type NpcCharacterProfile,
  type AuthoredGameDraft,
} from '@dreamwalk/contracts';
import { compilePlayableDraft } from '@dreamwalk/game-core';
import type { AuthoringTextDefinition } from '../live-test/authoring-provider';
import { applyAuthoredCharacters } from './character-authoring';
const id = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,80}$/)
  .refine((v) => !(v in Object.prototype));
const point = z
  .object({ x: z.number().int().min(1).max(30), y: z.number().int().min(1).max(30) })
  .strict();
export const storyPlanSchema = z
  .object({
    version: z.literal(1),
    rooms: z
      .array(
        z
          .object({
            locationId: id,
            width: z.number().int().min(8).max(24),
            height: z.number().int().min(8).max(24),
            spawns: z.array(point).length(4),
            blocked: z.array(point).max(64),
            surfaces: z
              .array(
                z
                  .object({
                    id,
                    visual: z.enum(['table', 'counter', 'shelf', 'rug', 'plant']),
                    x: z.number().int().min(1).max(23),
                    y: z.number().int().min(1).max(23),
                    width: z.number().int().min(1).max(4),
                    height: z.number().int().min(1).max(3),
                    solid: z.boolean(),
                  })
                  .strict(),
              )
              .max(12),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    connections: z.array(z.object({ a: id, b: id, atA: point, atB: point }).strict()).max(6),
    npcs: z
      .array(
        z
          .object({
            sourceNpcId: z.uuid(),
            locationId: id,
            x: z.number().int().min(1).max(23),
            y: z.number().int().min(1).max(23),
            stock: npcItemStockSchema,
          })
          .strict(),
      )
      .max(8),
    items: worldItemDefinitionsSchema,
  })
  .strict();
export type StoryPlanSource = {
  title: string;
  synopsis?: string;
  content: z.infer<typeof contentSchema>;
  npcs: {
    id: string;
    name: string;
    role: string;
    description: string;
    appearance: string;
    characterProfile?: NpcCharacterProfile | null;
  }[];
  priorDraft?: AuthoredGameDraft | null;
};
const exact = (a: string[], b: string[]) =>
  a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));
export function compileStoryPlan(source: StoryPlanSource, value: unknown) {
  const proposal = storyPlanSchema.parse(value),
    content = contentSchema.parse(source.content);
  if (
    !validateStoryLoreReferences(content) ||
    !exact(
      proposal.rooms.map((r) => r.locationId),
      content.locations.map((l) => l.id),
    ) ||
    !exact(
      proposal.npcs.map((n) => n.sourceNpcId),
      content.npcIds,
    ) ||
    !exact(
      source.npcs.map((n) => n.id),
      content.npcIds,
    )
  )
    throw Error('STORY_SOURCE_MISMATCH');
  const start =
    content.scenes.find((s) => s.id === content.startSceneId)?.locationId ??
    content.locations[0]?.id;
  const draft: AuthoredGameDraft = authoredGameDraftSchema.parse({
    schemaVersion: 1,
    title: source.title,
    npcBehavior: 'reactive-v1',
    turnRules: source.priorDraft?.turnRules ?? turnRulesSchema.parse({}),
    narrativeConstraints: source.priorDraft?.narrativeConstraints,
    worldItemDefinitions: proposal.items,
    worldItemRules: { version: 1, inventoryCapacity: 32, maxWorldItems: 64, surfaceCapacity: 4 },
    startMapId: start,
    maps: proposal.rooms.map((r) => {
      const l = content.locations.find((l) => l.id === r.locationId)!;
      if (!mapMatchesIntent(l.mapIntent, r.width, r.height))
        throw Error('STORY_MAP_INTENT_MISMATCH');
      const blocked = [...r.blocked];
      for (const f of r.surfaces)
        if (f.solid)
          for (let y = f.y; y < f.y + f.height; y++)
            for (let x = f.x; x < f.x + f.width; x++)
              if (!blocked.some((p) => p.x === x && p.y === y)) blocked.push({ x, y });
      return {
        id: r.locationId,
        sourceLocationId: r.locationId,
        label: l.name,
        description: l.description,
        width: r.width,
        height: r.height,
        blocked,
        spawns: r.spawns,
        exits: [],
        composition: { version: 1, provenance: 'ai-generated-plan', layers: r.surfaces },
      };
    }),
    objects: [],
    npcs: proposal.npcs.map((n) => {
      const s = source.npcs.find((s) => s.id === n.sourceNpcId)!;
      return {
        id: s.id,
        sourceNpcId: s.id,
        label: s.name,
        mapId: n.locationId,
        x: n.x,
        y: n.y,
        visual: 'keeper',
        goal: 'help',
        itemStock: n.stock,
        publicProfile: { role: s.role, description: s.description, appearance: s.appearance },
      };
    }),
    roundPolicy: { maxRounds: 5, planningMs: 30000 },
  });
  const pairs = new Set<string>();
  applyAuthoredCharacters(draft, source.npcs, content.lorebook);
  for (const [c, v] of proposal.connections.entries()) {
    const a = draft.maps.find((m) => m.id === v.a),
      b = draft.maps.find((m) => m.id === v.b),
      pair = [v.a, v.b].sort().join(':');
    if (!a || !b || a === b || pairs.has(pair)) throw Error('STORY_CONNECTION_INVALID');
    pairs.add(pair);
    a.exits.push({
      id: 'passage-' + c + '-a',
      ...v.atA,
      destinationMapId: b.id,
      destination: { ...v.atB },
      label: b.label,
    });
    b.exits.push({
      id: 'passage-' + c + '-b',
      ...v.atB,
      destinationMapId: a.id,
      destination: { ...v.atA },
      label: a.label,
    });
  }
  const reachable = new Set<string>([draft.startMapId]);
  for (let i = 0; i < draft.maps.length; i++)
    for (const m of draft.maps)
      if (reachable.has(m.id)) for (const e of m.exits) reachable.add(e.destinationMapId);
  if (reachable.size !== draft.maps.length) throw Error('STORY_DISCONNECTED');
  const checked = compilePlayableDraft(draft);
  if (!checked.playable) throw Error('INVALID_MAP:' + checked.errors.join(';'));
  return { draft, playable: checked.playable, proposal };
}
function nullableStrict(schema: Record<string, unknown>): Record<string, unknown> {
  const r = { ...schema };
  delete r.$schema;
  delete r.default;
  if (r.properties) {
    const props = r.properties as Record<string, Record<string, unknown>>,
      required = (r.required as string[]) ?? [];
    r.properties = Object.fromEntries(
      Object.entries(props).map(([k, v]) => [
        k,
        required.includes(k) ? nullableStrict(v) : { anyOf: [nullableStrict(v), { type: 'null' }] },
      ]),
    );
    r.required = Object.keys(props);
    r.additionalProperties = false;
  }
  if (r.items && typeof r.items === 'object')
    r.items = nullableStrict(r.items as Record<string, unknown>);
  return r;
}
export function removeNullFields(v: unknown): unknown {
  return Array.isArray(v)
    ? v.map(removeNullFields)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([, v]) => v !== null)
            .map(([k, v]) => [k, removeNullFields(v)]),
        )
      : v;
}
export const storyPlanDefinition: AuthoringTextDefinition = {
  version: 'authored-story-plan-v3-character-profile',
  schema: nullableStrict(z.toJSONSchema(storyPlanSchema)),
  instructions:
    'Create the opening playable spatial plan from this author story, not a new story. Output only JSON. Preserve EXACTLY all supplied source location and NPC IDs, names and identities. Place every source NPC once, choose its location from story/context; do not replace it with a helper or add NPCs or quests. Connect all source locations bidirectionally. Every spawn, NPC and passage must be reachable on walkable interior floor. Solid furniture adds collision, keep passages clear. Use table/counter/shelf surfaces when the story calls for them. Choose only plausible benign physical item definitions and finite NPC stock supported by the story; no arbitrary powers, private facts or executable code. Item restoreVitality is bounded 0..3, nonedible items restore 0. The AI only proposes; author review and server validation are required. Honor geometry described in the synopsis, world, rules and each location description. Do not turn every room into the minimum 8x8 square: choose dimensions and orientation appropriate to the author intent. Explicit location.mapIntent is authoritative: dimensions requires exactly its width and height; aspect requires that exact width:height ratio, choosing feasible integer dimensions within 8..24. These constraints override priorDraft geometry. With no explicit intent, infer suitable proportions from the description; do not invent a fixed widescreen ratio. Prior drafts are continuity context, not permission to ignore new geometry intent. Four spawns must be distinct; rooms 8..24 cells, at most four locations/eight NPCs. Do not narrate success, add fetch quests, rename source characters or create pixel art. Opening and constraints describe an ongoing story, not a fixed script.',
  validateProposal: (v) => storyPlanSchema.parse(removeNullFields(v)),
};
