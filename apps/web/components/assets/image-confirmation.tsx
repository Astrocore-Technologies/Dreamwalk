'use client';
import type { ReactNode } from 'react';
import { Button } from '../ui';
import { useImageText } from './image-messages';
/** One explicit decision for this immutable quote, never remembered for another request. */
export function ImageConfirmation({
  children,
  estimated,
  external = true,
  disabled,
  busy,
  onConfirm,
  onCancel,
}: {
  children?: ReactNode;
  estimated: boolean;
  external?: boolean;
  disabled?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const g = useImageText();
  return (
    <section role="group" aria-label={g('confirmTitle')} data-image-confirmation>
      {children}
      <p>{g(external ? 'confirmNotice' : 'consent')}</p>
      {estimated && <p>{g('confirmRisk')}</p>}
      <div className="row">
        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
          {g('cancelQuote')}
        </Button>
        <Button type="button" busy={busy} disabled={disabled} onClick={onConfirm}>
          {g('confirm')}
        </Button>
      </div>
    </section>
  );
}
