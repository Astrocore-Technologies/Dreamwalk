'use client';
import { useEffect, useState } from 'react';
import { formatSparkSubunits } from '@dreamwalk/contracts';
import { api, useClient } from '@/lib/client';
import { useT } from '@/lib/i18n';
import {
  readKnownSettlement,
  settlementScope,
  type SettlementState,
} from '@/lib/known-npc-settlement';
import { ButtonLink, ErrorBox, PageHeading, Panel } from '../ui';
import { settlementMessages } from './known-npc-settlement-messages';

export function KnownNpcSettlementPage({
  campaignId,
  jobId,
}: {
  campaignId: string;
  jobId: string;
}) {
  const { user } = useClient();
  if (!user) return null;
  return (
    <SettlementForm
      key={`${user.id}:${campaignId}:${jobId}`}
      ownerId={user.id}
      campaignId={campaignId}
      jobId={jobId}
    />
  );
}
function SettlementForm({
  ownerId,
  campaignId,
  jobId,
}: {
  ownerId: string;
  campaignId: string;
  jobId: string;
}) {
  const { locale } = useT();
  const text = settlementMessages[locale];
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
        const path = settlementScope(ownerId, campaignId, jobId).path;
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
  }, [ownerId, campaignId, jobId]);
  const quote = state.quote;
  const exact = (amount: string) => formatSparkSubunits(amount, locale, 'exact');
  return (
    <div className="stack" data-testid="known-npc-settlement">
      <PageHeading title={text.title} description={text.hint} />
      <Panel>
        <div className="stack">
          <p>{text.noNew}</p>
          {quote && state.phase === 'complete' && (
            <>
              <p>
                {text.reserve}: <strong>{exact(quote.reservedSubunits)}</strong>
              </p>
              <dl className="stack">
                <div>
                  <dt>
                    {text.dreams} · {text.charge}
                  </dt>
                  <dd data-testid="settlement-dreams-charge">
                    {exact(quote.funding.dreamsCaptureSubunits)}
                  </dd>
                </div>
                <div>
                  <dt>
                    {text.sparks} · {text.charge}
                  </dt>
                  <dd data-testid="settlement-sparks-charge">
                    {exact(quote.funding.sparksCaptureSubunits)}
                  </dd>
                </div>
                <div>
                  <dt>
                    {text.dreams} · {text.release}
                  </dt>
                  <dd data-testid="settlement-dreams-release">
                    {exact(quote.funding.dreamsReleaseSubunits)}
                  </dd>
                </div>
                <div>
                  <dt>
                    {text.sparks} · {text.release}
                  </dt>
                  <dd data-testid="settlement-sparks-release">
                    {exact(quote.funding.sparksReleaseSubunits)}
                  </dd>
                </div>
              </dl>
            </>
          )}
          <ErrorBox message={state.error ? text[state.error] : ''} />
          <p role="status" aria-live="polite">
            {state.phase === 'complete'
              ? quote?.status === 'released'
                ? text.released
                : text.complete
              : state.phase === 'uncertain'
                ? text.uncertain
                : text.automatic}
          </p>
          <div className="row wrap">
            <ButtonLink href={`/game/${campaignId}`} variant="ghost">
              {text.back}
            </ButtonLink>
          </div>
        </div>
      </Panel>
    </div>
  );
}
