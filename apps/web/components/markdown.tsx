'use client';
import { Fragment, useId, useState, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { parseMarkdown, type Block, type Inline } from '@/lib/markdown';
import { useT } from '@/lib/i18n';
import { Textarea } from './ui';
import styles from './markdown.module.css';

function inline(nodes: Inline[]): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text':
        return <Fragment key={index}>{node.value}</Fragment>;
      case 'br':
        return <br key={index} />;
      case 'code':
        return <code key={index}>{node.value}</code>;
      case 'strong':
        return <strong key={index}>{inline(node.children)}</strong>;
      case 'em':
        return <em key={index}>{inline(node.children)}</em>;
      case 'link':
        return (
          <a key={index} href={node.href} target="_blank" rel="noopener noreferrer nofollow ugc">
            {inline(node.children)}
          </a>
        );
    }
  });
}
function block(node: Block, index: number): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p key={index}>{inline(node.children)}</p>;
    case 'heading': {
      const Tag = (['h3', 'h4', 'h5'] as const)[node.level - 1];
      return <Tag key={index}>{inline(node.children)}</Tag>;
    }
    case 'list': {
      const Tag = node.ordered ? 'ol' : 'ul';
      return (
        <Tag key={index}>
          {node.items.map((item, i) => (
            <li key={i}>{inline(item)}</li>
          ))}
        </Tag>
      );
    }
    case 'quote':
      return <blockquote key={index}>{node.children.map(block)}</blockquote>;
    case 'rule':
      return <hr key={index} />;
  }
}

/** Renders author text as safe formatted content: text nodes and a fixed element set only. */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`${styles.markdown} ${className}`.trim()}>{parseMarkdown(text).map(block)}</div>
  );
}

/** A textarea with an «edit / preview» switch. The textarea stays mounted so its state is never lost. */
export function MarkdownTextarea({
  value,
  label,
  hint,
  ...props
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value'> & {
  value: string;
  label: string;
  hint?: string;
}) {
  const { t } = useT();
  const id = useId();
  const [preview, setPreview] = useState(false);
  return (
    <div>
      <div className={styles.tabs} role="group" aria-label={`${t('Режим поля')}: ${label}`}>
        <button type="button" aria-selected={!preview} onClick={() => setPreview(false)}>
          {t('Редактирование')}
        </button>
        <button type="button" aria-selected={preview} onClick={() => setPreview(true)}>
          {t('Предпросмотр')}
        </button>
      </div>
      <Textarea
        {...props}
        value={value}
        hidden={preview}
        style={preview ? { display: 'none' } : props.style}
      />
      {preview && (
        <div
          className={styles.preview}
          data-testid="markdown-preview"
          role="region"
          aria-label={`${t('Предпросмотр')}: ${label}`}
        >
          {value.trim() ? (
            <Markdown text={value} />
          ) : (
            <span className={styles.empty}>{t('Нечего показывать.')}</span>
          )}
        </div>
      )}
      {hint && <small>{hint}</small>}
      <small id={`${id}-markdown`}>
        {t('Можно использовать Markdown: **жирный**, *курсив*, - список, # заголовок.')}
      </small>
    </div>
  );
}

/** A labelled author text field with Markdown support (label linked to the textarea). */
export function MarkdownField({
  label,
  hint,
  id,
  ...props
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value'> & {
  label: string;
  hint?: string;
  value: string;
}) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <div className="field">
      <label htmlFor={fieldId}>{label}</label>
      <MarkdownTextarea {...props} id={fieldId} label={label} hint={hint} />
    </div>
  );
}
