import {
  DEFAULT_DIRECTOR_STYLE,
  directorStyleSettingsSchema,
  type DirectorStyleSettings,
} from '@dreamwalk/contracts/dist/director-style';
import type { Db } from '../db';
import type { AiPurpose } from './types';

export const DIRECTOR_STYLE_KEY = 'director_style';
export async function readDirectorStyle(db: Pick<Db, 'query'>): Promise<DirectorStyleSettings> {
  const row = (
    await db.query('SELECT value FROM platform_settings WHERE key=$1', [DIRECTOR_STYLE_KEY])
  )[0];
  return row ? directorStyleSettingsSchema.parse(row.value) : { ...DEFAULT_DIRECTOR_STYLE };
}
function isDirector(purpose: AiPurpose, context: Record<string, unknown>) {
  return purpose === 'narrative' || (purpose === 'story_turn' && context.mode === 'director');
}
/** Freeze the admin settings before quoting/packing. An admitted turn keeps its snapshot. */
export async function withDirectorStyle<T extends object>(
  db: Pick<Db, 'query'>,
  context: T,
  purpose: AiPurpose,
): Promise<T> {
  const value = context as T & Record<string, unknown>;
  if (!isDirector(purpose, value)) return context;
  const previous = directorStyleSettingsSchema.safeParse(value.directorStyle);
  return {
    ...context,
    directorStyle: previous.success ? previous.data : await readDirectorStyle(db),
  };
}
/** Only fixed server-owned strings reach instructions; no raw config text is interpolated. */
export function directorStyleInstructions(purpose: AiPurpose, context: unknown): string {
  if (
    !context ||
    typeof context !== 'object' ||
    Array.isArray(context) ||
    !isDirector(purpose, context as Record<string, unknown>)
  )
    return '';
  const parsed = directorStyleSettingsSchema.safeParse(
    (context as Record<string, unknown>).directorStyle,
  );
  const profile = parsed.success ? parsed.data : DEFAULT_DIRECTOR_STYLE;
  const style = {
    natural: 'Use clear, conversational narration with concrete observations and natural dialogue.',
    cinematic:
      'Use vivid, focused visual beats and observable action, without taking control of any player.',
    atmospheric:
      'Emphasize grounded sensory atmosphere and tone without inventing hidden facts or props.',
  }[profile.style];
  const pacing = {
    deliberate:
      'Let the current exchange breathe. Develop one small beat, leaving room for the player to respond.',
    balanced: 'Balance description, dialogue and a useful next opening within one story beat.',
    brisk:
      'Keep the current beat concise and direct. Do not skip unresolved choices or advance time, travel or outcomes without validated actions.',
  }[profile.pacing];
  const initiative = {
    reactive:
      'Follow the player lead. Avoid unsolicited complications; still provide a grounded opening when the player asks for help or progress.',
    balanced: 'Follow the player intention and offer one relevant, optional lead when useful.',
    proactive:
      'Within this requested turn, offer one fitting optional hook or complication grounded in the supplied scene or a supported typed proposal. Never force acceptance or start another operation.',
  }[profile.initiative];
  return ` Administrative director presentation: ${style} ${pacing} ${initiative} These preferences affect delivery only. Protected canon, privacy and shared-audience disclosure, NPC knowledge boundaries, player agency, supported action validation and consent always take precedence. Never decide the player thoughts, emotions, dialogue or unstated actions. Do not grant powers, items, currency, completed travel or new permissions. Do not increase the number of scenes, NPCs, actions, provider requests or costs. Honor the requesting player narrativePreferences for detail and dialogue format over these defaults. Director style applies only to narrator prose. In mixed director turns, each public NPC reply preserves its own sceneSpeakers publicSpeechStyle and performance; a newborn preserves its proposed public speech style. Never replace a character voice with the narrator style. A private NPC reply does not inherit the director style.`;
}
