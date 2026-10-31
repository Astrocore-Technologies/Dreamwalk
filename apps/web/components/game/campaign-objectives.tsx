'use client';
import { useT } from '@/lib/i18n';
import type { ObjectiveProjection } from '@dreamwalk/contracts';
const labels = {
  ru: {
    all: 'Все условия',
    any: 'Любое условие',
    party_owns_item: 'Предмет у участника группы',
    door_open: 'Дверь открыта',
    door_unlocked: 'Дверь отперта',
    party_reaches_map: 'Участник группы достиг локации',
    sample: 'Готовое приключение: журнал обсерватории',
    art: 'Оригинальная рисованная схема: декоративный слой не меняет стены и игровые объекты.',
    title: 'Цель приключения',
    active: 'В пути',
    achieved: 'Цель достигнута',
    epilogue: 'Эпилог',
    saved: 'Результат сохранён автоматически. Можно продолжить исследование.',
  },
  en: {
    all: 'All conditions',
    any: 'Any condition',
    party_owns_item: 'A party member owns the item',
    door_open: 'Door is open',
    door_unlocked: 'Door is unlocked',
    party_reaches_map: 'A party member reached the location',
    sample: 'Complete adventure: observatory journal',
    art: 'Original drawn scene dressing does not change walls or interactive objects.',
    title: 'Adventure objective',
    active: 'In progress',
    achieved: 'Objective achieved',
    epilogue: 'Epilogue',
    saved: 'The result is saved automatically. You can keep exploring.',
  },
  uk: {
    all: 'Усі умови',
    any: 'Будь-яка умова',
    party_owns_item: 'Предмет в учасника групи',
    door_open: 'Двері відчинено',
    door_unlocked: 'Двері відімкнено',
    party_reaches_map: 'Учасник групи досяг локації',
    sample: 'Готова пригода: журнал обсерваторії',
    art: 'Оригінальна мальована схема: декоративний шар не змінює стіни й ігрові об’єкти.',
    title: 'Мета пригоди',
    active: 'У дорозі',
    achieved: 'Мету досягнуто',
    epilogue: 'Епілог',
    saved: 'Результат збережено автоматично. Можна продовжити дослідження.',
  },
} as const;
export function useObjectiveText() {
  const { locale } = useT();
  return labels[locale];
}
export function CampaignObjectives({ objectives }: { objectives?: ObjectiveProjection[] }) {
  const { locale } = useT();
  const text = labels[locale];
  if (!objectives?.length) return null;
  return (
    <section
      className="stack"
      data-testid="campaign-objectives"
      aria-label={text.title}
      style={{ overflowWrap: 'anywhere', minWidth: 0 }}
    >
      <h2>{text.title}</h2>
      {objectives.map((objective) => {
        const copy = objective.translations?.[locale] || objective;
        const achieved = objective.status === 'achieved';
        return (
          <article
            key={objective.id}
            data-objective-id={objective.id}
            data-objective-status={objective.status}
            className="panel"
          >
            <span role="status">{achieved ? text.achieved : text.active}</span>
            <h3>{copy.title}</h3>
            <p>{copy.description}</p>
            {achieved && (
              <>
                <small>{text.saved}</small>
                {copy.epilogue && (
                  <div data-testid="objective-epilogue">
                    <h4>{text.epilogue}</h4>
                    <p>{copy.epilogue}</p>
                  </div>
                )}
              </>
            )}
          </article>
        );
      })}
    </section>
  );
}
