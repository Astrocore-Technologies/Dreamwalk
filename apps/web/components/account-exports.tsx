'use client';
import { useState } from 'react';
import { api, errorMessage, useClient, useDate, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Loading } from './ui';

type ExportRequest = {
  id: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
};

export function AccountExports() {
  const { t } = useT();
  const date = useDate();
  const { toast } = useClient();
  const requests = useResource<ExportRequest[]>('/account/exports');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const statuses: Record<string, string> = {
    requested: t('Экспорт ожидает обработки'),
    processing: t('Экспорт готовится'),
    completed: t('Экспорт готов'),
    failed: t('Экспорт не удалось подготовить'),
    expired: t('Срок хранения экспорта истёк'),
  };
  return (
    <section className="stack" aria-label={t('Архивы моих данных')}>
      <p className="muted">
        {t('Архив готовит оператор. Готовый файл доступен только тебе в течение 7 дней.')}
      </p>
      <div className="row">
        <Button
          variant="secondary"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await api('/account/export', { method: 'POST', body: '{}' });
              toast(t('Запрос на экспорт данных сохранён'));
              requests.reload();
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('Запросить экспорт')}
        </Button>
        <Button variant="ghost" onClick={requests.reload}>
          {t('Обновить список архивов')}
        </Button>
      </div>
      <ErrorBox message={error || requests.error} />
      {requests.loading ? (
        <Loading />
      ) : requests.data?.length ? (
        <ul className="stack">
          {requests.data.map((request) => (
            <li key={request.id}>
              <strong>{statuses[request.status] || t('Экспорт готовится')}</strong>
              <span className="muted"> · {date(request.createdAt)}</span>
              {request.status === 'completed' && request.expiresAt && (
                <div>
                  <a
                    className="button secondary"
                    href={`/api/v1/account/exports/${request.id}/download`}
                    download
                  >
                    {t('Скачать мои данные')}
                  </a>
                  <p className="muted">
                    {t('Доступно до {date}', { date: date(request.expiresAt) })}
                  </p>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t('Запросов на экспорт пока нет')}</p>
      )}
    </section>
  );
}
