'use client';
import { useRef, useState } from 'react';
import { Bell, BookOpen, Check, FileCheck, UsersRound } from 'lucide-react';
import { selectAdventureText } from '@dreamwalk/contracts';
import { api, useClient, useDate, useResource, errorMessage } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Badge, Button, ButtonLink, Empty, ErrorBox, Loading, PageHeading } from './ui';
import './notification-pages.css';

type Notification = {
  id: string;
  type: string;
  payload: {
    title?: string;
    reason?: string;
    decision?: string;
    adventureId?: string;
    adventureTitle?: string;
    adventureMetadata?: Parameters<typeof selectAdventureText>[0];
    inviter?: string;
  };
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
};

export function NotificationsContent() {
  const date = useDate();
  const { t: tr, locale } = useT();
  const resource = useResource<Notification[]>('/notifications');
  const { toast } = useClient();
  const pending = useRef(new Set<string>());
  const [busy, setBusy] = useState<string[]>([]);

  async function markRead(id: string) {
    if (pending.current.has(id)) return;
    pending.current.add(id);
    setBusy([...pending.current]);
    try {
      await api(`/notifications/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ read: true }),
      });
      resource.reload();
    } catch (error) {
      toast(errorMessage(error));
    } finally {
      pending.current.delete(id);
      setBusy([...pending.current]);
    }
  }

  return (
    <section className="notifications-page">
      <PageHeading title={tr('Уведомления')} />
      <div className="notifications-banner">
        <img src="/images/notification-observatory.webp" alt="" aria-hidden="true" />
      </div>
      <ErrorBox message={resource.error} retry={resource.reload} />
      {resource.loading ? (
        <Loading />
      ) : resource.data?.length ? (
        <div className="notification-list">
          {resource.data.map((n) => {
            const Icon =
              n.type === 'invitation'
                ? UsersRound
                : n.type === 'moderation'
                  ? FileCheck
                  : n.type === 'welcome'
                    ? BookOpen
                    : Bell;
            return (
              <article className="notification-card" data-read={n.read} key={n.id}>
                <div className="notification-symbol" aria-hidden="true">
                  <Icon size={40} strokeWidth={1.4} />
                </div>
                <div className="notification-content">
                  <header className="notification-heading">
                    <h2>
                      {n.type === 'welcome'
                        ? tr('Добро пожаловать в Dreamwalk')
                        : n.type === 'moderation'
                          ? tr('Результат модерации')
                          : n.type === 'invitation'
                            ? tr('Приглашение в частный мир')
                            : n.title}
                      {!n.read && <Badge>{tr('Новое')}</Badge>}
                    </h2>
                    <time dateTime={n.createdAt}>
                      {date(n.createdAt, { hour: '2-digit', minute: '2-digit' })}
                    </time>
                  </header>
                  <p>
                    {n.type === 'welcome'
                      ? tr('Твоя история начинается здесь. Создай героя или открой новый мир.')
                      : n.type === 'moderation'
                        ? `${n.payload.title || ''}: ${n.payload.reason || ''}`
                        : n.type === 'invitation'
                          ? tr('{name} приглашает тебя в мир «{title}».', {
                              name: n.payload.inviter || '',
                              title: n.payload.adventureMetadata
                                ? selectAdventureText(n.payload.adventureMetadata, locale).title
                                : n.payload.adventureTitle || '',
                            })
                          : n.message}
                  </p>
                  <div className="notification-actions">
                    {n.type === 'invitation' && (
                      <ButtonLink href="/library?tab=invitations">
                        {tr('Посмотреть приглашения')}
                      </ButtonLink>
                    )}
                    {!n.read && (
                      <Button
                        variant="ghost"
                        busy={busy.includes(n.id)}
                        onClick={() => void markRead(n.id)}
                      >
                        <Check size={16} />
                        {tr('Прочитано')}
                      </Button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : !resource.error ? (
        <Empty
          title={tr('Всё спокойно')}
          description={tr('Важные события появятся здесь. А пока можно открыть новый мир.')}
          action={<ButtonLink href="/explore">{tr('Посмотреть приключения')}</ButtonLink>}
        />
      ) : null}
    </section>
  );
}
