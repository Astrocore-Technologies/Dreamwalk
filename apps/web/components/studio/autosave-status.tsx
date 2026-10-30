'use client';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui';
import type { DraftSaveStatus } from '@/lib/draft-save-controller';
const labels: Record<DraftSaveStatus, string> = {
  saved: 'Автосохранено',
  pending: 'Ожидание автосохранения',
  saving: 'Автосохранение…',
  invalid: 'Изменения пока только здесь: исправь неполные или неверные поля.',
  error: 'Не удалось сохранить. Изменения остаются здесь; повтори сохранение.',
  conflict: 'На сервере уже другая версия. Автосохранение остановлено, твой ввод не заменён.',
};
export function AutosaveStatus({
  status,
  enabled,
  retry,
  reload,
}: {
  status: DraftSaveStatus;
  enabled: boolean;
  retry: () => void;
  reload: () => void;
}) {
  const { t } = useT();
  return (
    <div role="status" className="notice" data-autosave-status={enabled ? status : 'disabled'}>
      <span>
        {t(
          enabled
            ? labels[status]
            : 'Первый черновик сохрани кнопкой. Затем изменения сохраняются автоматически.',
        )}
      </span>
      {enabled && status === 'error' && (
        <Button type="button" variant="ghost" onClick={retry}>
          {t('Повторить сохранение')}
        </Button>
      )}
      {enabled && status === 'conflict' && (
        <Button type="button" variant="ghost" onClick={reload}>
          {t('Загрузить серверную версию')}
        </Button>
      )}
    </div>
  );
}
