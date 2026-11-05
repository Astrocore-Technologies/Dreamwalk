'use client';
import { useEffect, useRef, useState } from 'react';
import { formatSparkSubunits } from '@dreamwalk/contracts';
import { api, useClient } from '@/lib/client';
import { useT } from '@/lib/i18n';
import {
  authoringSettlementScope,
  readKnownSettlement,
  type SettlementState,
} from '@/lib/known-npc-settlement';
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
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      let complete = false;
      try {
        const path = authoringSettlementScope(ownerId, jobId).path;
        const quote = readKnownSettlement(await api(path, { cache: 'no-store' }), jobId);
        complete = quote.status !== 'pending';
        if (!disposed) setState({ quote, phase: complete ? 'complete' : 'ready', error: null });
      } catch {
        if (!disposed) setState({ quote: null, phase: 'uncertain', error: 'uncertain' });
      }
      if (!disposed && !complete) timer = setTimeout(() => void refresh(), 5000);
    };
    void refresh();
    return () => {
      disposed = true;
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
  const exact = (amount: string) => formatSparkSubunits(amount, locale, 'exact');
  const providerCost = q
    ? `${BigInt(q.actualMicros) / 1000000n}.${(BigInt(q.actualMicros) % 1000000n).toString().padStart(6, '0')}`
    : '';
  return (
    <section className="stack" data-testid="owner-authoring-settlement">
      <h3>{text.title}</h3>
      <p>{text.hint}</p>
      <p>{text.noNew}</p>
      {q && state.phase === 'complete' && (
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
      <p role="status" aria-live="polite">
        {state.phase === 'complete'
          ? text.complete
          : state.phase === 'uncertain'
            ? text.uncertain
            : text.automatic}
      </p>
    </section>
  );
}
