'use client';
import type { Npc } from '@dreamwalk/contracts';
import { useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { ErrorBox } from '../ui';
import { selectSceneParticipant } from './scene-participant-selection';

const messages = {
  title: [
    'Кто участвует в этой сцене',
    'Who participates in this scene',
    'Хто бере участь у цій сцені',
  ],
  hint: [
    'Эти персонажи встречаются в сцене и могут общаться. Остальные остаются за сценой, пока история не установит их присутствие.',
    'These characters meet and can converse in this scene. Others remain offstage until their presence is established in the story.',
    'Ці персонажі зустрічаються й можуть спілкуватися в цій сцені. Інші залишаються поза сценою, доки історія не встановить їхню присутність.',
  ],
  empty: [
    'В истории пока нет выбранных NPC.',
    'No NPCs have been selected for this story yet.',
    'Для історії ще не вибрано NPC.',
  ],
} as const;

export function SceneParticipants({
  adventureId,
  storyNpcIds,
  value,
  onChange,
  disabled,
}: {
  adventureId?: string;
  storyNpcIds: string[];
  value?: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const { locale } = useT();
  const index = locale === 'en' ? 1 : locale === 'uk' ? 2 : 0;
  const locals = useResource<{ npcs: Npc[] }>(
    adventureId ? `/studio/adventures/${adventureId}/npcs` : null,
  );
  const templates = useResource<Npc[]>('/npcs');
  const npcs = [...(locals.data?.npcs ?? []), ...(templates.data ?? [])].filter(
    (npc, i, all) =>
      storyNpcIds.includes(npc.id) && all.findIndex((other) => other.id === npc.id) === i,
  );
  return (
    <fieldset
      className="fieldset stack"
      disabled={disabled || locals.loading || templates.loading}
      data-testid="scene-participants"
    >
      <legend>{messages.title[index]}</legend>
      <p className="muted">{messages.hint[index]}</p>
      <ErrorBox message={locals.error || templates.error} />
      {!storyNpcIds.length && <p>{messages.empty[index]}</p>}
      {npcs.map((npc) => (
        <label className="check" key={npc.id}>
          <input
            type="checkbox"
            checked={value?.includes(npc.id) ?? false}
            onChange={(event) =>
              onChange(selectSceneParticipant(value, storyNpcIds, npc.id, event.target.checked))
            }
          />
          {npc.name}
        </label>
      ))}
    </fieldset>
  );
}
