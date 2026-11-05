'use client';
import { useEffect, useRef, useState } from 'react';
import { formatSparkSubunits } from '@dreamwalk/contracts';
import { api, useClient } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { KnownSettlementController, type SettlementState } from '@/lib/known-npc-settlement';
import { Button, ErrorBox } from '../ui';
import { authoringSettlementMessages } from './owner-authoring-settlement-messages';

export function OwnerAuthoringSettlement({
  jobId,
  onSettled,
}: {
  jobId: string;
  onSettled?: () => void;
}) {
  const { user } = useClient();
  if (!user) return null;
  return (
    <SettlementForm
      key={`${user.id}:${jobId}`}
      ownerId={user.id}
      jobId={jobId}
      onSettled={onSettled}
    />
  );
}
function SettlementForm({
  ownerId,
  jobId,
  onSettled,
}: {
  ownerId: string;
  jobId: string;
  onSettled?: () => void;
}) {
  const { locale } = useT();
  const text = authoringSettlementMessages[locale];
  const [state, setState] = useState<SettlementState>({
    quote: null,
    phase: 'loading',
    error: null,
  });
  const controller = useRef<KnownSettlementController | null>(null);
  useEffect(() => {
    let instance: KnownSettlementController | undefined;
    try {
      instance = new KnownSettlementController({
        kind: 'authoring',
        ownerId,
        jobId,
        storage: window.sessionStorage,
        operationId: () => crypto.randomUUID(),
        read: (path) => api(path, { cache: 'no-store' }),
        post: (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) }),
        changed: setState,
      });
      controller.current = instance;
      void instance.refresh();
    } catch {
      setState({ quote: null, phase: 'error', error: 'storage' });
    }
    return () => {
      instance?.dispose();
      controller.current = null;
    };
  }, [ownerId, jobId]);
  const notified = useRef(false);
  useEffect(() => {
    if (state.phase === 'complete' && !notified.current) {
      notified.current = true;
      onSettled?.();
    }
  }, [state.phase, onSettled]);
  const q = state.quote;
  const busy = state.phase === 'loading' || state.phase === 'sending';
  const exact = (amount: string) => formatSparkSubunits(amount, locale, 'exact');
  const providerCost = q
    ? `${BigInt(q.actualMicros) / 1000000n}.${(BigInt(q.actualMicros) % 1000000n).toString().padStart(6, '0')}`
    : '';
  return (
    <section className="stack" data-testid="owner-authoring-settlement">
      <h3>{text.title}</h3>
      <p>{text.hint}</p>
      <p>{text.noNew}</p>
      {q && (
        <dl className="stack">
          <div>
            <dt>{text.providerCost}</dt>
            <dd data-testid="authoring-provider-cost">{providerCost}</dd>
          </div>
          <div>
            <dt>{text.reserve}</dt>
            <dd>{exact(q.reservedSubunits)}</dd>
          </div>
          <div>
            <dt>
              {text.dreams} · {state.phase === 'complete' ? text.charged : text.charge}
            </dt>
            <dd data-testid="authoring-dreams-charge">{exact(q.funding.dreamsCaptureSubunits)}</dd>
          </div>
          <div>
            <dt>
              {text.sparks} · {state.phase === 'complete' ? text.charged : text.charge}
            </dt>
            <dd data-testid="authoring-sparks-charge">{exact(q.funding.sparksCaptureSubunits)}</dd>
          </div>
          <div>
            <dt>
              {text.dreams} · {text.release}
            </dt>
            <dd>{exact(q.funding.dreamsReleaseSubunits)}</dd>
          </div>
          <div>
            <dt>
              {text.sparks} · {text.release}
            </dt>
            <dd data-testid="authoring-sparks-release">{exact(q.funding.sparksReleaseSubunits)}</dd>
          </div>
        </dl>
      )}
      <ErrorBox message={state.error ? text[state.error] : ''} />
      <p role="status" aria-live="polite">
        {state.phase === 'loading'
          ? text.loading
          : state.phase === 'sending'
            ? text.sending
            : state.phase === 'complete'
              ? text.complete
              : ''}
      </p>
      <div className="row wrap">
        {['ready', 'uncertain', 'sending'].includes(state.phase) && (
          <Button
            type="button"
            busy={state.phase === 'sending'}
            disabled={busy}
            onClick={() => void controller.current?.confirm()}
          >
            {state.phase === 'uncertain' ? text.retry : text.confirm}
          </Button>
        )}
        {state.phase !== 'complete' && (
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => void controller.current?.refresh()}
          >
            {text.refresh}
          </Button>
        )}
      </div>
    </section>
  );
}
