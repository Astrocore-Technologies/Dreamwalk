'use client';
import { useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/client';
import { Button, Field, Input, Select, ErrorBox } from '../ui';
import { useLocationInlineText } from './location-inline-messages';
export function ImageRejectionRecovery({
  jobId,
  requestId,
  onRecovered,
}: {
  jobId: string;
  requestId: string;
  onRecovered: () => void;
}) {
  const m = useLocationInlineText();
  const [source, setSource] = useState('provider_usage'),
    [reference, setReference] = useState(''),
    [cost, setCost] = useState(''),
    [attested, setAttested] = useState(false),
    [review, setReview] = useState<{ fingerprint: string } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [reconciliationRequired, setReconciliationRequired] = useState(false);
  const operation = useRef(crypto.randomUUID()),
    lock = useRef(false);
  const actualMicros = /^(0|[1-9]\d*)(\.\d{1,6})?$/.test(cost)
    ? Math.round(Number(cost) * 1e6)
    : NaN;
  const valid =
    !reconciliationRequired &&
    attested &&
    reference.trim().length >= 3 &&
    Number.isSafeInteger(actualMicros) &&
    actualMicros >= 0;
  function invalidate() {
    setReview(null);
    operation.current = crypto.randomUUID();
  }
  async function submit(mode: 'review' | 'apply') {
    if (!valid || lock.current || (mode === 'apply' && !review)) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ status: string; fingerprint?: string }>(
        `/image-generation/jobs/${jobId}/recover-model-rejection`,
        {
          method: 'POST',
          body: JSON.stringify({
            mode,
            operationId: operation.current,
            ...(mode === 'apply' ? { expectedFingerprint: review!.fingerprint } : {}),
            evidence: {
              source,
              reference: reference.trim(),
              requestId,
              actualMicros,
              chargeVerified: true,
              modelAccessRestored: true,
            },
          }),
        },
      );
      if (result.status === 'recovered') {
        setReview(null);
        setAttested(false);
        onRecovered();
      } else if (result.fingerprint) setReview({ fingerprint: result.fingerprint });
    } catch (e) {
      setError(errorMessage(e));
      setReview(null);
      // Never resend an uncertain mutation. Reopen/refresh GET status first.
      if (mode === 'apply') {
        setAttested(false);
        setReconciliationRequired(true);
        try {
          const result = await api<{ status: string }>(`/image-generation/jobs/${jobId}/recovery`);
          if (result.status === 'recovered') onRecovered();
          else setReconciliationRequired(false);
        } catch {
          setError(m('stopped'));
        }
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>{m('recovery')}</summary>
      <p>{m('recoveryHelp')}</p>
      <code>{requestId}</code>
      <ErrorBox message={error} />
      <Field label={m('evidenceSource')}>
        <Select
          value={source}
          disabled={busy}
          onChange={(e) => {
            setSource(e.target.value);
            invalidate();
          }}
        >
          <option value="provider_usage">{m('usage')}</option>
          <option value="provider_support">{m('support')}</option>
        </Select>
      </Field>
      <Field label={m('evidenceReference')}>
        <Input
          maxLength={160}
          value={reference}
          disabled={busy}
          onChange={(e) => {
            setReference(e.target.value);
            invalidate();
          }}
        />
      </Field>
      <Field label={m('actualCost')}>
        <Input
          inputMode="decimal"
          value={cost}
          disabled={busy}
          onChange={(e) => {
            setCost(e.target.value);
            invalidate();
          }}
        />
      </Field>
      <label>
        <input
          type="checkbox"
          checked={attested}
          disabled={busy}
          onChange={(e) => {
            setAttested(e.target.checked);
            invalidate();
          }}
        />
        {m('proof')}
      </label>
      {review && <p>{m('recoveryReviewed')}</p>}
      <Button
        type="button"
        busy={busy}
        disabled={!valid}
        onClick={() => void submit(review ? 'apply' : 'review')}
      >
        {m(review ? 'applyRecovery' : 'reviewRecovery')}
      </Button>
    </details>
  );
}
