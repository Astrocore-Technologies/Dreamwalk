'use client';
import { Send } from 'lucide-react';
import { SparkReceiptCost } from '../visual-authoring/sparks-cost';
import { StoryCost, RuntimeMapQuoteNotice } from './story-cost';
import { StoryReplyConfirmation } from './story-reply-confirmation';
import { WorldGenerationConfirmation } from './world-generation-confirmation';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type {
  GameProjection,
  StoryActionPreview,
  StoryFeedEntry,
  StoryTurnFeed,
  StoryTurnInput,
  StoryTurnQuoteResponse,
  StoryTurnReceipt,
} from '@dreamwalk/contracts';
import { api, ApiError, errorMessage } from '@/lib/client';
import { getLocale, useT } from '@/lib/i18n';
import { Button, ErrorBox, Textarea } from '@/components/ui';
import { noticeLabels } from './living-notices';
import { useStoryScroll } from './use-story-scroll';
import { providerBoundKnown } from './narrative-guards';
import {
  storyTargetVisible,
  storyTargetValid,
  storyDraftKey,
  storyRecipientLabel,
} from './story-turn-guards';
import { useStoryText, type StoryMessageKey } from './story-messages';
import { projectionTurnFence } from './turn-ui';
import { useTurnText } from './turn-messages';
import styles from './story-feed.module.css';
export type StoryRecipient = { id: string; label: string } | null;
type Prepared = {
  input: StoryTurnInput;
  result: StoryTurnQuoteResponse;
  mapId: string;
  key: string;
};
const clarificationKeys: Record<string, StoryMessageKey> = {
  AMBIGUOUS: 'ambiguous',
  UNSUPPORTED: 'unsupported',
  WALK_FIRST: 'walkFirst',
  CLEAR_TARGET_TO_CONTINUE_STORY: 'clearTarget',
  PRIVATE_STORY_EXTENSION: 'privateExtension',
  INVALID_MARKUP: 'markup',
  TOO_MANY_SEGMENTS: 'segments',
};
const actionLabels = {
  consume: 'Поесть',
  inspect: 'Осмотреть',
  open: 'Открыть дверь',
  close: 'Закрыть дверь',
  unlock: 'Отпереть',
  pick_up: 'Подобрать',
  give: 'Передать',
  transition: 'Перейти',
  approach: 'Перейти',
  wait: 'Ждать',
} as const;
export function UnifiedStory({
  campaignId,
  projection,
  recipient,
  inspection,
  onClearRecipient,
  disabled,
  partyDisabled = disabled,
  worldGenerationAllowed = false,
  worldGenerationMembersStatus = 'ready',
  onWorldRefresh,
  onBusyChange,
}: {
  campaignId: string;
  projection: GameProjection;
  recipient: StoryRecipient;
  inspection?: ReactNode;
  onClearRecipient: () => void;
  disabled: boolean;
  partyDisabled?: boolean;
  worldGenerationAllowed?: boolean;
  worldGenerationMembersStatus?: 'ready' | 'loading' | 'error';
  onWorldRefresh: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const turnText = useTurnText();
  const turnCopy = useRef(turnText);
  turnCopy.current = turnText;
  const h = useStoryText(),
    { t, locale } = useT(),
    hintId = useId();
  const [channel, setChannel] = useState<'say' | 'whisper'>('say');
  const [text, setText] = useState(''),
    [feed, setFeed] = useState<StoryTurnFeed | null>(null);
  const [prepared, setPreparedState] = useState<Prepared | null>(null);
  const preparedCurrent = useRef<Prepared | null>(null);
  const setPrepared = useCallback((value: Prepared | null) => {
    preparedCurrent.current = value;
    setPreparedState(value);
  }, []);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [uncertain, setUncertain] = useState(false);
  const { feedElement, feedContent, newEvents, onFeedScroll, scrollToLatest } = useStoryScroll(
    feed?.entries.at(-1)?.id,
  );
  const epoch = useRef(0),
    feedEpoch = useRef(0),
    polling = useRef(false),
    actionLock = useRef(false);
  const submitted = useRef<Prepared | null>(null),
    callback = useRef(onWorldRefresh);
  callback.current = onWorldRefresh;
  const copy = useRef(h);
  copy.current = h;
  const confirmOperations = useRef(new Map<string, string>());
  const targetNpcId = recipient?.id;
  const targetVisible = storyTargetVisible(projection, targetNpcId);
  const targetValid = storyTargetValid(projection, channel, targetNpcId);
  const turnFence = projectionTurnFence(projection);
  const draftKey =
    storyDraftKey(text, channel, targetNpcId, projection.map.id) +
    JSON.stringify(turnFence ?? null);
  const currentDraft = useRef(draftKey);
  currentDraft.current = draftKey;
  const path = `/game/campaigns/${campaignId}/turns`;
  useEffect(() => {
    const invalidate = (event: Event) => {
      const detail = (event as CustomEvent<{ campaignId?: string }>).detail;
      if (detail?.campaignId === campaignId) setPrepared(null);
    };
    window.addEventListener('dreamwalk:narrative-preferences-updated', invalidate);
    return () => window.removeEventListener('dreamwalk:narrative-preferences-updated', invalidate);
  }, [campaignId]);
  const refresh = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    const current = feedEpoch.current;
    const responseLocale = getLocale();
    try {
      const result = await api<StoryTurnFeed>(`${path}/feed`, {
        headers: { 'Accept-Language': responseLocale },
      });
      if (current !== feedEpoch.current || responseLocale !== getLocale()) return;
      setFeed(result);
      const sent = submitted.current;
      const receipt =
        sent && result.turns.find((entry) => entry.operationId === sent.input.operationId);
      if (receipt && receipt.status !== 'quoted') {
        setUncertain(false);
        setPrepared(null);
        if (receipt.status !== 'queued' && receipt.status !== 'awaiting_confirmation') {
          submitted.current = null;
          if (receipt.status === 'committed') {
            if (currentDraft.current === sent.key) setText('');
            if (receipt.code === 'NPC_REPLY_DEFERRED') setNotice(turnCopy.current('deferred'));
            callback.current();
          } else
            setNotice(
              copy.current(
                clarificationKeys[receipt.code || ''] ||
                  (receipt.status === 'stale' ? 'changed' : 'failed'),
              ),
            );
        }
      }
    } catch (err) {
      if (current === feedEpoch.current && responseLocale === getLocale()) {
        setError(errorMessage(err));
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
          setFeed(null);
          setPrepared(null);
          submitted.current = null;
          setUncertain(false);
        }
      }
    } finally {
      polling.current = false;
    }
    // Keep submissions pinned to their original quote; only the read feed follows the current locale.
  }, [path]);
  // Locale changes invalidate reads, not the original language/operation of
  // in-flight quotes, submissions, or their uncertain-response recovery.
  useEffect(() => {
    epoch.current++;
    return () => {
      epoch.current++;
    };
  }, [path]);
  useEffect(() => {
    feedEpoch.current++;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      feedEpoch.current++;
      clearInterval(timer);
    };
  }, [refresh, locale]);
  useEffect(() => {
    if (
      prepared &&
      (prepared.key !== draftKey ||
        prepared.input.expectedCanonRevision !== feed?.canonRevision ||
        !targetValid)
    ) {
      setPrepared(null);
      setNotice(h('changed'));
    }
  }, [draftKey, feed?.canonRevision, targetValid, prepared]);
  useEffect(() => {
    const expiresAt = prepared?.result.quote?.expiresAt;
    if (!expiresAt) return;
    const expire = () => {
      setPrepared(null);
      setNotice(copy.current('expired'));
    };
    const remaining = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      expire();
      return;
    }
    const timer = setTimeout(expire, remaining);
    return () => clearTimeout(timer);
  }, [prepared]);
  const available =
    !!feed?.canSubmit &&
    (!!projection.turn ||
      (feed.configuration.enabled &&
        (feed.configuration.provider === 'mock' || feed.configuration.externalCallsEnabled)));
  const pendingTurns =
    feed?.turns.filter(
      (entry) => entry.status === 'queued' || entry.status === 'awaiting_confirmation',
    ) || [];
  const pending = !!submitted.current || pendingTurns.length > 0;
  const awaitingMechanicalConfirmation = pendingTurns.some(
    (entry) => entry.status === 'awaiting_confirmation',
  );
  useEffect(() => {
    onBusyChange?.(busy || uncertain || awaitingMechanicalConfirmation);
  }, [busy, uncertain, awaitingMechanicalConfirmation, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  async function prepare() {
    if (
      actionLock.current ||
      disabled ||
      !available ||
      !feed ||
      !targetValid ||
      !text.trim() ||
      pending ||
      uncertain
    )
      return;
    actionLock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setPrepared(null);
    const current = epoch.current,
      key = draftKey;
    const input: StoryTurnInput = {
      operationId: crypto.randomUUID(),
      text: text.trim(),
      channel,
      // A quote, its submission and any uncertain retry describe the same post,
      // even if the interface language changes while it is being processed.
      replyLocale: getLocale(),
      ...(targetNpcId ? { targetNpcId } : {}),
      expectedCanonRevision: feed.canonRevision,
      ...(turnFence ? { turnFence } : {}),
    };
    try {
      const result = await api<StoryTurnQuoteResponse>(`${path}/quote`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (current !== epoch.current) return;
      if (key !== currentDraft.current) {
        setNotice(h('changed'));
        return;
      }
      if (result.status === 'clarification') {
        setNotice(h(clarificationKeys[result.code || ''] || 'ambiguous'));
        return;
      }
      if (!result.quote || !result.turnId) {
        setError(h('failed'));
        return;
      }
      setPrepared({ input, result, mapId: projection.map.id, key });
    } catch (err) {
      if (current === epoch.current) setError(errorMessage(err));
    } finally {
      actionLock.current = false;
      if (current === epoch.current) setBusy(false);
    }
  }
  async function submit(recover = false) {
    const sent = recover ? submitted.current : prepared,
      quote = sent?.result.quote;
    if (
      !sent ||
      !quote ||
      !sent.result.turnId ||
      actionLock.current ||
      disabled ||
      (!recover &&
        (sent !== preparedCurrent.current ||
          !available ||
          !targetValid ||
          pending ||
          uncertain ||
          sent.key !== draftKey ||
          sent.input.expectedCanonRevision !== feed?.canonRevision)) ||
      (recover && !uncertain)
    )
      return;
    if (!providerBoundKnown(quote, quote.external)) {
      setError(h('noBound'));
      return;
    }
    if (
      !recover &&
      (!Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= Date.now())
    ) {
      setPrepared(null);
      setError(h('expired'));
      return;
    }
    actionLock.current = true;
    setBusy(true);
    setError('');
    submitted.current = sent;
    const current = epoch.current;
    try {
      await api<StoryTurnReceipt>(path, {
        method: 'POST',
        body: JSON.stringify({
          ...sent.input,
          turnId: sent.result.turnId,
          quoteId: quote.id,
          consent: true,
          ...(sent.result.confirmationHash
            ? { confirmedActionHash: sent.result.confirmationHash }
            : {}),
        }),
      });
      if (current !== epoch.current) return;
      setPrepared(null);
      await refresh();
    } catch (err) {
      if (current === epoch.current) {
        setError(errorMessage(err));
        if (
          err instanceof ApiError &&
          err.status >= 400 &&
          err.status < 500 &&
          err.status !== 408
        ) {
          submitted.current = null;
          setUncertain(false);
          setPrepared(null);
          void refresh();
        } else setUncertain(true);
      }
    } finally {
      actionLock.current = false;
      if (current === epoch.current) setBusy(false);
    }
  }
  async function confirmAction(turn: StoryTurnReceipt, decision: 'accept' | 'decline') {
    if (actionLock.current || disabled || !turn.proposalHash) return;
    const key = `${turn.id}:${turn.proposalHash}:${decision}`;
    if (!confirmOperations.current.has(key))
      confirmOperations.current.set(key, crypto.randomUUID());
    actionLock.current = true;
    setBusy(true);
    setError('');
    const current = epoch.current;
    try {
      await api(`${path}/${turn.id}/confirm`, {
        method: 'POST',
        body: JSON.stringify({
          operationId: confirmOperations.current.get(key),
          proposalHash: turn.proposalHash,
          ...(turnFence ? { turnFence } : {}),
          decision,
        }),
      });
      if (current === epoch.current) {
        await refresh();
        callback.current();
      }
    } catch (err) {
      if (current === epoch.current) setError(errorMessage(err));
    } finally {
      actionLock.current = false;
      if (current === epoch.current) setBusy(false);
    }
  }
  function actionLabel(kind: string) {
    if (kind === 'hit' || kind === 'push') return turnText(kind);
    return t(actionLabels[kind as keyof typeof actionLabels] || 'Ждать');
  }
  function actionsPreview(actions: StoryActionPreview[]) {
    return (
      <ul>
        {actions.map((entry, index) => {
          const target =
            entry.targetLabel ||
            projection.entities.find((entity) => entity.id === entry.action.targetId)?.label ||
            projection.map.exits.find((exit) => exit.id === entry.action.targetId)?.label;
          const item = projection.inventory.find(
            (entity) => entity.id === entry.action.itemId,
          )?.label;
          return (
            <li key={index}>
              {actionLabel(entry.action.kind)}
              {item ? ` · ${item}` : ''}
              {target ? ` → ${target}` : ''}
            </li>
          );
        })}
      </ul>
    );
  }
  function entryText(entry: StoryFeedEntry) {
    if (entry.text) return entry.text; // Already parsed by the server; literal stars stay literal.
    if (entry.code && entry.code in noticeLabels)
      return t(noticeLabels[entry.code as keyof typeof noticeLabels]);
    if (entry.code === 'acknowledged') return t('Я тебя услышал.');
    const outcome = t(
      entry.code === 'ACTION_SUCCEEDED' ? 'Действие подтверждено' : 'Действие отклонено',
    );
    if (entry.action) return `${actionLabel(entry.action.kind)} — ${outcome}`;
    return outcome;
  }
  return (
    <section
      className={styles.panel}
      aria-label={h('title')}
      data-testid="unified-story"
      data-canon-revision={feed?.canonRevision}
    >
      <div className={styles.tabs}>
        <strong>{h('title')}</strong>
        {feed && (
          <small className={styles.badge}>
            {projection.turn
              ? turnText('localInput')
              : h(feed.configuration.provider === 'mock' ? 'mock' : 'external')}
          </small>
        )}
      </div>
      <div className={styles.body}>
        <div className={styles.story}>
          <div className={styles.history} data-inspecting={!!inspection}>
            <div
              className={styles.feed}
              role="log"
              aria-label={h('title')}
              aria-live="polite"
              aria-relevant="additions"
              aria-hidden={!!inspection}
              data-testid="story-feed"
              ref={feedElement}
              onScroll={onFeedScroll}
              tabIndex={inspection ? -1 : 0}
            >
              <div ref={feedContent}>
                {!feed?.entries.length && <p className={styles.status}>{h('empty')}</p>}
                {feed?.entries.map((entry) => (
                  <article
                    key={entry.id}
                    className={`${styles.entry} ${entry.authorId === projection.actorId ? styles.player : ''}`}
                    data-story-entry={entry.id}
                    data-story-kind={entry.kind}
                    data-story-code={entry.code}
                    data-story-turn={entry.turnId}
                    data-story-sequence={entry.sequence ?? 'legacy'}
                  >
                    <header>
                      <strong>
                        {entry.authorId === projection.actorId
                          ? h('you')
                          : entry.authorLabel ||
                            h(
                              entry.kind === 'narration'
                                ? 'narrator'
                                : entry.kind === 'outcome'
                                  ? 'outcome'
                                  : 'nearby',
                            )}
                      </strong>
                      {!entry.legacy && entry.channel === 'whisper' && (
                        <span className={styles.private}>{h('whisper')}</span>
                      )}
                      {entry.legacy && <span>{h('legacy')}</span>}
                    </header>
                    <p>{entryText(entry)}</p>
                  </article>
                ))}
              </div>
            </div>
            {newEvents && (
              <button type="button" className={styles.newEvents} onClick={scrollToLatest}>
                {h('newEvents')}
              </button>
            )}
            {inspection && <div className={styles.inspectionLayer}>{inspection}</div>}
          </div>
          <form
            className={styles.composer}
            onSubmit={(event) => {
              event.preventDefault();
              if (prepared) void submit();
              else void prepare();
            }}
          >
            <div className={styles.recipient}>
              <span>
                {recipient
                  ? `${h('target')}: ${storyRecipientLabel(projection, recipient)}`
                  : h('scene')}
              </span>
              {recipient && (
                <button
                  type="button"
                  aria-label={h('clear')}
                  disabled={busy || pending}
                  onClick={onClearRecipient}
                >
                  {h('director')}
                </button>
              )}
              <button
                type="button"
                aria-pressed={channel === 'whisper'}
                disabled={busy || pending}
                onClick={() => {
                  setChannel((value) => (value === 'say' ? 'whisper' : 'say'));
                  setPrepared(null);
                }}
              >
                {h('whisper')}
              </button>
            </div>
            {!targetVisible && (
              <p className={styles.status} role="status">
                {h('missingTarget')}
              </p>
            )}
            {channel === 'whisper' && !recipient && (
              <p className={styles.status} role="status">
                {h('chooseWhisper')}
              </p>
            )}
            <div className={styles.composerInput}>
              <Textarea
                aria-label={h('composer')}
                aria-describedby={hintId}
                value={text}
                maxLength={1000}
                rows={2}
                placeholder={h('placeholder')}
                disabled={disabled || busy || pending || uncertain}
                onChange={(event) => {
                  setText(event.target.value);
                  setPrepared(null);
                  setNotice('');
                }}
              />
              {!prepared && !pending && !uncertain && (
                <Button
                  type="submit"
                  className={styles.sendButton}
                  aria-label={h('send')}
                  title={h('send')}
                  busy={busy}
                  disabled={disabled || busy || !available || !targetValid || !text.trim()}
                >
                  <Send size={20} aria-hidden="true" />
                </Button>
              )}
            </div>
            <p id={hintId} className={styles.hint}>
              {h('hint')}
            </p>
            <div className={styles.composerFeedback}>
              <RuntimeMapQuoteNotice />
              <ErrorBox message={error} />
              {notice && (
                <p className={styles.status} role="status">
                  {notice}
                </p>
              )}
              {feed && !available && <p className={styles.status}>{h('unavailable')}</p>}
              {projection.turn?.phase === 'world' && (
                <WorldGenerationConfirmation
                  campaignId={campaignId}
                  access={
                    worldGenerationAllowed
                      ? 'owner'
                      : worldGenerationMembersStatus === 'error'
                        ? 'error'
                        : worldGenerationMembersStatus === 'loading'
                          ? 'loading'
                          : 'member'
                  }
                  membershipError={worldGenerationMembersStatus === 'error'}
                  membershipPending={worldGenerationMembersStatus === 'loading'}
                  scope={JSON.stringify([turnFence, feed?.canonRevision, projection.map.id])}
                  disabled={partyDisabled}
                />
              )}
              {feed?.turns
                .filter((turn) => turn.generationNeedsConfirmation)
                .map((turn) => (
                  <StoryReplyConfirmation
                    key={turn.id}
                    campaignId={campaignId}
                    turnId={turn.id}
                    scope={JSON.stringify([turnFence, feed.canonRevision, projection.map.id])}
                    disabled={partyDisabled}
                    onChanged={refresh}
                  />
                ))}
              {uncertain && (
                <p role="status" className={styles.status}>
                  {h('unknown')}
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy || disabled}
                    onClick={() => void submit(true)}
                  >
                    {h('retrySame')}
                  </Button>
                </p>
              )}
              {pendingTurns.map((turn) => (
                <div key={turn.id} className={styles.quote} data-story-pending={turn.status}>
                  {turn.status === 'awaiting_confirmation' ? (
                    <>
                      <p>{h('actionHint')}</p>
                      {actionsPreview(turn.actions || [])}
                      <p className={styles.hint}>
                        <SparkReceiptCost receipt={turn} />
                      </p>
                      <div className={styles.actions}>
                        <Button
                          type="button"
                          disabled={disabled || busy}
                          onClick={() => void confirmAction(turn, 'accept')}
                        >
                          {h('actionConfirm')}
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={disabled || busy}
                          onClick={() => void confirmAction(turn, 'decline')}
                        >
                          {h('decline')}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <p role="status">{h(turn.jobStatus === 'unknown' ? 'unknown' : 'pending')}</p>
                  )}
                </div>
              ))}
              {prepared?.result.quote && (
                <div className={styles.quote} data-testid="story-quote">
                  {prepared.result.actionPreview.length > 0 && (
                    <>
                      <strong>{h('preview')}</strong>
                      {actionsPreview(prepared.result.actionPreview)}
                    </>
                  )}
                  <StoryCost quote={prepared.result.quote} />
                  {prepared.input.replyLocale && (
                    <p data-testid="story-reply-language">
                      {h('replyLanguage', {
                        language: { uk: 'Українська', en: 'English', ru: 'Русский' }[
                          prepared.input.replyLocale
                        ],
                      })}
                    </p>
                  )}
                  <div className={styles.actions}>
                    <Button
                      type="submit"
                      disabled={
                        disabled ||
                        busy ||
                        pending ||
                        uncertain ||
                        !targetValid ||
                        !providerBoundKnown(
                          prepared.result.quote,
                          feed?.configuration.provider !== 'mock',
                        )
                      }
                    >
                      {h('confirm')}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => setPrepared(null)}
                    >
                      {h('dismiss')}
                    </Button>
                  </div>
                </div>
              )}
              {(pending || uncertain) && (
                <Button type="button" variant="secondary" onClick={() => void refresh()}>
                  {h('refresh')}
                </Button>
              )}
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}
