'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox } from '../ui';
import { GameCanvas } from '../game/game-canvas';
import {
  generationRemaining,
  formatUsd,
  liveSessionActive,
  type LiveTestStatus,
} from '../live-test/types';
import { spatialMessages, useSpatialText, type SpatialMessage } from './spatial-messages';
import type { SpatialProject, SpatialState } from './spatial-types';
import { useVisualText } from './messages';
import styles from './workshop.module.css';

export function SpatialPlanner({
  project,
  session,
  disabled,
  onBusyChange,
  onApplied,
  onBudgetRefresh,
}: {
  project: SpatialProject;
  session: LiveTestStatus | null;
  disabled: boolean;
  onBusyChange: (value: boolean) => void;
  onApplied: () => Promise<void>;
  onBudgetRefresh: () => void;
}) {
  const m = useSpatialText(),
    visual = useVisualText(),
    { locale } = useT();
  const [state, setState] = useState<SpatialState | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [consent, setConsent] = useState(''),
    [reviewed, setReviewed] = useState(''),
    [unknown, setUnknown] = useState(false),
    [now, setNow] = useState(Date.now());
  const epoch = useRef(0),
    inFlight = useRef(false),
    operations = useRef(new Map<string, string>()),
    mounted = useRef(true),
    appliedCallback = useRef(onApplied);
  appliedCallback.current = onApplied;
  const prefix = `/visual-authoring/projects/${project.id}/spatial-plan`;
  const refresh = useCallback(async () => {
    const stamp = ++epoch.current;
    try {
      const next = await api<SpatialState>(`/visual-authoring/projects/${project.id}/spatial-plan`);
      if (stamp === epoch.current) {
        setState(next);
        setError('');
        setConsent('');
        setUnknown(false);
        if (
          next.currentProposal?.status === 'applied' &&
          next.currentProposal.projectRevision === project.revision
        )
          await appliedCallback.current();
      }
    } catch (e) {
      if (stamp === epoch.current) setError(e instanceof ApiError ? e.code : 'NETWORK_ERROR');
    }
  }, [project.id, project.revision]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setConsent('');
  }, [session?.sessionId, session?.state]);
  async function mutate(path: string, body: object, paidAttempt = false, apply = false) {
    if (inFlight.current || disabled) return;
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
        setConsent('');
        setReviewed('');
        if (apply) await onApplied();
        else await refresh();
      }
    } catch (e) {
      if (stamp === epoch.current) {
        setError(e instanceof ApiError ? e.code : 'NETWORK_ERROR');
        if (paidAttempt && (!(e instanceof ApiError) || !e.status)) setUnknown(true);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
      onBusyChange(false);
      if (mounted.current && paidAttempt) onBudgetRefresh();
    }
  }
  const quote = [...(state?.quotes ?? [])]
    .filter((value) => !value.consumed)
    .sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt))[0];
  const expired = !!quote && Date.parse(quote.expiresAt) <= now,
    attempted = !!state?.jobs.length;
  const sessionAvailable = !!state?.available && liveSessionActive(session, now);
  const available = sessionAvailable && project.status === 'concept';
  const quoteCostValid =
    typeof quote?.upperMicros === 'number' &&
    Number.isFinite(quote.upperMicros) &&
    quote.upperMicros >= 0;
  const proposal = state?.currentProposal,
    proposalFence =
      !!proposal &&
      proposal.projectRevision === project.revision &&
      proposal.sourceHash === project.sourceHash;
  const canApply =
    !!state?.canApply &&
    proposal?.status === 'proposed' &&
    proposal.validated &&
    proposalFence &&
    project.status === 'concept';
  const proposalJob = state?.jobs.find((job) => job.result?.proposalId === proposal?.id);
  const money = (value: number) => formatUsd(value, locale);
  const statusText = (value: string) =>
    value in spatialMessages ? m(value as SpatialMessage) : value;
  return (
    <section className={styles.generation} aria-label={m('title')} data-testid="spatial-planner">
      <h3>{m('title')}</h3>
      <p>{m('intro')}</p>
      <p>{m('noRetry')}</p>
      {state && <small>{state.model}</small>}
      {!sessionAvailable && (
        <p role="status">{m(session?.mode === 'owner' ? 'ownerUnavailable' : 'unavailable')}</p>
      )}
      {state?.blockers.map((code) => (
        <small key={code}>
          <code>{code}</code>
        </small>
      ))}
      <ErrorBox
        message={error ? `${m(error === 'STALE_STATE' ? 'stale' : 'failure')} (${error})` : ''}
      />
      {unknown && <p role="status">{m('unknown')}</p>}
      <Button
        type="button"
        variant="secondary"
        disabled={busy || disabled}
        onClick={() => void refresh()}
      >
        {m('refresh')}
      </Button>
      <Button
        type="button"
        variant="secondary"
        disabled={
          disabled ||
          busy ||
          !available ||
          !state?.canQuote ||
          state.upperMicros > generationRemaining(session, 'text') ||
          attempted ||
          unknown ||
          (!!quote && !expired)
        }
        onClick={() =>
          void mutate(`${prefix}/quote`, {
            expectedRevision: project.revision,
            sessionId: session?.sessionId,
          })
        }
      >
        {m('quote')}
      </Button>
      {quote && !attempted && (
        <div className={styles.quote} data-testid="spatial-quote">
          <p>
            {m('upper')}: {quoteCostValid ? money(quote.upperMicros) : m('unavailable')}
          </p>
          <small>
            {m('expires')}: {new Date(quote.expiresAt).toLocaleString(locale)}
          </small>
          {expired && <p>{m('expired')}</p>}
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={consent === quote.id}
              disabled={disabled || busy || !available || expired || !quoteCostValid}
              onChange={(e) => setConsent(e.target.checked ? quote.id : '')}
            />
            {m('consent')}
          </label>
          <Button
            type="button"
            busy={busy}
            disabled={
              disabled ||
              !available ||
              expired ||
              !quoteCostValid ||
              consent !== quote.id ||
              unknown ||
              quote.upperMicros > generationRemaining(session, 'text')
            }
            onClick={() =>
              void mutate(
                `${prefix}/dispatch`,
                { expectedRevision: project.revision, quoteId: quote.id, consent: true },
                true,
              )
            }
          >
            {m('dispatch')}
          </Button>
        </div>
      )}
      {state?.jobs.map((job) => (
        <article key={job.id} className={styles.generationItem} data-spatial-job={job.id}>
          <strong>{statusText(job.status)}</strong>
          <p>
            {m(job.costStatus === 'settled' ? 'debited' : 'held')}:{' '}
            {money(typeof job.actualMicros === 'number' ? job.actualMicros : job.upperMicros)}
          </p>
          {job.errorCode && <code>{job.errorCode}</code>}
          {(job.status === 'unknown' || job.costStatus === 'unknown') && (
            <p role="status">{m('unknown')}</p>
          )}
          {job.canCancel && (
            <Button
              type="button"
              variant="secondary"
              disabled={disabled || busy}
              onClick={() =>
                void mutate(
                  `${prefix}/jobs/${job.id}/cancel`,
                  { expectedRevision: project.revision },
                  true,
                )
              }
            >
              {m('cancel')}
            </Button>
          )}
        </article>
      ))}
      {attempted &&
        !proposal &&
        !state?.jobs.some((job) =>
          ['queued', 'dispatched', 'generated', 'unknown'].includes(job.status),
        ) && <p>{m('oneAttempt')}</p>}
      {proposal && (
        <article className={styles.generationItem} data-testid="spatial-proposal">
          <h4>{m('proposal')}</h4>
          <p>{m('inert')}</p>
          <p>{m(proposal.validated ? 'valid' : 'invalid')}</p>
          {proposal.status === 'applied' && <p>{m('applied')}</p>}
          {proposal.status === 'cancelled' && <p>{m('cancelled')}</p>}
          {proposal.status === 'proposed' && !proposalFence && <p role="status">{m('stale')}</p>}
          <dl className={styles.proposalSummary}>
            <div>
              <dt>{m('rooms')}</dt>
              <dd>{proposal.plan.maps.length}</dd>
            </div>
            <div>
              <dt>{m('objects')}</dt>
              <dd>{proposal.plan.objects.length}</dd>
            </div>
            <div>
              <dt>{m('npcs')}</dt>
              <dd>{proposal.plan.npcs.length}</dd>
            </div>
          </dl>
          <ul>
            {proposal.plan.maps.map((map) => (
              <li key={map.id}>
                {map.label} · {map.width} × {map.height}
              </li>
            ))}
          </ul>
          <details className={styles.proposalDetails} data-testid="spatial-public-summary">
            <summary>{m('details')}</summary>
            <h5>{m('rooms')}</h5>
            {proposal.plan.maps.map((map) => (
              <section key={map.id}>
                <strong>{map.label}</strong>
                {map.description && <p>{map.description}</p>}
                <p>
                  {m('entrances')}:{' '}
                  {map.spawns.map((point) => '(' + point.x + ', ' + point.y + ')').join('; ')}
                </p>
                <ul>
                  {map.exits.map((exit) => (
                    <li key={exit.id}>
                      {m('exits')}: ({exit.x}, {exit.y}) →{' '}
                      {proposal.plan.maps.find((other) => other.id === exit.destinationMapId)
                        ?.label ?? exit.destinationMapId}{' '}
                      ({exit.destination.x}, {exit.destination.y})
                    </li>
                  ))}
                </ul>
                <ul>
                  {map.composition?.layers.map((layer) => (
                    <li key={layer.id}>
                      {visual(layer.visual)} · ({layer.x}, {layer.y}) · {layer.width} ×{' '}
                      {layer.height}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <h5>{m('objects')}</h5>
            <ul>
              {proposal.plan.objects.map((object) => (
                <li key={object.id}>
                  <strong>{object.label}</strong> ·{' '}
                  {proposal.plan.maps.find((map) => map.id === object.mapId)?.label ?? object.mapId}{' '}
                  ({object.x}, {object.y})
                  {object.publicProfile?.description && <p>{object.publicProfile.description}</p>}
                  {object.publicProfile?.appearance && <p>{object.publicProfile.appearance}</p>}
                </li>
              ))}
            </ul>
            <h5>{m('npcs')}</h5>
            <ul>
              {proposal.plan.npcs.map((npc) => (
                <li key={npc.id}>
                  <strong>{npc.label}</strong> ·{' '}
                  {proposal.plan.maps.find((map) => map.id === npc.mapId)?.label ?? npc.mapId} (
                  {npc.x}, {npc.y}){npc.publicProfile?.role && <p>{npc.publicProfile.role}</p>}
                  {npc.publicProfile?.description && <p>{npc.publicProfile.description}</p>}
                  {npc.publicProfile?.appearance && <p>{npc.publicProfile.appearance}</p>}
                </li>
              ))}
            </ul>
            {proposal.plan.objectives?.map((objective) => (
              <section key={objective.id}>
                <h5>
                  {m('objective')}: {objective.title}
                </h5>
                <p>{objective.description}</p>
              </section>
            ))}
          </details>
          {proposal.validated && (
            <>
              <p>{m('placeholderPreview')}</p>
              <GameCanvas
                projection={proposal.projection}
                art={[]}
                disabled
                reducedMotion
                onMove={() => {}}
                onSelectNpc={() => {}}
                onStop={() => {}}
              />
            </>
          )}
          {proposal.status === 'proposed' && (
            <>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={reviewed === proposal.id}
                  disabled={disabled || busy || !canApply}
                  onChange={(e) => setReviewed(e.target.checked ? proposal.id : '')}
                />
                {m('review')}
              </label>
              <Button
                type="button"
                busy={busy}
                disabled={disabled || !canApply || reviewed !== proposal.id}
                onClick={() =>
                  void mutate(
                    `${prefix}/apply`,
                    { expectedRevision: project.revision, proposalId: proposal.id, consent: true },
                    false,
                    true,
                  )
                }
              >
                {m('apply')}
              </Button>
              {proposalJob && !proposalJob.canCancel && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={disabled || busy}
                  onClick={() =>
                    void mutate(
                      `${prefix}/jobs/${proposalJob.id}/cancel`,
                      { expectedRevision: project.revision },
                      true,
                    )
                  }
                >
                  {m('cancelProposal')}
                </Button>
              )}
            </>
          )}
        </article>
      )}
    </section>
  );
}
