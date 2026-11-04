'use client';
import { useState } from 'react';
import { BookOpen, UserRound } from 'lucide-react';
import { assetUrl } from '@/lib/client';
import styles from './admin-detail.module.css';

/** Use authorized persisted media only. A missing/revoked image is not stock artwork. */
export function AdminCover({ assetId }: { assetId?: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className={styles.cover} aria-hidden="true">
      {assetId && failed !== assetId ? (
        <img src={assetUrl(assetId)} alt="" onError={() => setFailed(assetId)} />
      ) : (
        <BookOpen size={36} />
      )}
    </span>
  );
}
export function AdminAvatar({ name, assetId }: { name: string; assetId?: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className={styles.avatar} aria-hidden="true">
      {assetId && failed !== assetId ? (
        <img src={assetUrl(assetId)} alt="" onError={() => setFailed(assetId)} />
      ) : name.trim() ? (
        Array.from(name.trim())[0].toLocaleUpperCase()
      ) : (
        <UserRound size={20} />
      )}
    </span>
  );
}
