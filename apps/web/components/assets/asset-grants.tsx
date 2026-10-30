'use client';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, useResource } from '@/lib/client';
import { Button, ErrorBox, Field, Input } from '@/components/ui';
import type { ArtGrant, ArtRevision } from './types';
import { useAssetText } from './messages';
import styles from './assets.module.css';
export function AssetGrants({
  revision,
  onChanged,
}: {
  revision: ArtRevision;
  onChanged: () => void;
}) {
  const a = useAssetText();
  const path = `/asset-library/revisions/${revision.id}`;
  const grants = useResource<ArtGrant[]>(revision.owned ? `${path}/grants` : null);
  const [handle, setHandle] = useState(''),
    [consent, setConsent] = useState(false),
    [withdraw, setWithdraw] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const retry = useRef<{ key: string; id: string } | null>(null),
    epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    setHandle('');
    setConsent(false);
    setWithdraw(false);
    setBusy(false);
    setError('');
    retry.current = null;
    return () => {
      epoch.current++;
    };
  }, [revision.id]);
  async function mutate(endpoint: string, body: Record<string, unknown>) {
    const generation = epoch.current,
      key = JSON.stringify({ endpoint, body });
    if (retry.current?.key !== key) retry.current = { key, id: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({ ...body, operationId: retry.current.id }),
      });
      if (generation === epoch.current) {
        retry.current = null;
        setConsent(false);
        setWithdraw(false);
        grants.reload();
        onChanged();
      }
    } catch (err) {
      if (generation === epoch.current) setError(errorMessage(err));
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  if (!revision.owned) return null;
  return (
    <section className={styles.root} aria-label={a('grants')}>
      <h3>{a('grants')}</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (consent)
            void mutate(`${path}/grants`, {
              granteeHandle: handle.trim(),
              consent: true,
              retainExistingPins: true,
            });
        }}
      >
        <fieldset disabled={busy}>
          <Field label={a('handle')}>
            <Input
              maxLength={40}
              value={handle}
              onChange={(event) => {
                setHandle(event.target.value);
                setConsent(false);
              }}
            />
          </Field>
          <label>
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            {a('pinConsent')}
          </label>
          <Button
            type="submit"
            disabled={
              !revision.metadata.rights.allowAuthorReuse ||
              !consent ||
              !/^[A-Za-z0-9_-]{3,40}$/.test(handle.trim())
            }
          >
            {a('grant')}
          </Button>
        </fieldset>
      </form>
      <ErrorBox message={error || grants.error} />
      <ul>
        {grants.data?.map((grant) => (
          <li key={grant.id}>
            {grant.granteeHandle || a('shared')} ·{' '}
            {grant.revoked ? (
              a('revoked')
            ) : (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => void mutate(`${path}/grants/${grant.id}/revoke`, {})}
              >
                {a('revoke')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <fieldset disabled={busy}>
        <label>
          <input
            type="checkbox"
            checked={withdraw}
            onChange={(event) => setWithdraw(event.target.checked)}
          />
          {a('withdrawConsent')}
        </label>
        <Button
          type="button"
          variant="secondary"
          disabled={!withdraw}
          onClick={() => void mutate(`${path}/takedown`, { confirm: true })}
        >
          {a('withdraw')}
        </Button>
      </fieldset>
    </section>
  );
}
