'use client';
import { useState } from 'react';
import { MoonStar } from 'lucide-react';
import { formatSparkSubunits, type User } from '@dreamwalk/contracts';
import { api, errorMessage, useClient, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { readDreamsWallet, type DreamsWallet } from '@/lib/dreams-wallet';
import { Button, ErrorBox, Field, Input, Modal, Panel, Select, Textarea } from '../ui';
import { useToolDialog } from './admin-tool-dialog';
import { adminDreamsCopy } from './admin-dreams-copy';
import styles from './admin.module.css';

/** The right-hand panel has its own recipient, draft, confirmation and replay identity. */
export function AdminDreams({ users }: { users: ReturnType<typeof useResource<User[]>> }) {
  const { t, locale } = useT(),
    { toast } = useClient();
  const text = adminDreamsCopy[locale];
  const [userId, setUserId] = useState(''),
    [amount, setAmount] = useState(100),
    [reason, setReason] = useState(''),
    [key, setKey] = useState(() => crypto.randomUUID()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirm, setConfirm] = useState(false),
    [result, setResult] = useState<DreamsWallet | null>(null);
  const dialog = useToolDialog(confirm, () => setConfirm(false));
  const valid = Number.isInteger(amount) && amount > 0 && amount <= 922337203685477;
  const recipient = users.data?.find((u) => u.id === userId);
  async function grant() {
    if (dialog.pending.current) return;
    dialog.pending.current = true;
    setBusy(true);
    setError('');
    try {
      const wallet = await api<unknown>('/admin/dreams', {
        method: 'POST',
        body: JSON.stringify({ userId, amount, reason, idempotencyKey: key }),
      });
      setResult(readDreamsWallet(wallet, userId));
      setKey(crypto.randomUUID());
      setConfirm(false);
      toast(text.done);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      dialog.pending.current = false;
      setBusy(false);
    }
  }
  return (
    <div data-admin-currency="dreams">
      <Panel>
        <h3>{text.title}</h3>
        <form
          method="post"
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            setError('');
            dialog.capture();
            setConfirm(true);
          }}
        >
          <Field label={t('Пользователь')}>
            <Select
              aria-label={t('Пользователь')}
              value={userId}
              required
              onChange={(e) => {
                setUserId(e.target.value);
                setResult(null);
              }}
            >
              <option value="">{t('Выберите пользователя')}</option>
              {users.data?.map((u) => (
                <option value={u.id} key={u.id}>
                  {u.name} (@{u.handle})
                </option>
              ))}
            </Select>
          </Field>
          <ErrorBox message={users.error} retry={users.reload} />
          <Field label={text.amount} hint={text.hint}>
            <Input
              aria-label={text.amount}
              required
              type="number"
              min={1}
              max={922337203685477}
              step={1}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
          </Field>
          <Field label={t('Причина операции')}>
            <Textarea
              aria-label={t('Причина операции')}
              required
              minLength={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('Например, награда за участие')}
            />
          </Field>
          <Button type="submit" disabled={!valid || users.loading || busy}>
            <MoonStar size={16} />
            {t('Проверить операцию')}
          </Button>
        </form>
        {result && (
          <div className={styles.result} role="status">
            <span>{t('Баланс после операции')}</span>
            <strong>
              {formatSparkSubunits(result.availableSubunits, locale)} <small>{text.name}</small>
            </strong>
          </div>
        )}
      </Panel>
      {confirm && (
        <Modal title={text.confirm} onClose={dialog.close}>
          <p>
            {recipient?.name} (@{recipient?.handle}):{' '}
            <strong>
              +{amount.toLocaleString(locale)} {text.name}
            </strong>
          </p>
          <p>{reason}</p>
          <ErrorBox message={error ? t(error) : ''} />
          <div className="form-actions">
            <Button variant="secondary" onClick={dialog.close} disabled={busy}>
              {t('Отмена')}
            </Button>
            <Button busy={busy} onClick={() => void grant()}>
              {t('Подтвердить операцию')}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
