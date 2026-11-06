'use client';
import { imageQualityLabel, imageSizeLabel } from '@/lib/generation-labels';
import { ImageQuotePrice } from '../assets/image-quote-price';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, useClient } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { useSparkCosts, SparkReceiptCost } from './sparks-cost';
import { ImageConfirmation } from '../assets/image-confirmation';
import { useImageText } from '../assets/image-messages';
import { Button, ErrorBox } from '../ui';
import { artPreviewUrl } from '../assets/types';
import { generationRemaining, liveSessionActive, type LiveTestStatus } from '../live-test/types';
import {
  useGenerationText,
  generationMessages,
  type GenerationMessage,
} from './generation-messages';
import {
  ownerImageQuoteMatches,
  type GenerationProject,
  type GenerationState,
} from './generation-types';
import styles from './workshop.module.css';
import { CompactCharacterGeneration } from './compact-character-generation';
import { GenerationProgress } from './generation-progress';

type ExternalGenerationProps = {
  project: GenerationProject;
  session: LiveTestStatus | null;
  disabled: boolean;
  onStateChange: (value: GenerationState | null) => void;
  onBusyChange: (value: boolean) => void;
  compactActions?: boolean;
};
export function ExternalGeneration(props: ExternalGenerationProps) {
  return props.compactActions ? (
    <CompactCharacterGeneration key={`${props.project.id}:${props.project.revision}`} {...props} />
  ) : (
    <FullExternalGeneration {...props} />
  );
}
function FullExternalGeneration({
  project,
  session,
  disabled,
  onStateChange,
  onBusyChange,
}: {
  project: GenerationProject;
  session: LiveTestStatus | null;
  disabled: boolean;
  onStateChange: (value: GenerationState | null) => void;
  onBusyChange: (value: boolean) => void;
}) {
  const g = useGenerationText(),
    imageText = useImageText(),
    { s, amount: money } = useSparkCosts(),
    { locale } = useT(),
    { user } = useClient();
  const [state, setState] = useState<GenerationState | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  const [uncertain, setUncertain] = useState<string[]>([]),
    [now, setNow] = useState(Date.now());
  const epoch = useRef(0),
    inFlight = useRef(false),
    cancelledQuotes = useRef(new Set<string>()),
    operations = useRef(new Map<string, string>());
  const refresh = useCallback(async () => {
    const stamp = ++epoch.current;
    try {
      const next = await api<GenerationState>(
        `/visual-authoring/projects/${project.id}/generation`,
      );
      if (stamp === epoch.current) {
        setState({ ...next, projectRevision: project.revision });
        setError('');
        setUncertain([]);
        setDismissed({});
        cancelledQuotes.current.clear();
      }
    } catch (e) {
      if (stamp === epoch.current) setError(e instanceof ApiError ? e.code : 'NETWORK_ERROR');
    }
  }, [project.id, project.revision, user?.id]);
  useEffect(() => {
    void refresh();
    return () => {
      epoch.current++;
    };
  }, [refresh]);
  useEffect(() => {
    onStateChange(state);
  }, [state, onStateChange]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function mutate(path: string, body: object, role: string) {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    onBusyChange(true);
    setError('');
    const stamp = epoch.current,
      key = JSON.stringify({ path, body });
    if (!operations.current.has(key)) operations.current.set(key, crypto.randomUUID());
    try {
      await api(path, {
        method: 'POST',
        body: JSON.stringify({ ...body, operationId: operations.current.get(key) }),
      });
      if (stamp === epoch.current) {
        if (path.endsWith('/quote')) operations.current.delete(key);
        await refresh();
      }
    } catch (e) {
      if (stamp === epoch.current) {
        setError(e instanceof ApiError ? e.code : 'NETWORK_ERROR');
        if (!(e instanceof ApiError) || !e.status) setUncertain((v) => [...v, role]);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }
  const config = state?.configuration,
    allowed =
      !!config?.externalEnabled && !!session?.imagesEnabled && liveSessionActive(session, now);
  const ownerReferencesUnavailable =
    (session?.mode === 'owner' || session?.mode === 'release') &&
    config?.requestProfile?.maxReferenceImages === 0;
  const label = (key: string) => (key in generationMessages ? g(key as GenerationMessage) : key);
  const roles = [
    ...new Set([...(state?.requiredRoles ?? []), ...(state?.items.map((item) => item.role) ?? [])]),
  ];
  return (
    <section
      className={styles.generation}
      aria-label={g('stages')}
      data-testid="external-generation"
    >
      <h3>{g('stages')}</h3>
      <p>{g('manual')}</p>
      {ownerReferencesUnavailable && <p role="status">{g('ownerReferencesUnavailable')}</p>}
      {!allowed && (
        <p role="status">
          {g(
            session?.mode === 'release'
              ? 'releaseBlocked'
              : session?.mode === 'owner'
                ? 'ownerBlocked'
                : 'blocked',
          )}
        </p>
      )}
      {user?.role === 'admin' && config?.requestProfile && (
        <small>
          {config.requestProfile.provider} · {config.requestProfile.model} ·{' '}
          {imageSizeLabel(locale, config.requestProfile.size)} ·{' '}
          {imageQualityLabel(locale, config.requestProfile.quality)}
        </small>
      )}
      {config?.externalBlockReasons?.map((code) => (
        <small key={code}>
          <code>{code}</code>
        </small>
      ))}
      <ErrorBox message={error ? `${g('failure')} (${error})` : ''} />
      <Button
        type="button"
        variant="secondary"
        disabled={disabled || busy}
        onClick={() => void refresh()}
      >
        {g('refresh')}
      </Button>
      {roles.map((role) => {
        const item = state?.items.find((entry) => entry.role === role),
          quote = item?.quote?.quote,
          job = item?.job;
        const expired =
            !!quote &&
            (!Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= now),
          quoteKey = `${role}:${quote?.id ?? ''}`;
        const referenceRequired =
          ownerReferencesUnavailable &&
          (project.kind === 'character'
            ? role !== 'concept'
            : role !== 'background' &&
              !!state?.items.some((item) => item.role === 'background' && !!item.revisionId));
        const validBound =
            typeof quote?.upperMicros === 'number' &&
            Number.isSafeInteger(quote.upperMicros) &&
            quote.upperMicros >= 0 &&
            quote.upperMicros === config?.verifiedUpperMicros,
          estimatedQuote =
            (session?.mode === 'owner' || session?.mode === 'release') &&
            ownerImageQuoteMatches(quote, config, session),
          dispatchableCost = validBound || estimatedQuote,
          reserve = estimatedQuote ? quote?.reserveMicros : quote?.upperMicros,
          immutable = !!job || !!item?.revisionId || !!item?.dispatchOperationId,
          matches = item?.quote?.matches ?? [];
        return (
          <article key={role} className={styles.generationItem} data-generation-role={role}>
            <h4>{label(role)}</h4>
            {referenceRequired && <p role="status">{g('ownerReferenceStage')}</p>}
            <p>{label(item?.status ?? 'idle')}</p>
            {item?.url && artPreviewUrl(item.url) && (
              <img
                className={styles.generationPreview}
                src={artPreviewUrl(item.url)}
                alt={label(role)}
              />
            )}
            {item?.validation && (
              <>
                <p>{g(item.validation.valid ? 'valid' : 'invalid')}</p>
                {item.validation.code && <code>{item.validation.code}</code>}
                <small>
                  {item.validation.width} × {item.validation.height}
                  {item.validation.nonemptyFrames !== undefined
                    ? ` · ${item.validation.nonemptyFrames}/24`
                    : ''}
                </small>
              </>
            )}
            {job && (
              <>
                <GenerationProgress status={job.status} />
                {job.sparkStatus && (
                  <p>
                    <SparkReceiptCost receipt={{ ...job, generationCost: null }} />
                  </p>
                )}
                {!job.sparkStatus && (
                  <p>
                    {s('reserve')}: {money(job.heldMicros)}
                  </p>
                )}
                {!job.sparkStatus && typeof job.actualMicros === 'number' && (
                  <p>
                    {s('actual')}: {money(job.actualMicros)}
                  </p>
                )}
                {job.errorCode && <code>{job.errorCode}</code>}
                {job.diagnostic && (
                  <small>
                    {g('httpStatus')}: {job.diagnostic.httpStatus}
                  </small>
                )}
                {(job.status === 'unknown' || job.diagnostic?.billing === 'unknown') && (
                  <p role="status">{g('unknown')}</p>
                )}
                {job.canCancel && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={disabled || busy}
                    onClick={() => void mutate(`/image-generation/jobs/${job.id}/cancel`, {}, role)}
                  >
                    {g('cancelJob')}
                  </Button>
                )}
              </>
            )}
            {uncertain.includes(role) && <p role="status">{g('unknown')}</p>}
            {!immutable && matches.length > 0 && (
              <div className={styles.candidates}>
                <h5>{g('candidates')}</h5>
                <p>{g('candidateNote')}</p>
                {matches.map((match) => (
                  <div key={match.id} className={styles.generationItem}>
                    {artPreviewUrl(match.url) && (
                      <img
                        className={styles.candidatePreview}
                        src={artPreviewUrl(match.url)}
                        alt={match.metadata.title}
                      />
                    )}
                    <strong>{match.metadata.title}</strong>
                    {match.owned && match.canReuse && (
                      <>
                        <p>{g('semantic')}</p>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={disabled || busy}
                          onClick={() =>
                            void mutate(
                              `/visual-authoring/projects/${project.id}/generation/reuse`,
                              {
                                expectedRevision: project.revision,
                                role,
                                revisionId: match.id,
                                semanticReview: true,
                              },
                              role,
                            )
                          }
                        >
                          {g('reuse')}
                        </Button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
            {!immutable && (
              <>
                <small>{imageText('quoteRights')}</small>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    disabled || busy || !allowed || referenceRequired || uncertain.includes(role)
                  }
                  onClick={() =>
                    void mutate(
                      `/visual-authoring/projects/${project.id}/generation/quote`,
                      {
                        expectedRevision: project.revision,
                        role,
                        declineReuse: true,
                        automaticKnownCostPolicy: 'known-cost-v1',
                        liveTestSessionId:
                          session?.mode === 'release'
                            ? undefined
                            : (session?.sessionId ?? undefined),
                      },
                      role,
                    )
                  }
                >
                  {imageText('quote')}
                </Button>
              </>
            )}
            {quote && !immutable && !dismissed[quoteKey] && (
              <div className={styles.quote}>
                <ImageQuotePrice quote={quote} />
                <small>
                  {g('expires')}: {new Date(quote.expiresAt).toLocaleString(locale)}
                </small>
                {expired && <p>{g('expired')}</p>}
                <ImageConfirmation
                  walletCharging={!!quote.sparks?.walletCharging}
                  estimated={quote.upperMicros === null}
                  busy={busy}
                  disabled={
                    disabled ||
                    !allowed ||
                    referenceRequired ||
                    !dispatchableCost ||
                    expired ||
                    quote.mode !== 'external' ||
                    uncertain.includes(role) ||
                    (reserve ?? Infinity) > generationRemaining(session, 'image')
                  }
                  onCancel={() => {
                    cancelledQuotes.current.add(quoteKey);
                    setDismissed((current) => ({ ...current, [quoteKey]: true }));
                  }}
                  onConfirm={() => {
                    if (
                      disabled ||
                      inFlight.current ||
                      cancelledQuotes.current.has(quoteKey) ||
                      Date.parse(quote.expiresAt) <= Date.now() ||
                      !allowed ||
                      referenceRequired ||
                      !dispatchableCost ||
                      expired ||
                      quote.mode !== 'external' ||
                      uncertain.includes(role) ||
                      (reserve ?? Infinity) > generationRemaining(session, 'image')
                    )
                      return;
                    void mutate(
                      `/visual-authoring/projects/${project.id}/generation/dispatch`,
                      {
                        expectedRevision: project.revision,
                        role,
                        quoteId: quote.id,
                        consent: true,
                        ...(quote.automaticKnownCostSettlement
                          ? {
                              automaticKnownCostPolicyHash:
                                quote.automaticKnownCostSettlement.fingerprint,
                            }
                          : {}),
                        ...(estimatedQuote ? { estimateRiskConsent: true } : {}),
                      },
                      role,
                    );
                  }}
                />
              </div>
            )}
          </article>
        );
      })}
      <p>{g('review')}</p>
    </section>
  );
}
