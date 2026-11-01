'use client';
import { useState } from 'react';
import { narrativeConstraintsSchema, type NarrativeConstraints } from '@dreamwalk/contracts';
import { Field, Textarea } from '../ui';
import { useVisualText } from '../visual-authoring/messages';
export function NarrativeControls({
  value,
  onChange,
  disabled,
}: {
  value?: NarrativeConstraints;
  onChange: (v: NarrativeConstraints) => void;
  disabled: boolean;
}) {
  const m = useVisualText(),
    current = value ?? narrativeConstraintsSchema.parse({});
  const [facts, setFacts] = useState(current.protectedFacts.map((f) => f.text).join('\n'));
  const [roles, setRoles] = useState(current.forbiddenRoles.join('\n'));
  return (
    <fieldset disabled={disabled} className="stack">
      <legend>{m('storyConstraints')}</legend>
      <label>
        <input
          type="checkbox"
          checked={current.allowNewScenes}
          onChange={(e) => onChange({ ...current, allowNewScenes: e.target.checked })}
        />{' '}
        {m('newScenes')}
      </label>
      <label>
        <input
          type="checkbox"
          checked={current.allowNewNpcs}
          onChange={(e) => onChange({ ...current, allowNewNpcs: e.target.checked })}
        />{' '}
        {m('newNpcs')}
      </label>
      <Field label={m('protectedFacts')}>
        <Textarea
          maxLength={16000}
          value={facts}
          onChange={(e) => {
            setFacts(e.target.value);
            onChange({
              ...current,
              protectedFacts: e.target.value
                .split('\n')
                .filter((v) => v.trim())
                .slice(0, 16)
                .map((text, i) => ({
                  id: current.protectedFacts[i]?.id ?? `protected-${i}`,
                  text: text.slice(0, 1000),
                })),
            });
          }}
        />
      </Field>
      <Field label={m('forbiddenRoles')}>
        <Textarea
          maxLength={2000}
          value={roles}
          onChange={(e) => {
            setRoles(e.target.value);
            onChange({
              ...current,
              forbiddenRoles: e.target.value
                .split('\n')
                .filter((v) => v.trim())
                .slice(0, 16)
                .map((v) => v.slice(0, 120)),
            });
          }}
        />
      </Field>
    </fieldset>
  );
}
