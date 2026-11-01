'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox } from '../ui';
import { artPreviewUrl } from '../assets/types';
import { formatUsd, liveSessionActive, type LiveTestStatus } from '../live-test/types';
import {
  useGenerationText,
  generationMessages,
  type GenerationMessage,
} from './generation-messages';
import type { GenerationProject, GenerationState } from './generation-types';
import styles from './workshop.module.css';

export function ExternalGeneration({
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
    { locale } = useT();
  const [state, setState] = useState<GenerationState | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [consents, setConsents] = useState<Record<string, boolean>>({}),
    [semantics, setSemantics] = useState<Record<string, boolean>>({}),
    [decline, setDecline] = useState<Record<string, boolean>>({});
  const [uncertain, setUncertain] = useState<string[]>([]),
    [now, setNow] = useState(Date.now());
  const epoch = useRef(0),
    inFlight = useRef(false),
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
        setConsents({});
        setSemantics({});
        setUncertain([]);
      }
    } catch (e) {
      if (stamp === epoch.current) setError(e instanceof ApiError ? e.code : 'NETWORK_ERROR');
    }
  }, [project.id, project.revision]);
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
  useEffect(() => {
    setConsents({});
  }, [session?.sessionId, session?.state]);
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
        setConsents({});
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
  const label = (key: string) => (key in generationMessages ? g(key as GenerationMessage) : key);
  const money = (value: number) => formatUsd(value, locale);
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
      {!allowed && <p role="status">{g('blocked')}</p>}
      {config?.requestProfile && (
        <small>
          {config.requestProfile.provider} · {config.requestProfile.model} ·{' '}
          {config.requestProfile.size} · {config.requestProfile.quality}
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
        const expired = !!quote && Date.parse(quote.expiresAt) <= now,
          quoteKey = `${role}:${quote?.id ?? ''}`;
        const validBound =
            typeof quote?.upperMicros === 'number' &&
            Number.isFinite(quote.upperMicros) &&
            quote.upperMicros >= 0,
          immutable = !!job || !!item?.revisionId || !!item?.dispatchOperationId,
          matches = item?.quote?.matches ?? [];
        return (
          <article key={role} className={styles.generationItem} data-generation-role={role}>
            <h4>{label(role)}</h4>
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
                <p>
                  {g('held')}: {money(job.heldMicros)}
                </p>
                {typeof job.actualMicros === 'number' && (
                  <p>
                    {g('actual')}: {money(job.actualMicros)}
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
                        <label className={styles.check}>
                          <input
                            type="checkbox"
                            checked={!!semantics[match.id]}
                            onChange={(e) =>
                              setSemantics((v) => ({ ...v, [match.id]: e.target.checked }))
                            }
                          />
                          {g('semantic')}
                        </label>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={disabled || busy || !semantics[match.id]}
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
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={!!decline[role]}
                    onChange={(e) => setDecline((v) => ({ ...v, [role]: e.target.checked }))}
                  />
                  {g('declineReuse')}
                </label>
              </div>
            )}
            {!immutable && (
              <Button
                type="button"
                variant="secondary"
                disabled={
                  disabled ||
                  busy ||
                  !allowed ||
                  uncertain.includes(role) ||
                  (matches.length > 0 && !decline[role])
                }
                onClick={() =>
                  void mutate(
                    `/visual-authoring/projects/${project.id}/generation/quote`,
                    {
                      expectedRevision: project.revision,
                      role,
                      ...(decline[role] ? { declineReuse: true } : {}),
                      liveTestSessionId: session?.sessionId,
                    },
                    role,
                  )
                }
              >
                {g('quote')}
              </Button>
            )}
            {quote && !immutable && (
              <div className={styles.quote}>
                <p>
                  {g(validBound ? 'upper' : 'planningEstimate')}:{' '}
                  {typeof quote.upperMicros === 'number'
                    ? money(quote.upperMicros)
                    : typeof quote.estimatedTotalMicros === 'number'
                      ? money(quote.estimatedTotalMicros)
                      : '—'}
                </p>
                {!validBound && (
                  <>
                    <p>{g('noInvoiceCap')}</p>
                    {typeof quote.reserveMicros === 'number' && (
                      <p>
                        {g('operationalReserve')}: {money(quote.reserveMicros)}
                      </p>
                    )}
                  </>
                )}
                <small>
                  {g('expires')}: {new Date(quote.expiresAt).toLocaleString(locale)}
                </small>
                {expired && <p>{g('expired')}</p>}
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={!!consents[quoteKey]}
                    disabled={
                      disabled ||
                      busy ||
                      !allowed ||
                      !validBound ||
                      expired ||
                      quote.mode !== 'external'
                    }
                    onChange={(e) => setConsents((v) => ({ ...v, [quoteKey]: e.target.checked }))}
                  />
                  {g('consent')}
                </label>
                <Button
                  type="button"
                  busy={busy}
                  disabled={
                    disabled ||
                    !allowed ||
                    !validBound ||
                    !consents[quoteKey] ||
                    expired ||
                    quote.mode !== 'external' ||
                    uncertain.includes(role) ||
                    (quote.upperMicros ?? Infinity) > (session?.remainingMicros ?? 0)
                  }
                  onClick={() =>
                    void mutate(
                      `/visual-authoring/projects/${project.id}/generation/dispatch`,
                      {
                        expectedRevision: project.revision,
                        role,
                        quoteId: quote.id,
                        consent: true,
                      },
                      role,
                    )
                  }
                >
                  {g('dispatch')}
                </Button>
              </div>
            )}
          </article>
        );
      })}
      <p>{g('review')}</p>
    </section>
  );
}
