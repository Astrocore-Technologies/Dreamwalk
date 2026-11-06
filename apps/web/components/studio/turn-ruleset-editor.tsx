'use client';
import { turnRulesSchema, type TurnRules } from '@dreamwalk/contracts';
import { Field, Input } from '../ui';
import { useTurnText } from '../game/turn-messages';
import styles from '../visual-authoring/workshop.module.css';
export function TurnRulesetEditor({
  value,
  onChange,
  disabled = false,
}: {
  value?: TurnRules;
  onChange: (value: TurnRules) => void;
  disabled?: boolean;
}) {
  const text = useTurnText(),
    rules = value ?? turnRulesSchema.parse({});
  const fields = [
    ['vitality', 'vitalitySetting', 1, 100],
    ['hitDamage', 'damageSetting', 1, 20],
    ['pushDistance', 'pushSetting', 1, 2],
  ] as const;
  return (
    <fieldset disabled={disabled} className="stack">
      <legend>{text('rules')}</legend>
      <p>{text('enableRules')}</p>
      <p className="muted">{text('rulesHint')}</p>
      <div className={styles.coordinates}>
        {fields.map(([key, label, min, max]) => (
          <Field key={key} label={text(label)}>
            <Input
              type="number"
              value={rules[key]}
              min={min}
              max={max}
              step={1}
              onChange={(e) => {
                const number = Number(e.target.value);
                if (Number.isInteger(number) && number >= min && number <= max)
                  onChange({ ...rules, [key]: number });
              }}
            />
          </Field>
        ))}
      </div>
    </fieldset>
  );
}
