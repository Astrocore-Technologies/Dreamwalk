'use client';
import { useEffect, useRef, useState } from 'react';
import { Trash2, RotateCcw } from 'lucide-react';
import { api, ApiError, errorMessage, useClient, useDate, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, Empty, ErrorBox, Loading, Modal } from '../ui';
import { useToolDialog } from './admin-tool-dialog';
import { adminStoryDeletionCopy } from './admin-story-deletion-copy';
import styles from './admin-detail.module.css';

type StoryTarget = { id: string; title: string; deletionRevision: string };
type DeletedStory = { id: string; title: string; deletionId: string; deletedAt: string };

export function AdminStoryDeleteButton({
  story,
  onChange,
}: {
  story: StoryTarget;
  onChange: () => void;
}) {
  const { locale, t } = useT();
  const copy = adminStoryDeletionCopy[locale];
  const { toast } = useClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const operation = useRef<{ operationId: string; expectedRevision: string } | null>(null);
  const dialog = useToolDialog(open, () => setOpen(false));
  async function remove() {
    if (dialog.pending.current || !operation.current || stale) return;
    dialog.pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ deleted: boolean }>(`/admin/adventures/${story.id}`, {
        method: 'DELETE',
        body: JSON.stringify(operation.current),
      });
      if (result.deleted) toast(copy.removed);
      setOpen(false);
      operation.current = null;
      onChange();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'STALE_STATE') {
        setStale(true);
        setError(copy.stale);
      } else setError(t(errorMessage(error)));
    } finally {
      dialog.pending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        variant="ghost"
        aria-label={copy.removeLabel.replace('{title}', story.title)}
        onClick={() => {
          dialog.capture();
          // Retain identity after an uncertain transport result, even if dismissed.
          operation.current ??= {
            operationId: crypto.randomUUID(),
            expectedRevision: story.deletionRevision,
          };
          setError('');
          setOpen(true);
        }}
      >
        <Trash2 size={18} aria-hidden="true" />
        {copy.remove}
      </Button>
      {open && (
        <Modal title={copy.removeTitle} onClose={dialog.close}>
          <p>
            <strong>{story.title}</strong>
          </p>
          <p>{copy.removeNotice}</p>
          <ErrorBox message={error} />
          <div className="form-actions">
            <Button variant="secondary" disabled={busy} onClick={dialog.close}>
              {t('Отмена')}
            </Button>
            {stale ? (
              <Button
                onClick={() => {
                  operation.current = null;
                  setStale(false);
                  setOpen(false);
                  onChange();
                }}
              >
                {copy.refresh}
              </Button>
            ) : (
              <Button variant="danger" busy={busy} onClick={() => void remove()}>
                {copy.confirmRemove}
              </Button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

export function AdminStoryTrash({ query, onChange }: { query: string; onChange: () => void }) {
  const { locale, t } = useT();
  const copy = adminStoryDeletionCopy[locale];
  const date = useDate();
  const { toast } = useClient();
  const resource = useResource<DeletedStory[]>('/admin/adventures/deleted');
  const [target, setTarget] = useState<DeletedStory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const focusAfterRestore = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const dialog = useToolDialog(!!target, () => setTarget(null));
  useEffect(() => {
    if (!target && !resource.loading && focusAfterRestore.current) {
      focusAfterRestore.current = false;
      heading.current?.focus();
    }
  }, [target, resource.loading]);
  async function restore() {
    if (!target || dialog.pending.current) return;
    dialog.pending.current = true;
    setBusy(true);
    setError('');
    try {
      await api(`/admin/adventures/${target.id}/restore`, {
        method: 'POST',
        body: JSON.stringify({ deletionId: target.deletionId }),
      });
      toast(copy.restored);
      setTarget(null);
      resource.reload();
      onChange();
      focusAfterRestore.current = true;
    } catch (error) {
      setStale(
        error instanceof ApiError && (error.code === 'STALE_STATE' || error.code === 'NOT_FOUND'),
      );
      setError(
        error instanceof ApiError && error.code === 'STALE_STATE'
          ? copy.stale
          : t(errorMessage(error)),
      );
    } finally {
      dialog.pending.current = false;
      setBusy(false);
    }
  }
  const stories =
    resource.data?.filter((story) =>
      story.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    ) ?? [];
  return (
    <section aria-label={copy.trash}>
      <h3 ref={heading} tabIndex={-1}>
        {copy.trash}
      </h3>
      <ErrorBox message={resource.error} retry={resource.reload} />
      {resource.loading ? (
        <Loading />
      ) : resource.error ? null : stories.length ? (
        <div className={`table-wrap ${styles.tableWrap}`}>
          <table className={`table ${styles.table}`}>
            <thead>
              <tr>
                <th>{copy.story}</th>
                <th>{copy.deletedAt}</th>
                <th>{copy.restore}</th>
              </tr>
            </thead>
            <tbody>
              {stories.map((story) => (
                <tr key={story.id}>
                  <td>
                    <strong>{story.title}</strong>
                  </td>
                  <td>{date(story.deletedAt)}</td>
                  <td>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        dialog.capture();
                        setTarget(story);
                        setStale(false);
                        setError('');
                      }}
                    >
                      <RotateCcw size={18} aria-hidden="true" />
                      {copy.restore}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title={resource.data?.length ? copy.noMatches : copy.empty}
          description={copy.emptyDescription}
        />
      )}
      {target && (
        <Modal title={copy.restoreTitle} onClose={dialog.close}>
          <p>
            <strong>{target.title}</strong>
          </p>
          <p>{copy.restoreNotice}</p>
          <ErrorBox message={error} />
          <div className="form-actions">
            <Button variant="secondary" disabled={busy} onClick={dialog.close}>
              {t('Отмена')}
            </Button>
            {stale ? (
              <Button
                onClick={() => {
                  setTarget(null);
                  resource.reload();
                }}
              >
                {copy.refresh}
              </Button>
            ) : (
              <Button busy={busy} onClick={() => void restore()}>
                {copy.restore}
              </Button>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
