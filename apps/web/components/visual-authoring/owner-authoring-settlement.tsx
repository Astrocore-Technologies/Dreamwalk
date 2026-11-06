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
    let disposed = false;
    let complete = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const instance = new KnownSettlementController({
      kind: 'authoring',
      ownerId,
      jobId,
      // Delay storage access so automatic read-only recovery does not depend on it.
      storage: {
        getItem: (key) => window.sessionStorage.getItem(key),
        setItem: (key, value) => window.sessionStorage.setItem(key, value),
      },
      operationId: () => crypto.randomUUID(),
      read: (path) => api(path, { cache: 'no-store' }),
      post: (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) }),
      changed: (next) => {
        complete = next.phase === 'complete';
        setState(next);
      },
    });
    controller.current = instance;
    const refresh = async () => {
      await instance.refresh();
      if (!disposed && !complete) timer = setTimeout(() => void refresh(), 5000);
    };
    void refresh();
    return () => {
      disposed = true;
      instance.dispose();
      controller.current = null;
      if (timer) clearTimeout(timer);
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
  const legacy = q?.settlementMode === 'legacy_confirmation';
  const exact = (amount: string) => formatSparkSubunits(amount, locale, 'exact');
  const providerCost = q
    ? `${BigInt(q.actualMicros) / 1000000n}.${(BigInt(q.actualMicros) % 1000000n).toString().padStart(6, '0')}`
    : '';
  return (
    <section className="stack" data-testid="owner-authoring-settlement">
      <h3>{text.title}</h3>
      <p>{legacy && state.phase !== 'complete' ? text.legacyHint : text.hint}</p>
      <p>{text.noNew}</p>
      {q && (legacy || state.phase === 'complete') && (
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
        {state.phase === 'complete'
          ? text.complete
          : state.phase === 'loading'
            ? text.loading
            : state.phase === 'sending'
              ? text.sending
              : state.error
                ? ''
                : legacy
                  ? text.legacy
                  : q?.settlementMode === 'automatic'
                    ? text.automatic
                    : text.unavailable}
      </p>
      {legacy && ['ready', 'uncertain', 'sending', 'loading'].includes(state.phase) && (
        <Button
          type="button"
          busy={state.phase === 'sending'}
          disabled={state.phase === 'sending' || state.phase === 'loading'}
          onClick={() => void controller.current?.confirm()}
        >
          {state.phase === 'uncertain' ? text.retry : text.confirm}
        </Button>
      )}
    </section>
  );
}
