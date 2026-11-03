'use client';
import { useRef, useState, type ReactNode } from 'react';
import {
  formatSparkSubunits,
  type ReleasePolicyProfile as Profile,
  type ReleasePolicyReview as Review,
  type ReleasePolicyReceipt,
} from '@dreamwalk/contracts';
import { api, errorMessage, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Loading, Modal } from '../ui';

const labels: Record<string, string> = {
  model: 'Модель',
  maxOutputTokens: 'Токены обычного ответа',
  storyPlanMaxOutputTokens: 'Токены плана истории',
  contextTokens: 'Контекст модели',
  contextBudgetTokens: 'Бюджет контекста',
  maxInputBytes: 'Максимум входных байтов',
  inputMicrosPerMillion: 'Вход: USD за миллион токенов',
  outputMicrosPerMillion: 'Выход: USD за миллион токенов',
  inputTextMicrosPerMillion: 'Текстовый вход: USD за миллион токенов',
  inputImageMicrosPerMillion: 'Изображения на входе: USD за миллион токенов',
  outputImageMicrosPerMillion: 'Изображения на выходе: USD за миллион токенов',
  cachedInputMicrosPerMillion: 'Чтение кеша: USD за миллион токенов',
  cacheWrite30mMicrosPerMillion: 'Кеш 30 минут: USD за миллион токенов',
  cacheWrite12hMicrosPerMillion: 'Кеш 12 часов: USD за миллион токенов',
  cachePricing: 'Тарифы кеша',
  estimation: 'Расчёт оценки',
  pricing: 'Проверка тарифов',
  counting: 'Подсчёт токенов',
  upperMicros: 'Резерв USD',
  reserveMicros: 'Резерв USD',
  estimatedTotalMicros: 'Оценка USD',
  fixedMarginMicros: 'Дополнительный резерв USD',
  referenceAllowanceMicros: 'Резерв для референсов USD',
  microsPerRequest: 'Стоимость подсчёта USD',
  marginBps: 'Запас оценки, базисные пункты',
  textTokensPerKiBUtf8: 'Токены на КиБ текста',
  textProtocolTokens: 'Служебные токены',
  outputImageTokens: 'Выходные токены изображения',
  referenceImageTokensPerImage: 'Токены на референс',
  source: 'Источник тарифов',
  reviewedAt: 'Дата проверки',
  validUntil: 'Тарифы действуют до',
  size: 'Размер',
  quality: 'Качество',
  outputs: 'Количество изображений',
  format: 'Формат',
  maxPromptUtf8Bytes: 'Максимум байтов описания',
  maxReferenceImages: 'Максимум референсов',
  framingPolicy: 'Границы размеров',
  maxAspectRatio: 'Максимальное соотношение сторон',
  minPixels: 'Минимум пикселей',
  maxPixels: 'Максимум пикселей',
  maxEdge: 'Максимальная сторона',
  reviewedOutputImageTokens: 'Проверенный предел токенов изображения',
};
const blockerLabels: Record<string, string> = {
  GENERATION_POLICY_BUSY: 'Есть незавершённая генерация. Дождись результата и проверь состояние.',
  LIVE_OUTCOME_UNRESOLVED:
    'Исход прежней генерации неизвестен. Сначала нужно проверить её результат.',
  GENERATION_RELEASE_LIMIT_CHANGE_UNSUPPORTED:
    'Лимиты расходов изменились. Этот способ обновления не разрешает менять лимиты.',
  GENERATION_PRICING_EXPIRED: 'Тарифы устарели. Сначала обнови проверенные цены.',
  GENERATION_POLICY_UNCHANGED: 'Этот профиль уже действует для аккаунта.',
  GENERATION_PRIOR_LIABILITY_UNRESOLVED:
    'Исход прежней генерации неизвестен. Сначала нужно проверить её результат.',
};
function ProfileDetails({ profile }: { profile: Profile }) {
  const { t } = useT();
  const fields = (value: Record<string, unknown>, prefix = ''): ReactNode[] =>
    Object.entries(value).flatMap<ReactNode>(([key, item]) => {
      if (!(key in labels)) return [];
      const title = prefix + t(labels[key]);
      if (item && typeof item === 'object')
        return fields(item as Record<string, unknown>, `${title}: `);
      return [
        <li key={title}>
          {title}:{' '}
          {typeof item === 'number' && key.toLowerCase().includes('micros')
            ? (item / 1_000_000).toFixed(6)
            : String(item)}
        </li>,
      ];
    });
  return (
    <>
      <p>
        {t('Текст')}: {profile.text.model} · {t('Токены обычного ответа')}:{' '}
        {profile.text.maxOutputTokens} · {t('Токены плана истории')}:{' '}
        {profile.text.storyPlanMaxOutputTokens ?? profile.text.maxOutputTokens}
      </p>
      <details>
        <summary>{t('Тарифы и границы профиля')}</summary>
        <p>{t('Текст')}</p>
        <ul>{fields(profile.text)}</ul>
        <p>{t('Изображения')}</p>
        <ul>{fields(profile.image)}</ul>
        <p>
          {t('Лимиты расходов USD')}:{' '}
          {[
            profile.totalCapMicros,
            profile.textCapMicros,
            profile.imageCapMicros,
            profile.aggregateCapMicros,
          ]
            .map((v) => (v === null ? t('Без лимита') : (v / 1_000_000).toFixed(6)))
            .join(' / ')}
        </p>
        <p className="muted">{t('Всего / текст / изображения / платформа')}</p>
      </details>
    </>
  );
}
export function ReleasePolicyReview({
  actorId,
  name,
  onClose,
}: {
  actorId: string;
  name: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const review = useResource<Review>(`/generation/release-policy/${actorId}`);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [done, setDone] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const gate = useRef(false);
  async function refresh() {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError('');
    try {
      const data = await api<Review>(`/generation/release-policy/${actorId}`);
      review.setData(data);
      setDone(data.active.hash === data.proposed.candidateFingerprint);
      setUncertain(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  async function adopt() {
    const data = review.data;
    if (gate.current || !data?.proposed.canApply || uncertain) return;
    gate.current = true;
    setBusy(true);
    setError('');
    try {
      const operationId = crypto.randomUUID();
      const receipt = await api<ReleasePolicyReceipt | null>(
        `/generation/release-policy/${actorId}/revisions`,
        {
          method: 'POST',
          body: JSON.stringify({
            operationId,
            expectedRevision: data.active.revision,
            expectedHash: data.active.hash,
            candidateFingerprint: data.proposed.candidateFingerprint,
            consent: true,
          }),
        },
      );
      if (
        !receipt ||
        receipt.status !== 'applied' ||
        receipt.operationId !== operationId ||
        receipt.revision !== data.active.revision + 1 ||
        receipt.hash !== data.proposed.candidateFingerprint ||
        receipt.candidateFingerprint !== data.proposed.candidateFingerprint
      )
        throw new Error(
          t('Подтверждение не получено. Проверь состояние перед повторным действием.'),
        );
      setDone(true);
    } catch (e) {
      setError(errorMessage(e));
      setUncertain(true);
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`${t('Настройки генерации')}: ${name}`}
      onClose={() => {
        if (!gate.current) onClose();
      }}
    >
      <ErrorBox
        message={error || review.error}
        retry={review.error && !busy ? review.reload : undefined}
      />
      {review.loading ? (
        <Loading />
      ) : done ? (
        <p>{t('Настройки подтверждены. Теперь можно получить новую оценку стоимости.')}</p>
      ) : (
        review.data && (
          <>
            <h3>{t('Текущий профиль')}</h3>
            {review.data.active.profile ? (
              <ProfileDetails profile={review.data.active.profile} />
            ) : (
              <p>
                {t(
                  'Прежний профиль и лимит расходов платформы не сохранены: нельзя проверить, что они не изменились. Проверь новый профиль целиком.',
                )}
              </p>
            )}
            <h3>{t('Новый профиль')}</h3>
            <ProfileDetails profile={review.data.proposed.profile} />
            <p>
              {t('Новый лимит расходов платформы USD')}:{' '}
              {review.data.proposed.profile.aggregateCapMicros === null
                ? t('Без лимита')
                : (review.data.proposed.profile.aggregateCapMicros / 1_000_000).toFixed(6)}
            </p>
            <p>
              {t(
                'Баланс и прежние резервы сохранятся. Для новой генерации потребуется новая оценка и отдельное подтверждение.',
              )}
            </p>
            {review.data.pendingSparkHolds.length > 0 && (
              <p>
                {t('Ожидают отдельного расчёта')}:{' '}
                {formatSparkSubunits(
                  review.data.pendingSparkHolds
                    .reduce((sum, hold) => sum + BigInt(hold.reservedSubunits), 0n)
                    .toString(),
                )}{' '}
                {t('Искры')}
              </p>
            )}
            {!review.data.proposed.canApply && (
              <p role="status">
                {t(
                  blockerLabels[review.data.proposed.blockers[0]] ||
                    'Обновление пока недоступно. Сначала нужно проверить незавершённые операции или ограничения аккаунта.',
                )}
              </p>
            )}
            {uncertain ? (
              <Button variant="secondary" busy={busy} onClick={() => void refresh()}>
                {t('Проверить состояние')}
              </Button>
            ) : (
              <Button
                busy={busy}
                disabled={review.loading || !review.data.proposed.canApply}
                onClick={() => void adopt()}
              >
                {t('Подтвердить новый профиль')}
              </Button>
            )}
          </>
        )
      )}
    </Modal>
  );
}
