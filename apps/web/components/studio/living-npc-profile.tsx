'use client';
import type { AuthoredGameDraft } from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
import { LivingNpcExamples } from './living-npc-examples';
import { Field, Select, Textarea } from '@/components/ui';

type Npc = AuthoredGameDraft['npcs'][number];
type Personality = NonNullable<Npc['personality']>;
export const publicStyleLabels = {
  neutral: 'Нейтральная',
  warm: 'Тёплая',
  formal: 'Официальная',
  terse: 'Лаконичная',
  wry: 'Ироничная',
} as const;
const roleLabels = { guard: 'Смотритель', helper: 'Помощник', patrol: 'Патруль' };
const valueLabels = {
  duty: 'Долг',
  kindness: 'Доброта',
  caution: 'Осторожность',
  honesty: 'Честность',
};
const tabooLabels = {
  steal: 'Не красть',
  harm: 'Не причинять вред',
  disclose_private: 'Не разглашать тайны',
  share_rumors: 'Не распространять слухи',
  give_valuables: 'Не отдавать ценности',
  lock_doors: 'Не запирать двери',
};
export function LivingNpcProfile({
  npc,
  onChange,
  entities,
  npcs,
  onKnowledge,
}: {
  npc: Npc;
  onChange: (profile: Personality) => void;
  entities: { id: string; label: string }[];
  npcs: { id: string; label: string }[];
  onKnowledge: (knowledge: NonNullable<Npc['initialKnowledge']>) => void;
}) {
  const { t } = useT();
  const profile: Personality = npc.personality ?? {
    role: npc.goal === 'help' ? 'helper' : 'guard',
    values: ['duty'],
    taboos: ['steal', 'disclose_private'],
    speechStyle: '',
  };
  return (
    <fieldset className="living-npc-profile">
      <legend>{t('Характер и обязанности NPC')}</legend>
      <Field label={t('Профиль поведения')}>
        <Select
          aria-label={t('Профиль поведения')}
          value={profile.behaviorProfile || 'green-apple'}
          onChange={(event) =>
            onChange({
              ...profile,
              behaviorProfile: event.target.value as 'green-apple' | 'cookie',
            })
          }
        >
          <option value="green-apple">{t('Green Apple')}</option>
          <option value="cookie">{t('Cookie')}</option>
        </Select>
      </Field>
      <Field label={t('Роль NPC')}>
        <Select
          aria-label={t('Роль NPC')}
          value={profile.role}
          onChange={(e) => onChange({ ...profile, role: e.target.value as Personality['role'] })}
        >
          {Object.entries(roleLabels).map(([key, label]) => (
            <option key={key} value={key}>
              {t(label)}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset>
        <legend>{t('Ценности')}</legend>
        {Object.entries(valueLabels).map(([key, label]) => {
          const value = key as Personality['values'][number],
            checked = profile.values.includes(value);
          return (
            <label key={key}>
              <input
                type="checkbox"
                checked={checked}
                disabled={checked && profile.values.length === 1}
                onChange={(e) =>
                  onChange({
                    ...profile,
                    values: e.target.checked
                      ? [...profile.values, value]
                      : profile.values.filter((v) => v !== value),
                  })
                }
              />
              {t(label)}
            </label>
          );
        })}
      </fieldset>
      <fieldset>
        <legend>{t('Границы поведения')}</legend>
        {Object.entries(tabooLabels).map(([key, label]) => {
          const value = key as Personality['taboos'][number];
          return (
            <label key={key}>
              <input
                type="checkbox"
                checked={profile.taboos.includes(value)}
                onChange={(e) =>
                  onChange({
                    ...profile,
                    taboos: e.target.checked
                      ? [...profile.taboos, value]
                      : profile.taboos.filter((v) => v !== value),
                  })
                }
              />
              {t(label)}
            </label>
          );
        })}
      </fieldset>
      <LivingNpcExamples profile={profile} onChange={onChange} npcId={npc.id} npcs={npcs} />
      <Field label={t('Биография и мотивы')}>
        <Textarea
          aria-label={t('Биография и мотивы')}
          maxLength={2000}
          value={profile.biography || ''}
          onChange={(event) => onChange({ ...profile, biography: event.target.value })}
        />
      </Field>
      <fieldset>
        <legend>{t('Начальные знания')}</legend>
        <p>
          {t(
            'Знание объекта не даёт всеведения о его будущих перемещениях. Условия раскрытия проверяет сервер.',
          )}
        </p>
        {entities.map((entity) => {
          const known = npc.initialKnowledge?.find((entry) => entry.entityId === entity.id);
          return (
            <div key={entity.id}>
              <label>
                <input
                  type="checkbox"
                  checked={!!known}
                  disabled={!known && (npc.initialKnowledge?.length || 0) >= 16}
                  onChange={(event) =>
                    onKnowledge(
                      event.target.checked
                        ? [
                            ...(npc.initialKnowledge || []),
                            { entityId: entity.id, revealCondition: 'never' },
                          ]
                        : (npc.initialKnowledge || []).filter(
                            (entry) => entry.entityId !== entity.id,
                          ),
                    )
                  }
                />
                {entity.label}
              </label>
              {known && (
                <Select
                  aria-label={t('Условие раскрытия для {name}', { name: entity.label })}
                  value={known.revealCondition}
                  onChange={(event) =>
                    onKnowledge(
                      (npc.initialKnowledge || []).map((entry) =>
                        entry.entityId === entity.id
                          ? {
                              ...entry,
                              revealCondition: event.target.value as typeof known.revealCondition,
                            }
                          : entry,
                      ),
                    )
                  }
                >
                  <option value="never">{t('Не раскрывать')}</option>
                  <option value="asked">{t('Если спросят')}</option>
                  <option value="trusted">{t('Только при доверии')}</option>
                </Select>
              )}
            </div>
          );
        })}
      </fieldset>
      <Field label={t('Публичная манера речи')}>
        <Select
          aria-label={t('Публичная манера речи')}
          value={profile.publicSpeechStyle || 'neutral'}
          onChange={(event) =>
            onChange({
              ...profile,
              publicSpeechStyle: event.target.value as NonNullable<
                Personality['publicSpeechStyle']
              >,
            })
          }
        >
          {Object.entries(publicStyleLabels).map(([key, label]) => (
            <option key={key} value={key}>
              {t(label)}
            </option>
          ))}
        </Select>
      </Field>
      <p>
        {t(
          'Публичный стиль можно передавать генератору реплик. Произвольные заметки ниже остаются частными данными планировщика.',
        )}
      </p>
      <Field label={t('Частные заметки о манере речи')}>
        <Textarea
          aria-label={t('Частные заметки о манере речи')}
          maxLength={200}
          value={profile.speechStyle}
          onChange={(e) => onChange({ ...profile, speechStyle: e.target.value })}
        />
      </Field>
      <p>{t('Характер направляет выбор NPC, но не отменяет правила мира и права доступа.')}</p>
    </fieldset>
  );
}
