'use client';
import type { NpcPersonality } from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
import { Button, Field, Input, Select } from '@/components/ui';
export const habitLabels = {
  observe_before_acting: 'Сначала наблюдать',
  keep_promises: 'Держать обещания',
  share_warnings: 'Передавать предупреждения',
} as const;
export const relationLabels = { ally: 'Союзник', rival: 'Соперник', mentor: 'Наставник' } as const;
export function LivingNpcExamples({
  profile,
  onChange,
  npcId,
  npcs,
}: {
  profile: NpcPersonality;
  onChange: (value: NpcPersonality) => void;
  npcId: string;
  npcs: { id: string; label: string }[];
}) {
  const { t } = useT();
  return (
    <>
      <fieldset>
        <legend>{t('Привычки')}</legend>
        {Object.entries(habitLabels).map(([key, label]) => {
          const habit = key as NonNullable<NpcPersonality['habits']>[number];
          return (
            <label key={key}>
              <input
                type="checkbox"
                checked={profile.habits?.includes(habit) || false}
                onChange={(event) =>
                  onChange({
                    ...profile,
                    habits: event.target.checked
                      ? [...(profile.habits || []), habit]
                      : (profile.habits || []).filter((value) => value !== habit),
                  })
                }
              />
              {t(label)}
            </label>
          );
        })}
      </fieldset>
      <fieldset>
        <legend>{t('Примеры решений')}</legend>
        <p>
          {t(
            'Это частные авторские примеры характера, а не команды движку и не готовые реплики для всех игроков.',
          )}
        </p>
        {profile.decisionExamples?.map((example, index) => (
          <div key={index}>
            <Field label={t('Ситуация {number}', { number: index + 1 })}>
              <Input
                aria-label={t('Ситуация {number}', { number: index + 1 })}
                maxLength={240}
                value={example.situation}
                onChange={(event) =>
                  onChange({
                    ...profile,
                    decisionExamples: profile.decisionExamples?.map((entry, i) =>
                      i === index ? { ...entry, situation: event.target.value } : entry,
                    ),
                  })
                }
              />
            </Field>
            <Field label={t('Решение {number}', { number: index + 1 })}>
              <Input
                aria-label={t('Решение {number}', { number: index + 1 })}
                maxLength={240}
                value={example.response}
                onChange={(event) =>
                  onChange({
                    ...profile,
                    decisionExamples: profile.decisionExamples?.map((entry, i) =>
                      i === index ? { ...entry, response: event.target.value } : entry,
                    ),
                  })
                }
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                onChange({
                  ...profile,
                  decisionExamples: profile.decisionExamples?.filter((_, i) => i !== index),
                })
              }
            >
              {t('Удалить пример {number}', { number: index + 1 })}
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          disabled={(profile.decisionExamples?.length || 0) >= 4}
          onClick={() =>
            onChange({
              ...profile,
              decisionExamples: [
                ...(profile.decisionExamples || []),
                { situation: '', response: '' },
              ],
            })
          }
        >
          {t('Добавить пример решения')}
        </Button>
      </fieldset>
      <fieldset>
        <legend>{t('Важные связи')}</legend>
        <p>{t('Связи относятся к NPC этой версии, а не к скрытой истории игроков.')}</p>
        {npcs
          .filter((npc) => npc.id !== npcId)
          .map((npc) => {
            const link = profile.links?.find((entry) => entry.npcId === npc.id);
            return (
              <div key={npc.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={!!link}
                    disabled={!link && (profile.links?.length || 0) >= 4}
                    onChange={(event) =>
                      onChange({
                        ...profile,
                        links: event.target.checked
                          ? [...(profile.links || []), { npcId: npc.id, relation: 'ally' }]
                          : (profile.links || []).filter((entry) => entry.npcId !== npc.id),
                      })
                    }
                  />
                  {npc.label}
                </label>
                {link && (
                  <Select
                    aria-label={t('Связь с {name}', { name: npc.label })}
                    value={link.relation}
                    onChange={(event) =>
                      onChange({
                        ...profile,
                        links: profile.links?.map((entry) =>
                          entry.npcId === npc.id
                            ? { ...entry, relation: event.target.value as typeof link.relation }
                            : entry,
                        ),
                      })
                    }
                  >
                    {Object.entries(relationLabels).map(([key, label]) => (
                      <option key={key} value={key}>
                        {t(label)}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
            );
          })}
      </fieldset>
    </>
  );
}
