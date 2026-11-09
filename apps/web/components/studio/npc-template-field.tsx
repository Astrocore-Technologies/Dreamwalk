'use client';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { Button, Textarea } from '../ui';
import { MarkdownTextarea } from '../markdown';
import {
  authoringText,
  insertNpcTemplate,
  npcAuthoringTemplates,
  templateCopy,
  type NpcTemplateKey,
} from './npc-authoring-templates';
import styles from './npc-template-field.module.css';

export function NpcTemplateField({
  label,
  value,
  onChange,
  maxLength,
  templates,
  disabled = false,
  markdown = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  templates: readonly NpcTemplateKey[];
  disabled?: boolean;
  /** Author prose that readers see formatted; spoken lines stay plain text. */
  markdown?: boolean;
}) {
  const { locale } = useT();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const caret = useRef<number | null>(null);
  const [error, setError] = useState('');
  const text = (copy: readonly [string, string, string]) => authoringText(locale, copy);
  useLayoutEffect(() => {
    if (caret.current === null) return;
    const input = root.current?.querySelector('textarea');
    input?.focus();
    input?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);
  return (
    <div ref={root} className="field">
      <label htmlFor={id}>{label}</label>
      {markdown ? (
        <MarkdownTextarea
          id={id}
          label={label}
          aria-describedby={`${id}-hint ${id}-status`}
          disabled={disabled}
          value={value}
          maxLength={maxLength}
          onChange={(event) => {
            setError('');
            onChange(event.target.value);
          }}
        />
      ) : (
        <Textarea
          id={id}
          aria-describedby={`${id}-hint ${id}-status`}
          disabled={disabled}
          value={value}
          maxLength={maxLength}
          onChange={(event) => {
            setError('');
            onChange(event.target.value);
          }}
        />
      )}
      <div
        className={styles.buttons}
        role="group"
        aria-label={`${text(templateCopy.insert)}: ${label}`}
      >
        {templates.map((key) => {
          const template = npcAuthoringTemplates[key];
          return (
            <Button
              key={key}
              type="button"
              variant="ghost"
              disabled={disabled}
              aria-label={`${text(templateCopy.insert)}: ${text(template.label)}`}
              onClick={() => {
                const input = root.current?.querySelector('textarea');
                if (!input || input.matches(':disabled')) return;
                const next = insertNpcTemplate(
                  value,
                  text(template.text),
                  input.selectionStart,
                  maxLength,
                );
                if (!next) {
                  setError(text(templateCopy.full));
                  return;
                }
                setError('');
                caret.current = next.cursor;
                onChange(next.value);
              }}
            >
              {text(template.label)}
            </Button>
          );
        })}
      </div>
      <small id={`${id}-hint`}>{text(templateCopy.hint)}</small>
      <small id={`${id}-status`} role={error ? 'status' : undefined}>
        {error}
      </small>
    </div>
  );
}
