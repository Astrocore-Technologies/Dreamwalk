'use client';
import type { GameProjection } from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
import styles from './game.module.css';
const promiseLabels = {
  accepted: 'Обещание принято',
  fulfilled: 'Обещание выполнено',
  broken: 'Обещание не выполнено',
  cancelled: 'Обещание отменено',
};
const noticeLabels = {
  investigating: 'NPC проверяет замеченное событие',
  warned: 'NPC передал предупреждение',
  promised: 'NPC дал обещание',
  fulfilled: 'NPC выполнил обещание',
  promise_broken: 'NPC не смог выполнить обещание',
  patrolling: 'NPC продолжил патруль',
  door_closed: 'NPC закрыл дверь',
  distracted: 'NPC отвлёкся',
  heard: 'NPC услышал звук',
} as const;
/** Only the server-projected audience receives these notices. Never reads private brain state. */
export function LivingNotices({ projection }: { projection: GameProjection }) {
  const { t } = useT();
  if (projection.rulesetVersion !== 'hybrid-v3') return null;
  return (
    <>
      <section aria-label={t('События рядом')}>
        <h2>{t('События рядом')}</h2>
        <p className={styles.muted}>
          {t('Скрытые мысли и чужие разговоры не показываются в журнале.')}
        </p>
        <ol className={styles.journal} aria-live="polite" aria-relevant="additions">
          {projection.npcNotices?.length ? (
            projection.npcNotices.map((notice) => (
              <li key={notice.id} data-npc-notice={notice.kind}>
                {t(noticeLabels[notice.kind])}
                {projection.entities.find((entity) => entity.id === notice.npcId)?.label
                  ? ` · ${projection.entities.find((entity) => entity.id === notice.npcId)!.label}`
                  : ''}
              </li>
            ))
          ) : (
            <li className={styles.muted}>{t('Новых событий пока нет')}</li>
          )}
        </ol>
      </section>
      <section aria-label={t('Обещания тебе')}>
        <h2>{t('Обещания тебе')}</h2>
        <p className={styles.muted}>
          {t('Здесь только обещания, адресованные твоему герою. Слова не создают предметы.')}
        </p>
        <ul className={styles.journal}>
          {projection.npcObligations?.length ? (
            projection.npcObligations.map((promise) => (
              <li key={promise.id} data-npc-obligation={promise.status}>
                {t(promiseLabels[promise.status])} ·{' '}
                {projection.entities.find((entity) => entity.id === promise.npcId)?.label ||
                  t('NPC')}
                {' · '}
                {projection.entities.find((entity) => entity.id === promise.itemId)?.label ||
                  projection.inventory.find((entity) => entity.id === promise.itemId)?.label ||
                  t('Предмет')}
              </li>
            ))
          ) : (
            <li className={styles.muted}>{t('Пока нет обещаний')}</li>
          )}
        </ul>
      </section>
    </>
  );
}
