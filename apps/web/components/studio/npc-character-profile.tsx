'use client';
import type { Npc } from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
import { Button, Field, Input, Select, Textarea } from '../ui';
import { characterText, type CharacterCopyKey } from './npc-character-copy';

type Profile = NonNullable<Npc['characterProfile']>;
type Personality = Profile['personality'];
type Characterization = NonNullable<Personality['characterization']>;
const values = ['duty', 'kindness', 'caution', 'honesty'] as const;
const taboos = [
  'steal',
  'harm',
  'disclose_private',
  'share_rumors',
  'give_valuables',
  'lock_doors',
] as const;
const habits = ['observe_before_acting', 'keep_promises', 'share_warnings'] as const;
const motives = ['protect', 'belong', 'discover', 'prosper', 'duty', 'care'] as const;
const triggers = ['threat', 'help', 'betrayal', 'request', 'uncertainty'] as const;
const responses = ['observe', 'assist', 'warn', 'withdraw', 'refuse'] as const;
const stances = ['reserved', 'friendly', 'firm', 'guarded'] as const;
const situations = ['greeting', 'thanks', 'refusal', 'danger'] as const;
const defaultCharacterization = (): Characterization => ({
  version: 1,
  motives: [{ kind: 'duty', priority: 3 }],
  reactions: [],
  publicVoice: { cadence: 'balanced', register: 'plain', humor: 'none' },
  dialogueExamples: [],
});
export function newCharacterProfile(): Profile {
  return {
    version: 1,
    initialGoal: 'patrol',
    personality: {
      role: 'guard',
      values: ['duty'],
      taboos: ['steal', 'disclose_private'],
      speechStyle: '',
      characterization: defaultCharacterization(),
    },
  };
}
export function NpcCharacterProfile({
  value,
  onChange,
}: {
  value: Npc['characterProfile'];
  onChange: (next: Npc['characterProfile']) => void;
}) {
  const { locale } = useT();
  const text = (key: CharacterCopyKey) => characterText(locale, key);
  const profile = value;
  const personality = profile?.personality;
  const c = personality?.characterization ?? defaultCharacterization();
  const setPersonality = (next: Personality) =>
    profile && onChange({ ...profile, personality: next });
  const setCharacterization = (next: Characterization) =>
    personality && setPersonality({ ...personality, characterization: next });
  const options = (keys: readonly CharacterCopyKey[]) =>
    keys.map((key) => (
      <option key={key} value={key}>
        {text(key)}
      </option>
    ));
  return (
    <fieldset className="stack" data-testid="npc-character-profile">
      <legend>{text('profile')}</legend>
      <label>
        <input
          type="checkbox"
          checked={!!profile}
          onChange={(event) => onChange(event.target.checked ? newCharacterProfile() : null)}
        />{' '}
        {text('enable')}
      </label>
      <p className="muted">{text('legacy')}</p>
      {profile && personality && (
        <>
          <p className="notice">{text('private')}</p>
          <div className="field-grid">
            <Field label={text('initialGoal')}>
              <Select
                aria-label={text('initialGoal')}
                value={profile.initialGoal}
                onChange={(event) =>
                  onChange({
                    ...profile,
                    initialGoal: event.target.value as Profile['initialGoal'],
                  })
                }
              >
                {options(['patrol', 'help'])}
              </Select>
            </Field>
            <Field label={text('role')}>
              <Select
                aria-label={text('role')}
                value={personality.role}
                onChange={(event) =>
                  setPersonality({
                    ...personality,
                    role: event.target.value as Personality['role'],
                  })
                }
              >
                {options(['guard', 'helper', 'patrol'])}
              </Select>
            </Field>
          </div>
          <fieldset>
            <legend>{text('values')}</legend>
            {values.map((kind) => (
              <label key={kind} className="row">
                <input
                  type="checkbox"
                  checked={personality.values.includes(kind)}
                  disabled={personality.values.length === 1 && personality.values.includes(kind)}
                  onChange={(event) =>
                    setPersonality({
                      ...personality,
                      values: event.target.checked
                        ? [...personality.values, kind]
                        : personality.values.filter((v) => v !== kind),
                    })
                  }
                />
                {text(kind)}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>{text('taboos')}</legend>
            {taboos.map((kind) => (
              <label key={kind} className="row">
                <input
                  type="checkbox"
                  checked={personality.taboos.includes(kind)}
                  onChange={(event) =>
                    setPersonality({
                      ...personality,
                      taboos: event.target.checked
                        ? [...personality.taboos, kind]
                        : personality.taboos.filter((v) => v !== kind),
                    })
                  }
                />
                {text(kind)}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>{text('habits')}</legend>
            {habits.map((kind) => (
              <label key={kind} className="row">
                <input
                  type="checkbox"
                  checked={personality.habits?.includes(kind) ?? false}
                  onChange={(event) =>
                    setPersonality({
                      ...personality,
                      habits: event.target.checked
                        ? [...(personality.habits ?? []), kind]
                        : personality.habits?.filter((v) => v !== kind),
                    })
                  }
                />
                {text(kind)}
              </label>
            ))}
          </fieldset>
          <fieldset className="stack">
            <legend>{text('motives')}</legend>
            {c.motives.map((entry, index) => (
              <div className="row" key={index}>
                <Field label={`${text('motive')} ${index + 1}`}>
                  <Select
                    aria-label={`${text('motive')} ${index + 1}`}
                    value={entry.kind}
                    onChange={(event) =>
                      setCharacterization({
                        ...c,
                        motives: c.motives.map((v, i) =>
                          i === index ? { ...v, kind: event.target.value as typeof entry.kind } : v,
                        ),
                      })
                    }
                  >
                    {motives.map((kind) => (
                      <option
                        key={kind}
                        value={kind}
                        disabled={kind !== entry.kind && c.motives.some((v) => v.kind === kind)}
                      >
                        {text(kind)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={`${text('priority')} ${index + 1}`}>
                  <Input
                    aria-label={`${text('priority')} ${index + 1}`}
                    type="number"
                    min={1}
                    max={5}
                    value={entry.priority}
                    onChange={(event) =>
                      setCharacterization({
                        ...c,
                        motives: c.motives.map((v, i) =>
                          i === index ? { ...v, priority: Number(event.target.value) } : v,
                        ),
                      })
                    }
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`${text('remove')} ${text('motive')} ${index + 1}`}
                  disabled={c.motives.length <= 1}
                  onClick={() =>
                    setCharacterization({ ...c, motives: c.motives.filter((_, i) => i !== index) })
                  }
                >
                  {text('remove')}
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              disabled={c.motives.length >= 4}
              onClick={() => {
                const kind = motives.find((kind) => !c.motives.some((v) => v.kind === kind));
                if (kind)
                  setCharacterization({ ...c, motives: [...c.motives, { kind, priority: 3 }] });
              }}
            >
              {text('addMotive')}
            </Button>
          </fieldset>
          <fieldset className="stack">
            <legend>{text('reactions')}</legend>
            {c.reactions.map((entry, index) => (
              <div className="stack" key={index}>
                <div className="field-grid">
                  <Field label={`${text('trigger')} ${index + 1}`}>
                    <Select
                      aria-label={`${text('trigger')} ${index + 1}`}
                      value={entry.trigger}
                      onChange={(event) =>
                        setCharacterization({
                          ...c,
                          reactions: c.reactions.map((v, i) =>
                            i === index
                              ? { ...v, trigger: event.target.value as typeof entry.trigger }
                              : v,
                          ),
                        })
                      }
                    >
                      {triggers.map((kind) => (
                        <option
                          key={kind}
                          value={kind}
                          disabled={
                            kind !== entry.trigger && c.reactions.some((v) => v.trigger === kind)
                          }
                        >
                          {text(kind === 'help' ? 'helpEvent' : kind)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={`${text('response')} ${index + 1}`}>
                    <Select
                      aria-label={`${text('response')} ${index + 1}`}
                      value={entry.response}
                      onChange={(event) =>
                        setCharacterization({
                          ...c,
                          reactions: c.reactions.map((v, i) =>
                            i === index
                              ? { ...v, response: event.target.value as typeof entry.response }
                              : v,
                          ),
                        })
                      }
                    >
                      {options(responses)}
                    </Select>
                  </Field>
                  <Field label={`${text('stance')} ${index + 1}`}>
                    <Select
                      aria-label={`${text('stance')} ${index + 1}`}
                      value={entry.publicStance}
                      onChange={(event) =>
                        setCharacterization({
                          ...c,
                          reactions: c.reactions.map((v, i) =>
                            i === index
                              ? {
                                  ...v,
                                  publicStance: event.target.value as typeof entry.publicStance,
                                }
                              : v,
                          ),
                        })
                      }
                    >
                      {options(stances)}
                    </Select>
                  </Field>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`${text('remove')} ${text('response')} ${index + 1}`}
                  onClick={() =>
                    setCharacterization({
                      ...c,
                      reactions: c.reactions.filter((_, i) => i !== index),
                    })
                  }
                >
                  {text('remove')}
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              disabled={c.reactions.length >= triggers.length}
              onClick={() => {
                const trigger = triggers.find(
                  (trigger) => !c.reactions.some((v) => v.trigger === trigger),
                );
                if (trigger)
                  setCharacterization({
                    ...c,
                    reactions: [
                      ...c.reactions,
                      { trigger, response: 'observe', publicStance: 'reserved' },
                    ],
                  });
              }}
            >
              {text('addReaction')}
            </Button>
          </fieldset>
          <fieldset className="stack">
            <legend>{text('voice')}</legend>
            <div className="field-grid">
              <Field label={text('cadence')}>
                <Select
                  aria-label={text('cadence')}
                  value={c.publicVoice.cadence}
                  onChange={(event) =>
                    setCharacterization({
                      ...c,
                      publicVoice: {
                        ...c.publicVoice,
                        cadence: event.target.value as Characterization['publicVoice']['cadence'],
                      },
                    })
                  }
                >
                  {options(['brief', 'balanced', 'elaborate'])}
                </Select>
              </Field>
              <Field label={text('register')}>
                <Select
                  aria-label={text('register')}
                  value={c.publicVoice.register}
                  onChange={(event) =>
                    setCharacterization({
                      ...c,
                      publicVoice: {
                        ...c.publicVoice,
                        register: event.target.value as Characterization['publicVoice']['register'],
                      },
                    })
                  }
                >
                  {options(['plain', 'formal', 'colloquial'])}
                </Select>
              </Field>
              <Field label={text('humor')}>
                <Select
                  aria-label={text('humor')}
                  value={c.publicVoice.humor}
                  onChange={(event) =>
                    setCharacterization({
                      ...c,
                      publicVoice: {
                        ...c.publicVoice,
                        humor: event.target.value as Characterization['publicVoice']['humor'],
                      },
                    })
                  }
                >
                  {options(['none', 'dry', 'playful'])}
                </Select>
              </Field>
            </div>
            <p className="muted">{text('voiceHint')}</p>
            {c.dialogueExamples.map((entry, index) => (
              <div className="stack" key={index}>
                <Field label={`${text('situation')} ${index + 1}`}>
                  <Select
                    aria-label={`${text('situation')} ${index + 1}`}
                    value={entry.situation}
                    onChange={(event) =>
                      setCharacterization({
                        ...c,
                        dialogueExamples: c.dialogueExamples.map((v, i) =>
                          i === index
                            ? { ...v, situation: event.target.value as typeof entry.situation }
                            : v,
                        ),
                      })
                    }
                  >
                    {options(situations)}
                  </Select>
                </Field>
                <Field label={`${text('line')} ${index + 1}`}>
                  <Textarea
                    aria-label={`${text('line')} ${index + 1}`}
                    maxLength={240}
                    value={entry.text}
                    onChange={(event) =>
                      setCharacterization({
                        ...c,
                        dialogueExamples: c.dialogueExamples.map((v, i) =>
                          i === index ? { ...v, text: event.target.value } : v,
                        ),
                      })
                    }
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`${text('remove')} ${text('line')} ${index + 1}`}
                  onClick={() =>
                    setCharacterization({
                      ...c,
                      dialogueExamples: c.dialogueExamples.filter((_, i) => i !== index),
                    })
                  }
                >
                  {text('remove')}
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              disabled={c.dialogueExamples.length >= 4}
              onClick={() =>
                setCharacterization({
                  ...c,
                  dialogueExamples: [...c.dialogueExamples, { situation: 'greeting', text: '' }],
                })
              }
            >
              {text('addExample')}
            </Button>
          </fieldset>
        </>
      )}
    </fieldset>
  );
}
