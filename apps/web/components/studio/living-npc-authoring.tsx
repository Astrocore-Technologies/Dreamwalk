'use client';
import type { AuthoredGameDraft } from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
import { Button, Field, Input, Select, Textarea } from '@/components/ui';
import { LivingNpcConditions } from './living-npc-conditions';
type Npc = AuthoredGameDraft['npcs'][number];
export const goalLabels = {
  patrol: 'Патруль',
  guard: 'Охранять',
  investigate: 'Проверить событие',
  assist: 'Помочь',
} as const;
export const motivationLabels = {
  duty: 'Долг',
  kindness: 'Доброта',
  curiosity: 'Любопытство',
  routine: 'Распорядок',
} as const;
export const disclosureLabels = {
  never: 'Не раскрывать',
  asked: 'Если спросят',
  trusted: 'Только при доверии',
  public: 'Общедоступный факт',
} as const;
export function LivingNpcAuthoring({
  npc,
  entities,
  npcs,
  onChange,
}: {
  npc: Npc;
  entities: AuthoredGameDraft['objects'];
  npcs: AuthoredGameDraft['npcs'];
  onChange: (patch: Partial<Npc>) => void;
}) {
  const { t } = useT();
  const all = [...entities, ...npcs],
    items = entities.filter((entity) => entity.kind === 'item'),
    owned = items.filter((item) => item.ownerNpcId === npc.id);
  const facts = npc.initialFacts || [],
    goals = npc.initialGoals || [],
    promises = npc.promiseTemplates || [];
  const id = () => `auth_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  return (
    <div className="living-npc-profile">
      <fieldset>
        <legend>{t('Именованные знания')}</legend>
        <p>
          {t(
            'Название и текст факта приватны. Только отдельный публичный вопрос появляется у игрока; раскрытие проверяет сервер.',
          )}
        </p>
        {facts.map((fact, index) => (
          <fieldset key={fact.id}>
            <legend>{t('Факт {number}', { number: index + 1 })}</legend>
            <Field label={t('Внутреннее название факта')}>
              <Input
                maxLength={120}
                value={fact.title}
                onChange={(event) =>
                  onChange({
                    initialFacts: facts.map((entry, i) =>
                      i === index ? { ...entry, title: event.target.value } : entry,
                    ),
                  })
                }
              />
            </Field>
            <Field label={t('Текст знания')}>
              <Textarea
                aria-label={t('Текст знания')}
                maxLength={1000}
                value={fact.text}
                onChange={(event) =>
                  onChange({
                    initialFacts: facts.map((entry, i) =>
                      i === index ? { ...entry, text: event.target.value } : entry,
                    ),
                  })
                }
              />
            </Field>
            <Field label={t('Правило раскрытия')}>
              <Select
                aria-label={t('Правило раскрытия')}
                value={fact.disclosure}
                onChange={(event) =>
                  onChange({
                    initialFacts: facts.map((entry, i) =>
                      i === index
                        ? { ...entry, disclosure: event.target.value as typeof fact.disclosure }
                        : entry,
                    ),
                  })
                }
              >
                {Object.entries(disclosureLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {t(label)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('Публичный вопрос')}>
              <Input
                maxLength={120}
                value={fact.publicQuestion || ''}
                onChange={(event) =>
                  onChange({
                    initialFacts: facts.map((entry, i) =>
                      i === index
                        ? { ...entry, publicQuestion: event.target.value || undefined }
                        : entry,
                    ),
                  })
                }
              />
            </Field>
            <Field label={t('Связанный объект')}>
              <Select
                aria-label={t('Связанный объект')}
                value={fact.topicEntityId || ''}
                onChange={(event) =>
                  onChange({
                    initialFacts: facts.map((entry, i) =>
                      i === index
                        ? { ...entry, topicEntityId: event.target.value || undefined }
                        : entry,
                    ),
                  })
                }
              >
                <option value="">{t('Без конкретной темы')}</option>
                {all.map((entity) => (
                  <option key={entity.id} value={entity.id}>
                    {entity.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onChange({ initialFacts: facts.filter((_, i) => i !== index) })}
            >
              {t('Удалить факт')}
            </Button>
          </fieldset>
        ))}
        <Button
          type="button"
          variant="secondary"
          disabled={facts.length >= 16}
          onClick={() =>
            onChange({
              initialFacts: [...facts, { id: id(), title: '', text: '', disclosure: 'never' }],
            })
          }
        >
          {t('Добавить факт')}
        </Button>
      </fieldset>
      <fieldset>
        <legend>{t('Собственные цели NPC')}</legend>
        {goals.map((goal, index) => {
          const patch = (change: Partial<typeof goal>) =>
            onChange({
              initialGoals: goals.map((entry, i) =>
                i === index ? { ...entry, ...change } : entry,
              ),
            });
          return (
            <fieldset key={goal.id}>
              <legend>{t('Цель {number}', { number: index + 1 })}</legend>
              <Field label={t('Тип цели')}>
                <Select
                  aria-label={t('Тип цели')}
                  value={goal.kind}
                  onChange={(event) => patch({ kind: event.target.value as typeof goal.kind })}
                >
                  {Object.entries(goalLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {t(label)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('Отношение к риску')}>
                <Select
                  aria-label={t('Отношение к риску')}
                  value={goal.risk || 'balanced'}
                  onChange={(event) =>
                    patch({ risk: event.target.value as 'cautious' | 'balanced' | 'bold' })
                  }
                >
                  <option value="cautious">{t('Осторожное')}</option>
                  <option value="balanced">{t('Сбалансированное')}</option>
                  <option value="bold">{t('Смелое')}</option>
                </Select>
              </Field>
              <Field label={t('Мотив цели')}>
                <Select
                  aria-label={t('Мотив цели')}
                  value={goal.motivation}
                  onChange={(event) =>
                    patch({ motivation: event.target.value as typeof goal.motivation })
                  }
                >
                  {Object.entries(motivationLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {t(label)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('Приоритет цели')}>
                <Input
                  type="number"
                  min={1}
                  max={5}
                  value={goal.priority}
                  onChange={(event) => patch({ priority: Number(event.target.value) })}
                />
              </Field>
              <Field label={t('Объект цели')}>
                <Select
                  aria-label={t('Объект цели')}
                  value={goal.targetId || ''}
                  onChange={(event) => patch({ targetId: event.target.value || undefined })}
                >
                  <option value="">{t('Не указан')}</option>
                  {(goal.kind === 'assist' ? npcs : all)
                    .filter((entity) => entity.id !== npc.id)
                    .map((entity) => (
                      <option key={entity.id} value={entity.id}>
                        {entity.label}
                      </option>
                    ))}
                </Select>
              </Field>
              {goal.kind === 'assist' && (
                <Field label={t('Предмет для помощи')}>
                  <Select
                    aria-label={t('Предмет для помощи')}
                    value={goal.itemId || ''}
                    onChange={(event) => patch({ itemId: event.target.value || undefined })}
                  >
                    <option value="">{t('Не указан')}</option>
                    {owned.map((entity) => (
                      <option key={entity.id} value={entity.id}>
                        {entity.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label={t('Минимальная длительность цели')}>
                <Input
                  type="number"
                  min={0}
                  max={200}
                  value={goal.holdTicks}
                  onChange={(event) => patch({ holdTicks: Number(event.target.value) })}
                />
              </Field>
              <LivingNpcConditions
                label={t('Когда начинать')}
                value={goal.when}
                onChange={(when) => patch({ when })}
                entities={all}
                items={items}
              />
              <LivingNpcConditions
                label={t('Условия успеха')}
                value={goal.success}
                onChange={(success) => patch({ success })}
                entities={all}
                items={items}
              />
              <LivingNpcConditions
                label={t('Когда отменять')}
                value={goal.cancelWhen}
                onChange={(cancelWhen) => patch({ cancelWhen })}
                entities={all}
                items={items}
              />
              <Field label={t('Запасная цель')}>
                <Select
                  aria-label={t('Запасная цель')}
                  value={goal.fallbackGoalId || ''}
                  onChange={(event) => patch({ fallbackGoalId: event.target.value || undefined })}
                >
                  <option value="">{t('Не указана')}</option>
                  {goals.map(
                    (other, i) =>
                      other.id !== goal.id && (
                        <option key={other.id} value={other.id}>
                          {t('Цель {number}', { number: i + 1 })}
                        </option>
                      ),
                  )}
                </Select>
              </Field>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onChange({ initialGoals: goals.filter((_, i) => i !== index) })}
              >
                {t('Удалить цель')}
              </Button>
            </fieldset>
          );
        })}
        <Button
          type="button"
          variant="secondary"
          disabled={goals.length >= 4}
          onClick={() =>
            onChange({
              initialGoals: [
                ...goals,
                {
                  id: id(),
                  kind: 'patrol',
                  priority: 1,
                  motivation: 'routine',
                  when: [],
                  success: [],
                  cancelWhen: [],
                  holdTicks: 20,
                },
              ],
            })
          }
        >
          {t('Добавить цель')}
        </Button>
      </fieldset>
      <fieldset>
        <legend>{t('Шаблоны обещаний')}</legend>
        {promises.map((promise, index) => {
          const patch = (change: Partial<typeof promise>) =>
            onChange({
              promiseTemplates: promises.map((entry, i) =>
                i === index ? { ...entry, ...change } : entry,
              ),
            });
          return (
            <fieldset key={promise.id}>
              <legend>{t('Обещание {number}', { number: index + 1 })}</legend>
              <Field label={t('Содержание обещания')}>
                <Select
                  aria-label={t('Содержание обещания')}
                  value={promise.promisedAction?.kind || 'give'}
                  onChange={(event) =>
                    patch(
                      event.target.value === 'give'
                        ? { itemId: owned[0]?.id, promisedAction: undefined }
                        : {
                            itemId: undefined,
                            promisedAction: {
                              kind: event.target.value as 'open' | 'inspect',
                              targetId:
                                (event.target.value === 'open'
                                  ? entities.find((entity) => entity.kind === 'door')?.id
                                  : all.find((entity) => entity.id !== npc.id)?.id) || '',
                            },
                          },
                    )
                  }
                >
                  <option value="give">{t('Передать предмет')}</option>
                  <option value="open">{t('Открыть дверь')}</option>
                  <option value="inspect">{t('Осмотреть')}</option>
                </Select>
              </Field>
              {!promise.promisedAction ? (
                <>
                  <Field label={t('Обещаемый предмет')}>
                    <Select
                      aria-label={t('Обещаемый предмет')}
                      value={promise.itemId || ''}
                      onChange={(event) => patch({ itemId: event.target.value })}
                    >
                      {owned.map((entity) => (
                        <option key={entity.id} value={entity.id}>
                          {entity.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </>
              ) : (
                <Field label={t('Объект обещанного действия')}>
                  <Select
                    aria-label={t('Объект обещанного действия')}
                    value={promise.promisedAction.targetId}
                    onChange={(event) =>
                      patch({
                        promisedAction: {
                          ...promise.promisedAction!,
                          targetId: event.target.value,
                        },
                      })
                    }
                  >
                    {(promise.promisedAction.kind === 'open'
                      ? entities.filter((entity) => entity.kind === 'door')
                      : all.filter((entity) => entity.id !== npc.id)
                    ).map((entity) => (
                      <option key={entity.id} value={entity.id}>
                        {entity.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label={t('Когда предлагать')}>
                <Select
                  aria-label={t('Когда предлагать')}
                  value={promise.offerOn}
                  onChange={(event) =>
                    patch({ offerOn: event.target.value as typeof promise.offerOn })
                  }
                >
                  <option value="addressed">{t('Обращение к NPC')}</option>
                  <option value="helped">{t('Получена помощь')}</option>
                </Select>
              </Field>
              <Field label={t('Альтернатива при срыве обещания')}>
                <Select
                  aria-label={t('Альтернатива при срыве обещания')}
                  value={promise.alternativeGoalId || ''}
                  onChange={(event) =>
                    patch({ alternativeGoalId: event.target.value || undefined })
                  }
                >
                  <option value="">{t('Не указана')}</option>
                  {goals.map((goal, i) => (
                    <option key={goal.id} value={goal.id}>
                      {t('Цель {number}', { number: i + 1 })}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('Срок в шагах')}>
                <Input
                  type="number"
                  min={1}
                  max={12000}
                  value={promise.dueTicks}
                  onChange={(event) => patch({ dueTicks: Number(event.target.value) })}
                />
              </Field>
              <label>
                <input
                  type="checkbox"
                  checked={promise.requiresAcceptance}
                  onChange={(event) => patch({ requiresAcceptance: event.target.checked })}
                />
                {t('Требовать согласия игрока')}
              </label>
              <LivingNpcConditions
                label={t('Условия исполнения')}
                value={promise.conditions}
                onChange={(conditions) => patch({ conditions })}
                entities={all}
                items={items}
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  onChange({ promiseTemplates: promises.filter((_, i) => i !== index) })
                }
              >
                {t('Удалить шаблон обещания')}
              </Button>
            </fieldset>
          );
        })}
        <Button
          type="button"
          variant="secondary"
          disabled={promises.length >= 4 || !all.length}
          onClick={() =>
            onChange({
              promiseTemplates: [
                ...promises,
                {
                  id: id(),
                  ...(owned.length
                    ? { itemId: owned[0].id }
                    : {
                        promisedAction: {
                          kind: 'inspect' as const,
                          targetId: all.find((entity) => entity.id !== npc.id)?.id || '',
                        },
                      }),
                  offerOn: 'addressed',
                  conditions: [],
                  dueTicks: 200,
                  requiresAcceptance: true,
                },
              ],
            })
          }
        >
          {t('Добавить шаблон обещания')}
        </Button>
      </fieldset>
    </div>
  );
}
