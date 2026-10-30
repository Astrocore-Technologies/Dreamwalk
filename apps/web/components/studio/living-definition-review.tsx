'use client';
import type {
  NpcObservation,
  NpcGoalDefinition,
  NpcPromiseTemplate,
  NpcCondition,
} from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
import { goalLabels, motivationLabels, disclosureLabels } from './living-npc-authoring';
import { conditionLabels, observationLabels } from './living-npc-conditions';
export function LivingDefinitionReview({
  facts,
  goals,
  promises,
  names,
}: {
  facts: NpcObservation[];
  goals: NpcGoalDefinition[];
  promises: NpcPromiseTemplate[];
  names: Record<string, { label?: string }>;
}) {
  const { t } = useT();
  const name = (id: string) => names[id]?.label || t('Предмет');
  const condition = (value: NpcCondition) => {
    switch (value.kind) {
      case 'observed':
        return `${t(conditionLabels[value.kind])}: ${t(observationLabels[value.event])}${value.targetId ? ` · ${name(value.targetId)}` : ''}`;
      case 'near_entity':
        return `${t(conditionLabels[value.kind])}: ${name(value.entityId)}`;
      case 'owns_item':
        return `${t(conditionLabels[value.kind])}: ${name(value.itemId)}`;
      case 'elapsed':
        return `${t(conditionLabels[value.kind])}: ${value.ticks}`;
      case 'trust_at_least':
        return `${t(conditionLabels[value.kind])}: ${value.minimum}`;
      default:
        return t(conditionLabels[value.kind]);
    }
  };
  const list = (values: NpcCondition[]) => values.map(condition).join('; ') || t('Не указаны');
  return (
    <div>
      <h5>{t('Именованные знания')}</h5>
      <ul>
        {facts.map((fact) => (
          <li key={fact.id}>
            <strong>{fact.title}</strong>
            <p>{fact.definitionText}</p>
            <p>
              {t('Правило раскрытия')}: {t(disclosureLabels[fact.revealCondition || 'public'])}
            </p>
            {fact.publicQuestion && (
              <p>
                {t('Публичный вопрос')}: {fact.publicQuestion}
              </p>
            )}
          </li>
        ))}
      </ul>
      <h5>{t('Собственные цели NPC')}</h5>
      <ul>
        {goals.map((goal, index) => (
          <li key={goal.id}>
            <strong>
              {t('Цель {number}', { number: index + 1 })}: {t(goalLabels[goal.kind])}
            </strong>
            <p>
              {t('Мотив цели')}: {t(motivationLabels[goal.motivation])} · {t('Приоритет цели')}:{' '}
              {goal.priority}
            </p>
            {goal.targetId && (
              <p>
                {t('Объект цели')}: {name(goal.targetId)}
              </p>
            )}
            {goal.itemId && (
              <p>
                {t('Предмет для помощи')}: {name(goal.itemId)}
              </p>
            )}
            <p>
              {t('Отношение к риску')}:{' '}
              {t(
                goal.risk === 'cautious'
                  ? 'Осторожное'
                  : goal.risk === 'bold'
                    ? 'Смелое'
                    : 'Сбалансированное',
              )}
            </p>
            <p>
              {t('Минимальная длительность цели')}: {goal.holdTicks}
            </p>
            <p>
              {t('Когда начинать')}: {list(goal.when)}
            </p>
            <p>
              {t('Условия успеха')}: {list(goal.success)}
            </p>
            <p>
              {t('Когда отменять')}: {list(goal.cancelWhen)}
            </p>
            {goal.fallbackGoalId && (
              <p>
                {t('Запасная цель')}:{' '}
                {t('Цель {number}', {
                  number: goals.findIndex((entry) => entry.id === goal.fallbackGoalId) + 1,
                })}
              </p>
            )}
          </li>
        ))}
      </ul>
      <h5>{t('Шаблоны обещаний')}</h5>
      <ul>
        {promises.map((promise, index) => (
          <li key={promise.id}>
            {t('Обещание {number}', { number: index + 1 })}:{' '}
            {promise.promisedAction
              ? `${t(promise.promisedAction.kind === 'open' ? 'Открыть дверь' : 'Осмотреть')} · ${name(promise.promisedAction.targetId)}`
              : name(promise.itemId || '')}
            <p>
              {t('Когда предлагать')}:{' '}
              {t(promise.offerOn === 'addressed' ? 'Обращение к NPC' : 'Получена помощь')}
            </p>
            <p>
              {t('Срок в шагах')}: {promise.dueTicks}
            </p>
            {promise.alternativeGoalId && (
              <p>
                {t('Альтернатива при срыве обещания')}:{' '}
                {t('Цель {number}', {
                  number: goals.findIndex((goal) => goal.id === promise.alternativeGoalId) + 1,
                })}
              </p>
            )}
            <p>
              {t('Условия исполнения')}: {list(promise.conditions)}
            </p>
            <p>
              {t(
                promise.requiresAcceptance
                  ? 'Требовать согласия игрока'
                  : 'Без дополнительного согласия',
              )}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
