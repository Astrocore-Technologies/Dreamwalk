'use client';
import { useEffect, useRef, useState } from 'react';
import type { Npc, StoryLoreEntry } from '@dreamwalk/contracts';
import { api, errorMessage, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Input, Select, Textarea } from '../ui';
import { characterText, type CharacterCopyKey } from './npc-character-copy';

type Preview = {
  npcId: string;
  storyEditRevision: number;
  providerCalls: 0;
  entries: {
    id: string;
    included: boolean;
    reason: 'not_known' | 'not_relevant' | 'known_relevant';
    title?: string;
    text?: string;
    disclosure?: StoryLoreEntry['disclosure'];
  }[];
};
export function StoryLorebookEditor({
  adventureId,
  value,
  selectedNpcIds,
  locations,
  onChange,
  beforePreview,
  disabled = false,
}: {
  adventureId?: string;
  value: StoryLoreEntry[] | undefined;
  selectedNpcIds: string[];
  locations: { id: string; name: string }[];
  onChange: (entries: StoryLoreEntry[]) => void;
  beforePreview: () => Promise<unknown>;
  disabled?: boolean;
}) {
  const { locale } = useT();
  const text = (key: CharacterCopyKey) => characterText(locale, key);
  const locals = useResource<{ npcs: Npc[] }>(
    adventureId ? `/studio/adventures/${adventureId}/npcs` : null,
  );
  const templates = useResource<Npc[]>('/npcs');
  const entries = value ?? [];
  const npcs = [...(locals.data?.npcs ?? []), ...(templates.data ?? [])].filter(
    (npc, i, all) =>
      selectedNpcIds.includes(npc.id) && all.findIndex((other) => other.id === npc.id) === i,
  );
  const [npcId, setNpcId] = useState(''),
    [query, setQuery] = useState(''),
    [locationId, setLocationId] = useState('');
  const [result, setResult] = useState<{ fingerprint: string; preview: Preview } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const epoch = useRef(0),
    lock = useRef(false);
  const fingerprint = JSON.stringify({
    adventureId,
    entries,
    selectedNpcIds,
    locations,
    npcId,
    query,
    locationId,
  });
  const fingerprintRef = useRef(fingerprint);
  fingerprintRef.current = fingerprint;
  useEffect(() => {
    epoch.current++;
    setResult(null);
    setError('');
    return () => {
      epoch.current++;
    };
  }, [adventureId]);
  const selectionKey = selectedNpcIds.join(',');
  useEffect(() => {
    if (adventureId) locals.reload();
  }, [adventureId, selectionKey]);
  const update = (id: string, patch: Partial<StoryLoreEntry>) =>
    onChange(entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  async function preview() {
    if (lock.current || disabled || !adventureId || !selectedNpcIds.includes(npcId)) return;
    lock.current = true;
    setBusy(true);
    setError('');
    const stamp = epoch.current,
      inputFingerprint = fingerprint;
    try {
      const saved = await beforePreview();
      if (!saved) throw Error(text('saveFirst'));
      if (stamp !== epoch.current || inputFingerprint !== fingerprintRef.current) return;
      const response = await api<Preview>(`/studio/adventures/${adventureId}/lore-preview`, {
        method: 'POST',
        body: JSON.stringify({ npcId, query: query.trim(), ...(locationId ? { locationId } : {}) }),
      });
      const savedRevision =
        typeof saved === 'object' && saved !== null && 'editRevision' in saved
          ? saved.editRevision
          : undefined;
      if (savedRevision !== undefined && response.storyEditRevision !== savedRevision)
        throw Error(text('previewStale'));
      if (stamp === epoch.current && inputFingerprint === fingerprintRef.current)
        setResult({ fingerprint: inputFingerprint, preview: response });
    } catch (failure) {
      if (stamp === epoch.current) setError(errorMessage(failure));
    } finally {
      lock.current = false;
      if (stamp === epoch.current) setBusy(false);
    }
  }
  return (
    <section className="panel stack" data-testid="story-lorebook-editor">
      <h2>{text('lore')}</h2>
      <p className="muted">{text('loreIntro')}</p>
      <ErrorBox
        message={locals.error || templates.error}
        retry={() => {
          locals.reload();
          templates.reload();
        }}
      />
      <fieldset disabled={disabled || busy} className="stack">
        {entries.map((entry, index) => (
          <fieldset className="stack" key={entry.id}>
            <legend>
              {text('loreTitle')} {index + 1}
            </legend>
            <Field label={`${text('loreTitle')} ${index + 1}`}>
              <Input
                aria-label={`${text('loreTitle')} ${index + 1}`}
                maxLength={120}
                value={entry.title}
                onChange={(event) => update(entry.id, { title: event.target.value })}
              />
            </Field>
            <Field label={`${text('loreText')} ${index + 1}`}>
              <Textarea
                aria-label={`${text('loreText')} ${index + 1}`}
                maxLength={1000}
                value={entry.text}
                onChange={(event) => update(entry.id, { text: event.target.value })}
              />
            </Field>
            <Field label={`${text('disclosure')} ${index + 1}`}>
              <Select
                aria-label={`${text('disclosure')} ${index + 1}`}
                value={entry.disclosure}
                onChange={(event) =>
                  update(entry.id, {
                    disclosure: event.target.value as StoryLoreEntry['disclosure'],
                  })
                }
              >
                {(['never', 'asked', 'trusted', 'public'] as const).map((key) => (
                  <option key={key} value={key}>
                    {text(key)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={`${text('question')} ${index + 1}`}>
              <Input
                aria-label={`${text('question')} ${index + 1}`}
                maxLength={120}
                value={entry.publicQuestion ?? ''}
                onChange={(event) =>
                  update(entry.id, { publicQuestion: event.target.value || undefined })
                }
              />
            </Field>
            <fieldset>
              <legend>{text('knowers')}</legend>
              {!npcs.length && <p>{text('noNpc')}</p>}
              {npcs.map((npc) => (
                <label className="row" key={npc.id}>
                  <input
                    type="checkbox"
                    checked={entry.knowerNpcIds.includes(npc.id)}
                    disabled={
                      !entry.knowerNpcIds.includes(npc.id) && entry.knowerNpcIds.length >= 8
                    }
                    onChange={(event) =>
                      update(entry.id, {
                        knowerNpcIds: event.target.checked
                          ? [...entry.knowerNpcIds, npc.id]
                          : entry.knowerNpcIds.filter((id) => id !== npc.id),
                      })
                    }
                  />
                  {npc.name}
                </label>
              ))}
              {entry.knowerNpcIds
                .filter((id) => !selectedNpcIds.includes(id))
                .map((id) => (
                  <label className="row" key={id}>
                    <input
                      type="checkbox"
                      checked
                      onChange={() =>
                        update(entry.id, {
                          knowerNpcIds: entry.knowerNpcIds.filter((value) => value !== id),
                        })
                      }
                    />
                    {id}
                  </label>
                ))}
            </fieldset>
            <Field label={`${text('location')} ${index + 1}`}>
              <Select
                aria-label={`${text('location')} ${index + 1}`}
                value={entry.locationId ?? ''}
                onChange={(event) =>
                  update(entry.id, { locationId: event.target.value || undefined })
                }
              >
                <option value="">{text('anyLocation')}</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={`${text('topics')} ${index + 1}`}>
              <Textarea
                aria-label={`${text('topics')} ${index + 1}`}
                value={entry.topics?.join('\n') ?? ''}
                maxLength={245}
                onChange={(event) =>
                  update(entry.id, {
                    topics: event.target.value
                      ? event.target.value
                          .split('\n')
                          .slice(0, 6)
                          .map((topic) => topic.slice(0, 40))
                      : [],
                  })
                }
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              aria-label={`${text('remove')} ${text('loreTitle')} ${index + 1}`}
              onClick={() => onChange(entries.filter((value) => value.id !== entry.id))}
            >
              {text('remove')}
            </Button>
          </fieldset>
        ))}
        <Button
          type="button"
          variant="secondary"
          disabled={entries.length >= 16 || !selectedNpcIds.length}
          onClick={() =>
            onChange([
              ...entries,
              {
                id: `lore-${crypto.randomUUID()}`,
                title: '',
                text: '',
                disclosure: 'never',
                knowerNpcIds: [selectedNpcIds[0]],
              },
            ])
          }
        >
          {text('addLore')}
        </Button>
        {!selectedNpcIds.length && <p className="muted">{text('noNpc')}</p>}
        <fieldset className="stack">
          <legend>{text('preview')}</legend>
          <p className="muted">{text('previewHint')}</p>
          <Field label={text('previewNpc')}>
            <Select
              aria-label={text('previewNpc')}
              value={npcId}
              onChange={(event) => setNpcId(event.target.value)}
            >
              <option value="">{text('chooseNpc')}</option>
              {npcs.map((npc) => (
                <option key={npc.id} value={npc.id}>
                  {npc.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={text('previewQuery')}>
            <Input
              aria-label={text('previewQuery')}
              value={query}
              maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>
          <Field label={text('location')}>
            <Select
              aria-label={text('location')}
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
            >
              <option value="">{text('anyLocation')}</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            type="button"
            busy={busy}
            disabled={!adventureId || !selectedNpcIds.includes(npcId)}
            onClick={() => void preview()}
          >
            {text('preview')}
          </Button>
          {!adventureId && <p>{text('saveFirst')}</p>}
        </fieldset>
      </fieldset>
      <ErrorBox message={error} />
      {result && result.fingerprint !== fingerprint && <p role="status">{text('previewStale')}</p>}
      {result && result.fingerprint === fingerprint && (
        <section aria-live="polite" data-testid="lore-preview-result">
          <h3>{text('included')}</h3>
          {result.preview.entries
            .filter((entry) => entry.included)
            .map((entry) => (
              <p key={entry.id}>
                <strong>{entry.title}</strong>: {entry.text}
              </p>
            ))}
          {!result.preview.entries.some((entry) => entry.included) && <p>{text('empty')}</p>}
          <h3>{text('excluded')}</h3>
          {result.preview.entries
            .filter((entry) => !entry.included)
            .map((entry) => (
              <p key={entry.id}>
                {entry.id}: {text(entry.reason === 'not_known' ? 'notKnown' : 'notRelevant')}
              </p>
            ))}
          {!result.preview.entries.some((entry) => !entry.included) && <p>{text('empty')}</p>}
        </section>
      )}
    </section>
  );
}
