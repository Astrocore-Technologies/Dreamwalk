'use client';
import { useEffect, useRef, useState } from 'react';
import type { Asset } from '@dreamwalk/contracts';
import { api, errorMessage } from '@/lib/client';
import { Button, ErrorBox, Field, Input, Select, UploadField } from '@/components/ui';
import { useAssetText } from './messages';
import type { ArtCamera, ArtKind, ArtMetadata, ArtRevision } from './types';
import styles from './assets.module.css';
export function RegisterArt({
  base,
  onSaved,
  onCancel,
}: {
  base?: ArtRevision;
  onSaved: (revision: ArtRevision) => void;
  onCancel?: () => void;
}) {
  const a = useAssetText();
  const [upload, setUpload] = useState<Asset | null>(null),
    [title, setTitle] = useState(base?.metadata.title || ''),
    [kind, setKind] = useState<ArtKind>(base?.metadata.kind || 'background'),
    [camera, setCamera] = useState<ArtCamera>(base?.metadata.camera || 'top-down'),
    [tags, setTags] = useState(base?.metadata.tags.join(', ') || ''),
    [variant, setVariant] = useState(base?.metadata.variant || 'default'),
    [basis, setBasis] = useState<ArtMetadata['rights']['basis']>('owned'),
    [license, setLicense] = useState(''),
    [attribution, setAttribution] = useState(''),
    [allowReuse, setAllowReuse] = useState(false),
    [attested, setAttested] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const retry = useRef<{ fingerprint: string; operationId: string } | null>(null),
    epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    setUpload(null);
    setTitle(base?.metadata.title || '');
    setKind(base?.metadata.kind || 'background');
    setCamera(base?.metadata.camera || 'top-down');
    setTags(base?.metadata.tags.join(', ') || '');
    setVariant(base?.metadata.variant || 'default');
    setAttested(false);
    setError('');
    setBusy(false);
    retry.current = null;
    return () => {
      epoch.current++;
    };
  }, [base?.id]);
  const tagList = [
    ...new Set(
      tags
        .split(',')
        .map((tag) => tag.trim().toLocaleLowerCase())
        .filter(Boolean),
    ),
  ];
  const valid =
    !!upload &&
    !!title.trim() &&
    !!variant.trim() &&
    !!license.trim() &&
    attested &&
    tagList.length <= 24 &&
    tagList.every((tag) => tag.length <= 48);
  async function save() {
    if (!upload || !valid) return;
    const generation = epoch.current;
    setBusy(true);
    setError('');
    const metadata: ArtMetadata = {
      title: title.trim(),
      kind,
      style: 'drawn2D',
      camera,
      tags: tagList,
      variant: variant.trim(),
      provenance: {
        source:
          basis === 'generated' ? 'generated' : basis === 'licensed' ? 'licensed-import' : 'upload',
      },
      rights: {
        basis,
        licenseLabel: license.trim(),
        attribution: attribution.trim(),
        allowAuthorReuse: allowReuse,
        attested: true,
      },
    };
    const body = {
        uploadId: upload.id,
        ...(base ? { familyId: base.familyId, expectedFamilyRevision: base.revision } : {}),
        metadata,
      },
      fingerprint = JSON.stringify(body);
    if (retry.current?.fingerprint !== fingerprint)
      retry.current = { fingerprint, operationId: crypto.randomUUID() };
    try {
      const result = await api<ArtRevision>('/asset-library/revisions', {
        method: 'POST',
        body: JSON.stringify({
          ...body,
          operationId: retry.current.operationId,
        }),
      });
      if (generation === epoch.current) {
        retry.current = null;
        setUpload(null);
        setAttested(false);
        onSaved(result);
      }
    } catch (err) {
      if (generation === epoch.current) setError(errorMessage(err));
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  return (
    <form
      aria-label={a(base ? 'newRevision' : 'register')}
      className={styles.root}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={busy}>
        <h3>{a(base ? 'newRevision' : 'register')}</h3>
        <p className={styles.notice}>{a('immutable')}</p>
        <UploadField
          label={a('upload')}
          onUploaded={(asset) => {
            setUpload(asset);
            setAttested(false);
          }}
        />
        {upload && (
          <p>
            {upload.width} × {upload.height}
          </p>
        )}
        <div className={styles.fields}>
          <Field label={a('name')}>
            <Input
              maxLength={120}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label={a('kind')}>
            <Select
              aria-label={a('kind')}
              value={kind}
              onChange={(event) => setKind(event.target.value as ArtKind)}
            >
              {(['background', 'portrait', 'sprite', 'object', 'effect', 'ui'] as const).map(
                (key) => (
                  <option key={key} value={key}>
                    {a(key)}
                  </option>
                ),
              )}
            </Select>
          </Field>
          <Field label={a('camera')}>
            <Select
              aria-label={a('camera')}
              value={camera}
              onChange={(event) => setCamera(event.target.value as ArtCamera)}
            >
              {(['top-down', 'side', 'isometric', 'portrait', 'unrestricted'] as const).map(
                (key) => (
                  <option key={key} value={key}>
                    {a(key)}
                  </option>
                ),
              )}
            </Select>
          </Field>
          <Field label={a('variant')}>
            <Input
              maxLength={80}
              value={variant}
              onChange={(event) => setVariant(event.target.value)}
            />
          </Field>
          <Field label={a('tags')}>
            <Input
              value={tags}
              maxLength={1200}
              onChange={(event) => setTags(event.target.value)}
            />
          </Field>
          <Field label={a('basis')}>
            <Select
              aria-label={a('basis')}
              value={basis}
              onChange={(event) => {
                setBasis(event.target.value as typeof basis);
                setAttested(false);
              }}
            >
              {(['owned', 'licensed', 'generated'] as const).map((key) => (
                <option key={key} value={key}>
                  {a(key)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={a('license')}>
            <Input
              value={license}
              maxLength={120}
              onChange={(event) => {
                setLicense(event.target.value);
                setAttested(false);
              }}
            />
          </Field>
          <Field label={a('attribution')}>
            <Input
              value={attribution}
              maxLength={240}
              onChange={(event) => setAttribution(event.target.value)}
            />
          </Field>
        </div>
        <label>
          <input
            type="checkbox"
            checked={allowReuse}
            onChange={(event) => {
              setAllowReuse(event.target.checked);
              setAttested(false);
            }}
          />
          {a('allowReuse')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={attested}
            onChange={(event) => setAttested(event.target.checked)}
          />
          {a('attest')}
        </label>
        <div className={styles.actions}>
          <Button type="submit" busy={busy} disabled={!valid}>
            {a('register')}
          </Button>
          {onCancel && (
            <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
              {a('cancel')}
            </Button>
          )}
        </div>
        <ErrorBox message={error} />
      </fieldset>
    </form>
  );
}
