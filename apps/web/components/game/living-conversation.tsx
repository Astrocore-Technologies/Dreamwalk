'use client';
import { useState } from 'react';
import type { GameProjection } from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
import { Button, Field, Select, Textarea } from '@/components/ui';
import type { CommandBody } from './use-game';
import styles from './game.module.css';
export function LivingConversation({
  projection,
  disabled,
  command,
}: {
  projection: GameProjection;
  disabled: boolean;
  command: (body: Omit<CommandBody, 'protocolVersion' | 'operationId'>) => Promise<boolean>;
}) {
  const { t } = useT();
  const [npcId, setNpcId] = useState(''),
    [channel, setChannel] = useState<'say' | 'whisper'>('say'),
    [text, setText] = useState('');
  const npcs = projection.entities.filter((entity) => entity.kind === 'npc');
  const recipient = npcs.some((npc) => npc.id === npcId) ? npcId : npcs[0]?.id || '';
  if (projection.rulesetVersion !== 'hybrid-v3') return null;
  return (
    <section aria-label={t('Разговор с NPC')}>
      <h2>{t('Разговор с NPC')}</h2>
      <p className={styles.muted}>
        {t(
          'Тестовый NPC подтверждает услышанное. Свободный AI-диалог пока не подключён; реплики не меняют правила мира.',
        )}
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const sent = text;
          if (
            await command({
              type: 'npc.speech',
              npcId: recipient,
              speech: { channel, text: sent.trim() },
            })
          )
            setText((current) => (current === sent ? '' : current));
        }}
      >
        <Field label={t('Собеседник')}>
          <Select
            aria-label={t('Собеседник')}
            value={recipient}
            onChange={(event) => setNpcId(event.target.value)}
          >
            {npcs.map((npc) => (
              <option key={npc.id} value={npc.id}>
                {npc.label || t('NPC')}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('Канал разговора')}>
          <Select
            aria-label={t('Канал разговора')}
            value={channel}
            onChange={(event) => setChannel(event.target.value as 'say' | 'whisper')}
          >
            <option value="say">{t('Сказать вслух')}</option>
            <option value="whisper">{t('Шепнуть NPC')}</option>
          </Select>
        </Field>
        <Field label={t('Реплика')}>
          <Textarea
            aria-label={t('Реплика')}
            value={text}
            maxLength={1000}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        <Button type="submit" disabled={disabled || !recipient || !text.trim()}>
          {t('Произнести')}
        </Button>
      </form>
      <ol className={styles.journal} aria-live="polite">
        {projection.npcUtterances?.map((utterance) => (
          <li key={utterance.id} data-npc-utterance={utterance.code || 'speech'}>
            {utterance.speakerId === projection.actorId
              ? t('Ты')
              : projection.entities.find((entity) => entity.id === utterance.speakerId)?.label ||
                t('Голос рядом')}
            : {utterance.text || (utterance.code === 'acknowledged' ? t('Я тебя услышал.') : '')}
          </li>
        ))}
      </ol>
    </section>
  );
}
