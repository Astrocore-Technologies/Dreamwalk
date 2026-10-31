'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
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
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Textarea } from '@/components/ui';
import { noticeLabels } from './living-notices';
import { PartyChat } from './party-chat';
import { SceneMedia } from './scene-media';
import { providerBoundKnown } from './narrative-guards';
import { storyTargetVisible, storyTargetValid, storyDraftKey } from './story-turn-guards';
import { useStoryText, type StoryMessageKey } from './story-messages';
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
  inspect: 'Осмотреть',
  open: 'Открыть дверь',
  close: 'Закрыть дверь',
  unlock: 'Отпереть',
  pick_up: 'Подобрать',
  give: 'Передать',
  transition: 'Перейти',
  wait: 'Ждать',
} as const;
export function UnifiedStory({
  campaignId,
  projection,
  recipient,
  onClearRecipient,
  disabled,
  onWorldRefresh,
}: {
  campaignId: string;
  projection: GameProjection;
  recipient: StoryRecipient;
  onClearRecipient: () => void;
  disabled: boolean;
  onWorldRefresh: () => void;
}) {
  const h = useStoryText(),
    { t } = useT(),
    hintId = useId();
  const [tab, setTab] = useState<'story' | 'ooc'>('story');
  const [channel, setChannel] = useState<'say' | 'whisper'>('say');
  const [text, setText] = useState(''),
    [feed, setFeed] = useState<StoryTurnFeed | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [uncertain, setUncertain] = useState(false);
  const [newEvents, setNewEvents] = useState(false);
  const feedElement = useRef<HTMLDivElement>(null),
    nearBottom = useRef(true);
  const epoch = useRef(0),
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
  const draftKey = storyDraftKey(text, channel, targetNpcId, projection.map.id);
  const currentDraft = useRef(draftKey);
  currentDraft.current = draftKey;
  const path = `/game/campaigns/${campaignId}/turns`;
  const refresh = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    const current = epoch.current;
    try {
      const result = await api<StoryTurnFeed>(`${path}/feed`);
      if (current !== epoch.current) return;
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
      if (current === epoch.current) {
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
    // Copy is evaluated on response; requests are scoped by campaign, not by locale.
  }, [path]);
  useEffect(() => {
    epoch.current++;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      epoch.current++;
      clearInterval(timer);
    };
  }, [refresh]);
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
  const lastEntry = feed?.entries.at(-1)?.id;
  useEffect(() => {
    const element = feedElement.current;
    if (!element) return;
    if (nearBottom.current) element.scrollTop = element.scrollHeight;
    else setNewEvents(true);
  }, [lastEntry]);
  const available =
    !!feed?.canSubmit &&
    feed.configuration.enabled &&
    (feed.configuration.provider === 'mock' || feed.configuration.externalCallsEnabled);
  const pendingTurns =
    feed?.turns.filter(
      (entry) => entry.status === 'queued' || entry.status === 'awaiting_confirmation',
    ) || [];
  const pending = !!submitted.current || pendingTurns.length > 0;
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
      ...(targetNpcId ? { targetNpcId } : {}),
      expectedCanonRevision: feed.canonRevision,
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
        (!available ||
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
    if (!recover && Date.parse(quote.expiresAt) <= Date.now()) {
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
  function actionsPreview(actions: StoryActionPreview[]) {
    return (
      <ul>
        {actions.map((entry, index) => {
          const target =
            projection.entities.find((entity) => entity.id === entry.action.targetId)?.label ||
            projection.map.exits.find((exit) => exit.id === entry.action.targetId)?.label;
          const item = projection.inventory.find(
            (entity) => entity.id === entry.action.itemId,
          )?.label;
          return (
            <li key={index}>
              {t(actionLabels[entry.action.kind])}
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
    if (entry.action) return `${t(actionLabels[entry.action.kind])} — ${outcome}`;
    return outcome;
  }
  return (
    <section
      className={styles.panel}
      aria-label={h('title')}
      data-testid="unified-story"
      data-canon-revision={feed?.canonRevision}
    >
      <div className={styles.tabs} role="tablist" aria-label={h('title')}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'story'}
          onClick={() => setTab('story')}
        >
          {h('title')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'ooc'}
          onClick={() => setTab('ooc')}
        >
          {h('ooc')}
        </button>
        {feed && (
          <small className={styles.badge}>
            {h(feed.configuration.provider === 'mock' ? 'mock' : 'external')}
          </small>
        )}
      </div>
      <div hidden={tab !== 'story'}>
        <div className={styles.story}>
          <div
            className={styles.feed}
            role="log"
            aria-label={h('title')}
            aria-live="polite"
            aria-relevant="additions"
            data-testid="story-feed"
            ref={feedElement}
            onScroll={() => {
              const element = feedElement.current;
              if (element)
                nearBottom.current =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 80;
            }}
          >
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
          {newEvents && (
            <button
              type="button"
              onClick={() => {
                if (feedElement.current)
                  feedElement.current.scrollTop = feedElement.current.scrollHeight;
                nearBottom.current = true;
                setNewEvents(false);
              }}
            >
              {h('newEvents')}
            </button>
          )}
          <form
            className={styles.composer}
            onSubmit={(event) => {
              event.preventDefault();
              if (prepared) void submit();
              else void prepare();
            }}
          >
            <div className={styles.recipient}>
              <span>{recipient ? `${h('target')}: ${recipient.label}` : h('scene')}</span>
              {recipient && (
                <button
                  type="button"
                  aria-label={h('clear')}
                  disabled={busy || pending}
                  onClick={onClearRecipient}
                >
                  ×
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
            <Textarea
              aria-label={h('composer')}
              aria-describedby={hintId}
              value={text}
              maxLength={1000}
              rows={3}
              placeholder={h('placeholder')}
              disabled={disabled || busy || pending || uncertain}
              onChange={(event) => {
                setText(event.target.value);
                setPrepared(null);
                setNotice('');
              }}
            />
            <p id={hintId} className={styles.hint}>
              {h('hint')}
            </p>
            <ErrorBox message={error} />
            {notice && (
              <p className={styles.status} role="status">
                {notice}
              </p>
            )}
            {feed && !available && <p className={styles.status}>{h('unavailable')}</p>}
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
                      {h('generationCost', { credits: turn.generationCost ?? '—' })}
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
                <p>{h('cost', { credits: prepared.result.quote.credits })}</p>
                {prepared.result.quote.demo && <small>{h('demo')}</small>}
                {prepared.result.quote.external && (
                  <p>
                    {providerBoundKnown(prepared.result.quote, true)
                      ? h('ceiling', {
                          amount: (prepared.result.quote.providerUpperMicros / 1000000).toFixed(6),
                        })
                      : h('noBound')}
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
            {!prepared && !pending && !uncertain && (
              <Button
                type="submit"
                busy={busy}
                disabled={disabled || busy || !available || !targetValid || !text.trim()}
              >
                {h('send')}
              </Button>
            )}
            {(pending || uncertain) && (
              <Button type="button" variant="secondary" onClick={() => void refresh()}>
                {h('refresh')}
              </Button>
            )}
          </form>
          <div className={styles.media}>
            <SceneMedia
              key={`${projection.map.id}:${feed?.canonRevision ?? 0}`}
              campaignId={campaignId}
              projection={projection}
              disabled={disabled || busy}
              onApplied={onWorldRefresh}
            />
          </div>
        </div>
      </div>
      <div hidden={tab !== 'ooc'} className={styles.ooc}>
        <PartyChat campaignId={campaignId} actorId={projection.actorId} disabled={disabled} />
      </div>
    </section>
  );
}
