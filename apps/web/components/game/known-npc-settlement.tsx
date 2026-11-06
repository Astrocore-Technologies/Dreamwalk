'use client';
import { useEffect, useRef, useState } from 'react';
import { formatSparkSubunits } from '@dreamwalk/contracts';
import { api, useClient } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { KnownSettlementController, type SettlementState } from '@/lib/known-npc-settlement';
import { Button, ButtonLink, ErrorBox, PageHeading, Panel } from '../ui';
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
  const controller = useRef<KnownSettlementController | null>(null);
  useEffect(() => {
    let disposed = false;
    let complete = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const instance = new KnownSettlementController({
      ownerId,
      campaignId,
      jobId,
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
  }, [ownerId, campaignId, jobId]);
  const quote = state.quote;
  const legacy = quote?.settlementMode === 'legacy_confirmation';
  const exact = (amount: string) => formatSparkSubunits(amount, locale, 'exact');
  return (
    <div className="stack" data-testid="known-npc-settlement">
      <PageHeading
        title={text.title}
        description={legacy && state.phase !== 'complete' ? text.legacyHint : text.hint}
      />
      <Panel>
        <div className="stack">
          <p>{text.noNew}</p>
          {quote && (legacy || state.phase === 'complete') && (
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
              : state.phase === 'loading'
                ? text.loading
                : state.phase === 'sending'
                  ? text.sending
                  : state.error
                    ? ''
                    : legacy
                      ? text.legacy
                      : quote?.settlementMode === 'automatic'
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
          <div className="row wrap">
            <ButtonLink href="/wallet/settlements" variant="ghost">
              {text.backWallet}
            </ButtonLink>
            <ButtonLink href={`/game/${campaignId}`} variant="ghost">
              {text.back}
            </ButtonLink>
          </div>
        </div>
      </Panel>
    </div>
  );
}
