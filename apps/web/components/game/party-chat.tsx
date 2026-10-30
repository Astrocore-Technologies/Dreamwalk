'use client';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Textarea } from '@/components/ui';
import styles from './game.module.css';
type Message = { id: string; senderActorId: string; text: string; createdAt: string };
export function PartyChat({
  campaignId,
  actorId,
  disabled,
}: {
  campaignId: string;
  actorId: string;
  disabled: boolean;
}) {
  const { t } = useT();
  const [messages, setMessages] = useState<Message[]>([]),
    [text, setText] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const pending = useRef<{ operationId: string; text: string } | null>(null),
    epoch = useRef(0);
  const path = `/game/campaigns/${campaignId}/chat`;
  useEffect(() => {
    const generation = ++epoch.current;
    setMessages([]);
    setBusy(false);
    setText('');
    setError('');
    pending.current = null;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await api<{ messages: Message[] }>(path);
        if (generation === epoch.current) setMessages(result.messages);
      } catch (err) {
        if (generation === epoch.current) setError(errorMessage(err));
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => {
      epoch.current++;
      clearInterval(timer);
    };
  }, [path]);
  async function send() {
    if (busy || !text.trim()) return;
    const generation = epoch.current;
    setBusy(true);
    setError('');
    const request =
      pending.current?.text === text.trim()
        ? pending.current
        : { operationId: crypto.randomUUID(), text: text.trim() };
    pending.current = request;
    try {
      const result = await api<{ messages: Message[] }>(path, {
        method: 'POST',
        body: JSON.stringify(request),
      });
      if (generation === epoch.current) {
        setMessages(result.messages);
        setText((value) => (value.trim() === request.text ? '' : value));
        pending.current = null;
      }
    } catch (err) {
      if (generation === epoch.current) setError(errorMessage(err));
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  return (
    <section aria-label={t('Внеигровой чат группы')}>
      <h2>{t('Внеигровой чат группы')}</h2>
      <p>
        {t(
          'Этот чат видят участники кампании. NPC его не слышат, и сообщения не передаются планировщику.',
        )}
      </p>
      <ol className={styles.journal} aria-live="polite">
        {messages.map((message) => (
          <li key={message.id}>
            {message.senderActorId === actorId ? t('Ты') : t('Участник группы')}: {message.text}
          </li>
        ))}
      </ol>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Field label={t('Сообщение группе')}>
          <Textarea
            aria-label={t('Сообщение группе')}
            maxLength={1000}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        <Button type="submit" busy={busy} disabled={disabled || !text.trim()}>
          {t('Отправить группе')}
        </Button>
      </form>
      <ErrorBox message={error} />
    </section>
  );
}
