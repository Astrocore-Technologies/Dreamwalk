'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, errorMessage, useClient } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ButtonLink, ErrorBox, Field, Input, Panel } from './ui';

export function EmailActionPage({ action }: { action: 'reset' | 'verify' }) {
  const { t } = useT();
  const { refresh, setUser } = useClient();
  const [token, setToken] = useState('');
  const readFragment = useRef(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (readFragment.current) return;
    readFragment.current = true;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    setToken(fragment.get('token') || '');
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setReady(true);
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api(action === 'reset' ? '/auth/reset-password/confirm' : '/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify(
          action === 'reset' ? { token, password: data.get('password') } : { token },
        ),
      });
      setToken('');
      if (action === 'reset') setUser(null);
      else await refresh();
      setDone(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel className="form-panel">
      <h1>{action === 'reset' ? t('Новый пароль') : t('Подтвердить email')}</h1>
      {done ? (
        <div className="stack">
          <p role="status">
            {action === 'reset'
              ? t('Пароль обновлён. Войди снова на своих устройствах.')
              : t('Email подтверждён')}
          </p>
          <ButtonLink href={action === 'reset' ? '/auth/sign-in' : '/account/sessions'}>
            {action === 'reset' ? t('Войти') : t('Безопасность')}
          </ButtonLink>
        </div>
      ) : ready && !token ? (
        <div className="stack">
          <ErrorBox
            message={t('В ссылке нет кода. Открой письмо заново или запроси новую ссылку.')}
          />
          <ButtonLink href={action === 'reset' ? '/auth/reset-password' : '/account/sessions'}>
            {t('Запросить новую ссылку')}
          </ButtonLink>
        </div>
      ) : (
        <form method="post" className="stack" onSubmit={submit}>
          <p className="muted">{t('Подтверди действие. Ссылка используется только один раз.')}</p>
          {action === 'reset' && (
            <Field label={t('Новый пароль')}>
              <Input
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={10}
                maxLength={128}
              />
            </Field>
          )}
          <ErrorBox message={error} />
          <Button busy={busy} disabled={!ready || !token}>
            {action === 'reset' ? t('Изменить пароль') : t('Подтвердить email')}
          </Button>
        </form>
      )}
    </Panel>
  );
}

export function EmailVerification() {
  const { t } = useT();
  const { user } = useClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  return (
    <Panel>
      <h2>{t('Подтверждение email')}</h2>
      <p>{user?.emailVerified ? t('Email подтверждён') : t('Email пока не подтверждён')}</p>
      {!user?.emailVerified && (
        <Button
          variant="secondary"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            setMessage('');
            try {
              const result = await api<{ code: string }>('/account/email-verification/request', {
                method: 'POST',
                body: '{}',
              });
              setMessage(
                result.code === 'EMAIL_DELIVERY_UNAVAILABLE'
                  ? t('Почтовая доставка пока не настроена.')
                  : t(
                      'Проверь почту. Если доставка доступна, письмо со ссылкой придёт в ближайшее время.',
                    ),
              );
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('Отправить ссылку подтверждения')}
        </Button>
      )}
      {message && <p role="status">{message}</p>}
      <ErrorBox message={error} />
    </Panel>
  );
}
