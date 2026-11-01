'use client';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, useClient } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Modal } from '../ui';
import { GenerationResponseScope, formatUsd } from './types';
import { useLiveText, type LiveMessage } from './messages';
import {
  validPendingPolicyApply,
  policyRetryMatches,
  type PolicyApply,
  type PolicyPricing,
  type PolicyProfile,
  type PolicyReceipt,
  type PolicyReview,
} from './owner-policy-types';
import styles from './owner-policy-review.module.css';

function PolicyComparison({
  current,
  proposed,
}: {
  current: PolicyProfile | null;
  proposed: PolicyProfile | null;
}) {
  const m = useLiveText(),
    { locale } = useT();
  const money = (value: number | undefined) =>
    typeof value === 'number' && Number.isFinite(value)
      ? formatUsd(value, locale)
      : m('reserveUnavailable');
  const date = (value: string | undefined) =>
    value && Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString(locale)
      : m('reserveUnavailable');
  const evidence = (value: PolicyPricing | undefined) =>
    value ? (
      <>
        <span>{value.source}</span>
        <br />
        {m('policyReviewed')}: {date(value.reviewedAt)}
        <br />
        {m('policyValidUntil')}: {date(value.validUntil)}
      </>
    ) : (
      m('reserveUnavailable')
    );
  const rows: { key: string; label: string; read: (p: PolicyProfile | null) => React.ReactNode }[] =
    [
      { key: 'total', label: m('cap'), read: (p) => money(p?.totalCapMicros) },
      { key: 'textCap', label: m('policyTextCap'), read: (p) => money(p?.textCapMicros) },
      { key: 'imageCap', label: m('policyImageCap'), read: (p) => money(p?.imageCapMicros) },
      ...(['text', 'image'] as const).flatMap((kind) => {
        const prefix = m(kind === 'text' ? 'policyText' : 'policyImage') + ' · ';
        return [
          {
            key: kind + 'estimator',
            label: prefix + m('policyEstimator'),
            read: (p: PolicyProfile | null) =>
              p?.[kind].estimation ? (
                <details>
                  <summary>{m('policyEstimator')}</summary>
                  <pre>{JSON.stringify(p[kind].estimation, null, 2)}</pre>
                </details>
              ) : (
                m('reserveLegacy')
              ),
          },
          {
            key: kind + 'model',
            label: prefix + m('policyModel'),
            read: (p: PolicyProfile | null) => p?.[kind].model ?? m('reserveUnavailable'),
          },
          {
            key: kind + 'evidence',
            label: prefix + m('policyEvidence'),
            read: (p: PolicyProfile | null) => evidence(p?.[kind].pricing),
          },
        ];
      }),
      {
        key: 'inputRate',
        label: m('policyText') + ' · ' + m('policyInputRate'),
        read: (p) => money(p?.text.inputMicrosPerMillion),
      },
      {
        key: 'outputRate',
        label: m('policyText') + ' · ' + m('policyOutputRate'),
        read: (p) => money(p?.text.outputMicrosPerMillion),
      },
      {
        key: 'context',
        label: m('policyContext'),
        read: (p) => p?.text.contextTokens ?? m('reserveUnavailable'),
      },
      {
        key: 'outputTokens',
        label: m('policyOutputTokens'),
        read: (p) => p?.text.maxOutputTokens ?? m('reserveUnavailable'),
      },
      {
        key: 'inputBytes',
        label: m('policyInputBytes'),
        read: (p) => p?.text.maxInputBytes ?? m('reserveUnavailable'),
      },
      {
        key: 'imageProfile',
        label: m('policyImageProfile'),
        read: (p) =>
          p
            ? [p.image.size, p.image.quality, p.image.outputs].join(' / ')
            : m('reserveUnavailable'),
      },
      {
        key: 'references',
        label: m('policyReferences'),
        read: (p) => p?.image.maxReferenceImages ?? m('reserveUnavailable'),
      },
      {
        key: 'imageTextRate',
        label: m('policyImage') + ' · ' + m('policyInputRate'),
        read: (p) => money(p?.image.inputTextMicrosPerMillion),
      },
      {
        key: 'imageInputRate',
        label: m('policyImageInputRate'),
        read: (p) => money(p?.image.inputImageMicrosPerMillion),
      },
      {
        key: 'imageOutputRate',
        label: m('policyImage') + ' · ' + m('policyOutputRate'),
        read: (p) => money(p?.image.outputImageMicrosPerMillion),
      },
      {
        key: 'imageEstimate',
        label: m('policyImage') + ' · ' + m('reserveEstimate'),
        read: (p) => money(p?.image.estimatedTotalMicros),
      },
      {
        key: 'imageReserve',
        label: m('policyImage') + ' · ' + m('reserveTotal'),
        read: (p) => money(p?.image.reserveMicros),
      },
      ...(['text', 'image'] as const).flatMap((kind) =>
        [
          ['marginBps', 'reserveMargin'],
          ['fixedMarginMicros', 'reserveFixed'],
          ['referenceAllowanceMicros', 'reserveReferences'],
        ].map(([key, label]) => ({
          key: kind + key,
          label:
            m(kind === 'text' ? 'policyText' : 'policyImage') + ' · ' + m(label as LiveMessage),
          read: (p: PolicyProfile | null) => {
            const value = p?.[kind].estimation?.[key];
            return typeof value === 'number'
              ? key === 'marginBps'
                ? String(value / 100) + '%'
                : money(value)
              : m('reserveUnavailable');
          },
        })),
      ),
    ];
  return (
    <div className={styles.tableWrap}>
      <table>
        <thead>
          <tr>
            <th>{m('policyField')}</th>
            <th>{m('policyCurrent')}</th>
            {proposed && <th>{m('policyProposed')}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              <td>{row.read(current)}</td>
              {proposed && <td>{row.read(proposed)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function OwnerPolicyReview({
  authorizationId,
  onApplied,
}: {
  authorizationId: string | null;
  onApplied: () => Promise<unknown>;
}) {
  const { user } = useClient(),
    m = useLiveText(),
    { locale } = useT();
  const scopeKey = JSON.stringify({ owner: user?.id ?? null, authorizationId }),
    scope = useRef(new GenerationResponseScope()).current;
  scope.update(scopeKey);
  const storageKey = 'dreamwalk-policy-apply:' + scopeKey;
  const [open, setOpen] = useState(false),
    [snapshot, setSnapshot] = useState<{ scope: string; value: PolicyReview } | null>(null),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [reconciledId, setReconciledId] = useState<string | null>(null),
    [pendingState, setPending] = useState<{ scope: string; value: PolicyApply } | null>(null);
  const locked = useRef(false),
    mounted = useRef(true),
    loadEpoch = useRef(0);
  const policy = snapshot?.scope === scopeKey ? snapshot.value : null,
    pending = pendingState?.scope === scopeKey ? pendingState.value : null;
  const retryAllowed =
    !!pending && reconciledId === pending.operationId && policyRetryMatches(pending, policy);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      scope.invalidate();
    };
  }, [scope]);
  useEffect(() => {
    setConsent(false);
    setSnapshot(null);
    setError('');
    setNotice('');
    setReconciledId(null);
    setOpen(false);
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
      setPending(validPendingPolicyApply(value) ? { scope: scopeKey, value } : null);
    } catch {
      setPending(null);
    }
  }, [scopeKey, storageKey]);
  function remember(value: PolicyApply | null) {
    setPending(value ? { scope: scopeKey, value } : null);
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* Receipt recovery remains available during this mounted session. */
    }
  }
  async function load() {
    const requestEpoch = ++loadEpoch.current;
    const stamp = scope.capture();
    setBusy(true);
    setError('');
    setConsent(false);
    setReconciledId(null);
    try {
      const value = await api<PolicyReview>('/generation/policy');
      if (mounted.current && scope.current(stamp) && requestEpoch === loadEpoch.current)
        setSnapshot({ scope: scopeKey, value });
      return value;
    } catch (e) {
      if (mounted.current && scope.current(stamp) && requestEpoch === loadEpoch.current) {
        setSnapshot(null);
        setError(e instanceof ApiError ? e.code : 'NETWORK_ERROR');
      }
      return null;
    } finally {
      if (mounted.current && scope.current(stamp) && requestEpoch === loadEpoch.current)
        setBusy(false);
    }
  }
  async function reconcile(value = pending) {
    if (!value || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    const stamp = scope.capture();
    try {
      const result = await api<PolicyReceipt>('/generation/policy/operations/' + value.operationId);
      if (!mounted.current || !scope.current(stamp)) return;
      if (
        result.status === 'applied' &&
        result.operationId === value.operationId &&
        result.candidateFingerprint === value.candidateFingerprint
      ) {
        remember(null);
        setNotice(m('policyApplied'));
        await onApplied();
        await load();
      } else {
        const current = await load();
        if (mounted.current && scope.current(stamp)) {
          setNotice(m('policyNotFound'));
          if (policyRetryMatches(value, current)) setReconciledId(value.operationId);
        }
      }
    } catch (e) {
      if (mounted.current && scope.current(stamp))
        setError(e instanceof ApiError ? e.code : 'NETWORK_ERROR');
    } finally {
      locked.current = false;
      if (mounted.current && scope.current(stamp)) setBusy(false);
    }
  }
  async function apply() {
    if (
      locked.current ||
      (pending && !retryAllowed) ||
      !consent ||
      !policy?.active ||
      !policy.proposed?.canApply
    )
      return;
    const value: PolicyApply = pending ?? {
      operationId: crypto.randomUUID(),
      expectedRevision: policy.active.revision,
      expectedHash: policy.active.hash,
      candidateFingerprint: policy.proposed.candidateFingerprint,
      consent: true,
    };
    remember(value);
    setReconciledId(null);
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const stamp = scope.capture();
    try {
      const result = await api<PolicyReceipt>('/generation/policy/revisions', {
        method: 'POST',
        body: JSON.stringify(value),
      });
      if (!mounted.current || !scope.current(stamp)) return;
      if (
        result.status === 'applied' &&
        result.operationId === value.operationId &&
        result.candidateFingerprint === value.candidateFingerprint
      ) {
        remember(null);
        setConsent(false);
        setNotice(m('policyApplied'));
        await onApplied();
        await load();
      } else setNotice(m('policyPending'));
    } catch (e) {
      if (mounted.current && scope.current(stamp)) {
        setConsent(false);
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          remember(null);
          setError(e.code);
          if (e.code === 'GENERATION_POLICY_STALE') {
            setNotice(m('policyStale'));
            await load();
          }
        } else {
          setNotice(m('policyPending'));
          setError(e instanceof ApiError ? e.code : 'NETWORK_ERROR');
        }
      }
    } finally {
      locked.current = false;
      if (mounted.current && scope.current(stamp)) setBusy(false);
    }
  }
  const money = (value: number) => formatUsd(value, locale);
  return (
    <div className={styles.root} data-testid="owner-policy-review">
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        {m(pending ? 'policyReconcile' : 'policyOpen')}
      </Button>
      {open && (
        <Modal
          title={m('policyTitle')}
          onClose={() => {
            setOpen(false);
            setConsent(false);
          }}
        >
          <section className={styles.dialog} data-testid="owner-policy-dialog">
            <p>{m('policyUnchanged')}</p>
            <ErrorBox message={error ? m('failure') + ' (' + error + ')' : ''} />
            {notice && <p role="status">{notice}</p>}
            {pending && (
              <>
                <p role="status">{m('policyPending')}</p>
                <Button type="button" disabled={busy} onClick={() => void reconcile()}>
                  {m('policyReconcile')}
                </Button>
              </>
            )}
            {policy && (
              <>
                {policy.active && (
                  <p>
                    {m('policyRevision')}: {policy.active.revision}
                  </p>
                )}
                {!policy.active && <p>{m('policyNoActive')}</p>}
                {policy.active?.legacy && policy.active.profile === null && (
                  <p>{m('policyUnknownProfile')}</p>
                )}
                <PolicyComparison
                  current={policy.active?.profile ?? null}
                  proposed={policy.proposed?.profile ?? null}
                />
                <h3>{m('policyLiabilities')}</h3>
                <div className={styles.tableWrap}>
                  <table data-testid="policy-liabilities">
                    <thead>
                      <tr>
                        <th>{m('policyField')}</th>
                        <th>{m('used')}</th>
                        <th>{m('held')}</th>
                        <th>{m('policyUnknown')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(
                        [
                          ['policyTotal', policy.liabilities],
                          ['policyText', policy.liabilities.text],
                          ['policyImage', policy.liabilities.image],
                        ] as const
                      ).map(([label, value]) => (
                        <tr key={label}>
                          <th>{m(label)}</th>
                          <td>{money(value.spentMicros)}</td>
                          <td>{money(value.heldMicros)}</td>
                          <td>{money(value.unknownMicros)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p>
                  {m('policyAccounted')}: {money(policy.liabilities.totalAccountedMicros)}
                </p>
                {[...new Set([...policy.blockers, ...(policy.proposed?.blockers ?? [])])].map(
                  (code) => (
                    <p key={code}>
                      <code>{code}</code>
                    </p>
                  ),
                )}
                {!policy.proposed && <p>{m('policyNoProposal')}</p>}
                {policy.active && policy.proposed && (
                  <>
                    <label className={styles.check}>
                      <input
                        type="checkbox"
                        checked={consent}
                        disabled={busy || (!!pending && !retryAllowed) || !policy.proposed.canApply}
                        onChange={(e) => setConsent(e.target.checked)}
                      />
                      {m('policyConsent')}
                    </label>
                    <Button
                      type="button"
                      disabled={
                        busy ||
                        (!!pending && !retryAllowed) ||
                        !consent ||
                        !policy.proposed.canApply
                      }
                      onClick={() => void apply()}
                    >
                      {m(pending ? 'policyRetry' : 'policyApply')}
                    </Button>
                  </>
                )}
                <details>
                  <summary>
                    {m('policyHistory')} ({policy.history.length})
                  </summary>
                  {policy.history.map((entry) => (
                    <article key={entry.revision}>
                      <h4>
                        {m('policyRevision')} {entry.revision}
                      </h4>
                      <p>{new Date(entry.acknowledgedAt).toLocaleString(locale)}</p>
                      <code>{entry.hash}</code>
                      {entry.profile ? (
                        <PolicyComparison current={entry.profile} proposed={null} />
                      ) : (
                        <p>{m('policyUnknownProfile')}</p>
                      )}
                    </article>
                  ))}
                </details>
              </>
            )}
            <div className={styles.actions}>
              <Button type="button" variant="secondary" disabled={busy} onClick={() => void load()}>
                {m('refresh')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setOpen(false);
                  setConsent(false);
                }}
              >
                {m(pending ? 'policyClosePending' : 'policyClose')}
              </Button>
            </div>
          </section>
        </Modal>
      )}
    </div>
  );
}
