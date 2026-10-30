'use client';
import type { NpcCondition } from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
import { Button, Field, Input, Select } from '@/components/ui';
export const conditionLabels = {
  always: 'Всегда',
  observed: 'Наблюдаемое событие',
  near_entity: 'Рядом с объектом',
  owns_item: 'Владеет предметом',
  recipient_near: 'Адресат рядом',
  trust_at_least: 'Минимальное доверие',
  elapsed: 'Прошло шагов',
} as const;
export const observationLabels = {
  actor_seen: 'Персонаж появился в поле зрения',
  actor_departed: 'Персонаж покинул поле зрения',
  item_taken: 'Предмет взят',
  item_missing: 'Предмет исчез',
  noise: 'Шум',
  helped: 'Получена помощь',
  addressed: 'Обращение к NPC',
  said: 'Произнесена реплика',
} as const;
export function LivingNpcConditions({
  label,
  value,
  onChange,
  entities,
  items,
}: {
  label: string;
  value: NpcCondition[];
  onChange: (value: NpcCondition[]) => void;
  entities: { id: string; label: string }[];
  items: { id: string; label: string }[];
}) {
  const { t } = useT();
  const patch = (index: number, condition: NpcCondition) =>
    onChange(value.map((entry, i) => (i === index ? condition : entry)));
  function initial(kind: NpcCondition['kind']): NpcCondition {
    switch (kind) {
      case 'observed':
        return { kind, event: 'addressed' };
      case 'near_entity':
        return { kind, entityId: entities[0]?.id || '' };
      case 'owns_item':
        return { kind, itemId: items[0]?.id || '' };
      case 'trust_at_least':
        return { kind, minimum: 0 };
      case 'elapsed':
        return { kind, ticks: 20 };
      default:
        return { kind };
    }
  }
  return (
    <fieldset>
      <legend>{label}</legend>
      <p>
        {t('Все условия должны выполняться одновременно. Пустой список не ограничивает действие.')}
      </p>
      {value.map((condition, index) => (
        <div key={index}>
          <Field label={t('Условие {number}', { number: index + 1 })}>
            <Select
              aria-label={t('Условие {number}', { number: index + 1 })}
              value={condition.kind}
              onChange={(event) =>
                patch(index, initial(event.target.value as NpcCondition['kind']))
              }
            >
              {Object.entries(conditionLabels).map(([key, text]) => (
                <option value={key} key={key}>
                  {t(text)}
                </option>
              ))}
            </Select>
          </Field>
          {condition.kind === 'observed' && (
            <>
              <Field label={t('Тип наблюдения')}>
                <Select
                  aria-label={t('Тип наблюдения')}
                  value={condition.event}
                  onChange={(event) =>
                    patch(index, {
                      ...condition,
                      event: event.target.value as typeof condition.event,
                    })
                  }
                >
                  {Object.entries(observationLabels).map(([key, text]) => (
                    <option value={key} key={key}>
                      {t(text)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('Объект условия')}>
                <Select
                  aria-label={t('Объект условия')}
                  value={condition.targetId || ''}
                  onChange={(event) =>
                    patch(index, { ...condition, targetId: event.target.value || undefined })
                  }
                >
                  <option value="">{t('Любой объект')}</option>
                  {entities.map((entity) => (
                    <option key={entity.id} value={entity.id}>
                      {entity.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
          {condition.kind === 'near_entity' && (
            <Field label={t('Объект условия')}>
              <Select
                aria-label={t('Объект условия')}
                value={condition.entityId}
                onChange={(event) => patch(index, { ...condition, entityId: event.target.value })}
              >
                {entities.map((entity) => (
                  <option key={entity.id} value={entity.id}>
                    {entity.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {condition.kind === 'owns_item' && (
            <Field label={t('Предмет условия')}>
              <Select
                aria-label={t('Предмет условия')}
                value={condition.itemId}
                onChange={(event) => patch(index, { ...condition, itemId: event.target.value })}
              >
                {items.map((entity) => (
                  <option key={entity.id} value={entity.id}>
                    {entity.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {condition.kind === 'trust_at_least' && (
            <Field label={t('Порог доверия')}>
              <Input
                type="number"
                min={-5}
                max={5}
                value={condition.minimum}
                onChange={(event) =>
                  patch(index, { ...condition, minimum: Number(event.target.value) })
                }
              />
            </Field>
          )}
          {condition.kind === 'elapsed' && (
            <Field label={t('Количество шагов')}>
              <Input
                type="number"
                min={0}
                max={12000}
                value={condition.ticks}
                onChange={(event) =>
                  patch(index, { ...condition, ticks: Number(event.target.value) })
                }
              />
            </Field>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            {t('Удалить условие')}
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        disabled={value.length >= 4}
        onClick={() => onChange([...value, { kind: 'always' }])}
      >
        {t('Добавить условие')}
      </Button>
    </fieldset>
  );
}
