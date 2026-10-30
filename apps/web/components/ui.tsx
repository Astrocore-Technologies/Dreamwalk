'use client';
import { useT } from '@/lib/i18n';
import Link from 'next/link';
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  type SelectHTMLAttributes,
} from 'react';
import { ArrowRight, Compass, LoaderCircle, Upload, X } from 'lucide-react';
import { api, errorMessage, type Asset } from '@/lib/client';
export function Button({
  children,
  variant = 'primary',
  busy,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  busy?: boolean;
}) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <button
      {...props}
      disabled={props.disabled || busy || !hydrated}
      className={`button ${variant} ${props.className || ''}`}
    >
      {busy && <LoaderCircle className="spin" size={16} />} {children}
    </button>
  );
}
export function ButtonLink({
  children,
  href,
  variant = 'primary',
}: {
  children: ReactNode;
  href: string;
  variant?: string;
}) {
  return (
    <Link className={`button ${variant}`} href={href}>
      {children}
    </Link>
  );
}
export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </header>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { t } = useT();
  return (
    <input
      {...props}
      onInvalid={(e) => {
        e.currentTarget.setCustomValidity(
          t(
            e.currentTarget.validity.valueMissing
              ? 'Заполни это поле.'
              : 'Проверь формат и длину введённого значения.',
          ),
        );
        props.onInvalid?.(e);
      }}
      onInput={(e) => {
        e.currentTarget.setCustomValidity('');
        props.onInput?.(e);
      }}
      className={`input ${props.className || ''}`}
    />
  );
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { t } = useT();
  return (
    <textarea
      rows={4}
      {...props}
      onInvalid={(e) =>
        e.currentTarget.setCustomValidity(t('Проверь формат и длину введённого значения.'))
      }
      onInput={(e) => e.currentTarget.setCustomValidity('')}
      className={`input ${props.className || ''}`}
    />
  );
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`input ${props.className || ''}`} />;
}
export function ErrorBox({ message, retry }: { message?: string; retry?: () => void }) {
  const { t: tr } = useT();
  return message ? (
    <div className="error-box" role="alert">
      {message}
      {retry && (
        <Button variant="ghost" onClick={retry}>
          {tr('Повторить')}
        </Button>
      )}
    </div>
  ) : null;
}
export function Loading() {
  const { t: tr } = useT();
  return (
    <div className="skeleton-set" aria-label={tr('Загрузка')} role="status">
      <div className="skeleton" />
      <div className="skeleton" />
      <div className="skeleton" />
    </div>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Compass size={32} />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{children}</section>;
}
export function Tabs({ items }: { items: { href: string; label: string; active?: boolean }[] }) {
  const { t: tr } = useT();
  return (
    <nav className="tabs" aria-label={tr('Разделы страницы')}>
      {items.map((item) => (
        <Link key={item.href} href={item.href} className={item.active ? 'active' : ''}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const { t: tr } = useT();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      aria-label={title}
      ref={ref}
      className="dialog"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-header">
        <h2>{title}</h2>
        <button className="icon-button" aria-label={tr('Закрыть')} onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
export function UploadField({
  onUploaded,
  label,
}: {
  onUploaded: (asset: Asset) => void;
  label?: string;
}) {
  const { t: tr } = useT();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <div>
      <label className="button secondary upload-button">
        <Upload size={16} />
        {busy ? tr('Загружаем…') : (label ?? tr('Загрузить изображение'))}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true);
            setError('');
            try {
              const form = new FormData();
              form.append('file', file);
              onUploaded(await api<Asset>('/assets', { method: 'POST', body: form }));
            } catch (error) {
              setError(errorMessage(error));
            } finally {
              setBusy(false);
              e.target.value = '';
            }
          }}
        />
      </label>
      <small className="muted">{tr('PNG, JPEG или WebP · до 5 МБ')}</small>
      <ErrorBox message={error} />
    </div>
  );
}
export function MoreLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-link">
      {children}
      <ArrowRight size={16} />
    </Link>
  );
}
