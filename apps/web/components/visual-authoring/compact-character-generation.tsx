'use client';
import { ImageQuotePrice } from '../assets/image-quote-price';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, useClient } from '@/lib/client';
import { Button, ErrorBox, Modal } from '../ui';
import { artPreviewUrl, type ArtRevision } from '../assets/types';
import { useImageText } from '../assets/image-messages';
import { generationRemaining, liveSessionActive, type LiveTestStatus } from '../live-test/types';
import { SparkReceiptCost } from './sparks-cost';
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
import { GenerationProgress } from './generation-progress';
import styles from './workshop.module.css';

/** Character editing has one quote→consent action and one free, owned-library action. */
export function CompactCharacterGeneration({
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
    { user } = useClient();
  const [state, setState] = useState<GenerationState | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [now, setNow] = useState(Date.now()),
    [libraryRole, setLibraryRole] = useState<string | null>(null),
    [library, setLibrary] = useState<ArtRevision[] | null>(null),
    [uncertain, setUncertain] = useState<string[]>([]);
  const active = useRef(true),
    lock = useRef(false),
    readLock = useRef(false),
    readEpoch = useRef(0),
    libraryEpoch = useRef(0),
    epoch = useRef(0),
    operations = useRef(new Map<string, string>()),
    callbacks = useRef({ onStateChange, onBusyChange });
  callbacks.current = { onStateChange, onBusyChange };
  const identity = `${user?.id}:${project.id}:${project.revision}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const accepts = (stamp: number, owner: string) =>
    active.current && stamp === epoch.current && currentIdentity.current === owner;
  async function refresh() {
    if (readLock.current) return;
    readLock.current = true;
    const stamp = epoch.current,
      read = ++readEpoch.current,
      owner = identity;
    try {
      const next = await api<GenerationState>(
        `/visual-authoring/projects/${project.id}/generation`,
      );
      if (accepts(stamp, owner) && read === readEpoch.current) {
        const scoped = { ...next, projectRevision: project.revision };
        setState(scoped);
        callbacks.current.onStateChange(scoped);
      }
    } catch (e) {
      if (accepts(stamp, owner) && read === readEpoch.current)
        setError(e instanceof ApiError ? e.code : 'NETWORK_ERROR');
    } finally {
      if (read === readEpoch.current) readLock.current = false;
    }
  }
  useEffect(() => {
    active.current = true;
    epoch.current++;
    readEpoch.current++;
    readLock.current = false;
    libraryEpoch.current++;
    callbacks.current.onBusyChange(false);
    setBusy(false);
    setState(null);
    setLibraryRole(null);
    setLibrary(null);
    setError('');
    setUncertain([]);
    operations.current.clear();
    callbacks.current.onStateChange(null);
    void refresh();
    const timer = setInterval(() => {
      setNow(Date.now());
      if (!lock.current) void refresh();
    }, 2000);
    return () => {
      active.current = false;
      epoch.current++;
      clearInterval(timer);
    };
  }, [identity]);
  async function mutate(path: string, body: object, role: string) {
    if (disabled || lock.current) return;
    lock.current = true;
    readEpoch.current++;
    readLock.current = false;
    setBusy(true);
    callbacks.current.onBusyChange(true);
    setError('');
    const stamp = epoch.current,
      owner = identity,
      key = JSON.stringify({ path, body });
    if (!operations.current.has(key)) operations.current.set(key, crypto.randomUUID());
    try {
      await api(path, {
        method: 'POST',
        body: JSON.stringify({ ...body, operationId: operations.current.get(key) }),
      });
      if (accepts(stamp, owner)) {
        if (path.endsWith('/quote')) operations.current.delete(key);
        setLibraryRole(null);
        await refresh();
      }
    } catch (e) {
      if (accepts(stamp, owner)) {
        setError(e instanceof ApiError ? e.code : 'NETWORK_ERROR');
        if (path.endsWith('/dispatch') && (!(e instanceof ApiError) || !e.status))
          setUncertain((current) => [...new Set([...current, role])]);
      }
    } finally {
      lock.current = false;
      if (accepts(stamp, owner)) {
        setBusy(false);
        callbacks.current.onBusyChange(false);
      }
    }
  }
  async function openLibrary(role: string) {
    if (disabled || lock.current) return;
    const stamp = epoch.current,
      lease = ++libraryEpoch.current,
      owner = identity;
    setLibraryRole(role);
    setLibrary(null);
    setError('');
    try {
      const revisions = await api<ArtRevision[]>('/asset-library');
      if (accepts(stamp, owner) && lease === libraryEpoch.current)
        setLibrary(revisions.filter((revision) => revision.owned && revision.canReuse));
    } catch (e) {
      if (accepts(stamp, owner) && lease === libraryEpoch.current) {
        setLibrary([]);
        setError(e instanceof ApiError ? e.code : 'NETWORK_ERROR');
      }
    }
  }
  const config = state?.configuration;
  const current = state?.projectId === project.id && state?.projectRevision === project.revision;
  const allowed =
    !!config?.externalEnabled && !!session?.imagesEnabled && liveSessionActive(session, now);
  const roles = [
    ...new Set([...(state?.requiredRoles ?? []), ...(state?.items.map((item) => item.role) ?? [])]),
  ];
  const label = (key: string) => (key in generationMessages ? g(key as GenerationMessage) : key);
  const compatible = (revision: ArtRevision, role: string) =>
    revision.metadata.style === 'drawn2D' &&
    revision.metadata.kind === (role === 'portrait' ? 'portrait' : 'sprite') &&
    (revision.metadata.camera === 'top-down' ||
      (role === 'portrait' && revision.metadata.camera === 'portrait'));
  return (
    <section
      className={styles.generation}
      aria-label={g('characterArtwork')}
      data-testid="external-generation"
      data-compact-generation
    >
      <ErrorBox message={error ? `${g('failure')} (${error})` : ''} />
      {!allowed && <p role="status">{g('releaseBlocked')}</p>}
      {!state && <p role="status">{g('loadingArtwork')}</p>}
      {roles.map((role) => {
        const item = state?.items.find((value) => value.role === role),
          quote = item?.quote?.quote,
          job = item?.job;
        const immutable = !!job || !!item?.revisionId || !!item?.dispatchOperationId;
        const estimated =
          (session?.mode === 'owner' || session?.mode === 'release') &&
          ownerImageQuoteMatches(quote, config, session);
        const validBound =
          typeof quote?.upperMicros === 'number' &&
          Number.isSafeInteger(quote.upperMicros) &&
          quote.upperMicros >= 0 &&
          quote.upperMicros === config?.verifiedUpperMicros;
        const fresh =
          current &&
          !!quote &&
          Number.isFinite(Date.parse(quote.expiresAt)) &&
          Date.parse(quote.expiresAt) > now &&
          quote.mode === 'external' &&
          (validBound || estimated);
        const referenceRequired =
          (session?.mode === 'owner' || session?.mode === 'release') &&
          config?.requestProfile?.maxReferenceImages === 0 &&
          role !== 'concept';
        const reserve = estimated ? quote?.reserveMicros : quote?.upperMicros;
        const blocked =
          disabled || busy || !current || !allowed || referenceRequired || uncertain.includes(role);
        return (
          <article key={role} className={styles.generationItem} data-generation-role={role}>
            <h4>{label(role)}</h4>
            {item?.url && artPreviewUrl(item.url) && (
              <img
                className={styles.generationPreview}
                src={artPreviewUrl(item.url)}
                alt={label(role)}
              />
            )}
            {job && (
              <>
                <GenerationProgress status={job.status} />
                {['cancelled', 'expired', 'rejected'].includes(job.status) && (
                  <p role="status">
                    {job.status === 'expired' ? g('jobExpired') : label(job.status)}
                  </p>
                )}
                {job.sparkStatus && <SparkReceiptCost receipt={{ ...job, generationCost: null }} />}
                {job.errorCode && (
                  <p role="status">
                    {g('failure')} ({job.errorCode})
                  </p>
                )}
                {(job.status === 'unknown' || job.diagnostic?.billing === 'unknown') && (
                  <p role="status">{g('checkingOutcome')}</p>
                )}
              </>
            )}
            {(uncertain.includes(role) || !!item?.dispatchOperationId) && !job && (
              <p role="status">{g('checkingOutcome')}</p>
            )}
            {referenceRequired && !immutable && <p>{g('ownerReferenceStage')}</p>}
            {!immutable && (
              <>
                {fresh && quote && (
                  <div className={styles.quote} data-compact-quote>
                    <ImageQuotePrice quote={quote} />
                    <small>{g('generateConsent')}</small>
                    {estimated && <small>{g('estimateNotice')}</small>}
                  </div>
                )}
                {!!quote && !fresh && <small>{g('expired')}</small>}
                <div className="row">
                  <Button
                    type="button"
                    busy={busy}
                    aria-busy={busy}
                    disabled={
                      blocked ||
                      (fresh && (reserve ?? Infinity) > generationRemaining(session, 'image'))
                    }
                    onClick={() => {
                      if (blocked || lock.current) return;
                      if (fresh && quote) {
                        if (
                          !Number.isFinite(Date.parse(quote.expiresAt)) ||
                          Date.parse(quote.expiresAt) <= Date.now() ||
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
                            ...(estimated ? { estimateRiskConsent: true } : {}),
                          },
                          role,
                        );
                      } else
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
                        );
                    }}
                  >
                    {fresh ? g('generate') : imageText('quote')}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={disabled || busy || !current || uncertain.includes(role)}
                    onClick={() => void openLibrary(role)}
                  >
                    {g('takeFromLibrary')}
                  </Button>
                </div>
              </>
            )}
          </article>
        );
      })}
      {libraryRole && (
        <Modal
          title={g('takeFromLibrary')}
          onClose={() => {
            libraryEpoch.current++;
            setLibraryRole(null);
          }}
        >
          <ErrorBox message={error ? `${g('failure')} (${error})` : ''} />
          <p>{g('candidateNote')}</p>
          <p>{g('semantic')}</p>
          {library === null ? (
            <p role="status">{g('loadingArtwork')}</p>
          ) : library.filter((revision) => compatible(revision, libraryRole)).length === 0 ? (
            <p>{g('emptyOwnedLibrary')}</p>
          ) : (
            library
              .filter((revision) => compatible(revision, libraryRole))
              .map((revision) => (
                <div key={revision.id} className={styles.generationItem}>
                  {artPreviewUrl(revision.url) && (
                    <img
                      className={styles.candidatePreview}
                      src={artPreviewUrl(revision.url)}
                      alt={revision.metadata.title}
                    />
                  )}
                  <strong>{revision.metadata.title}</strong>
                  <Button
                    type="button"
                    busy={busy}
                    aria-busy={busy}
                    disabled={disabled || busy || !current}
                    onClick={() =>
                      void mutate(
                        `/visual-authoring/projects/${project.id}/generation/reuse`,
                        {
                          expectedRevision: project.revision,
                          role: libraryRole,
                          revisionId: revision.id,
                          semanticReview: true,
                        },
                        libraryRole,
                      )
                    }
                  >
                    {g('selectArtwork')}
                  </Button>
                </div>
              ))
          )}
        </Modal>
      )}
    </section>
  );
}
