import type { ArtCamera, ArtKind, ArtRevision } from './types';
import { artCameraMatches } from './types';

export type ArtBrowseFilters = {
  query: string;
  kind: ArtKind | '';
  camera: ArtCamera | '';
  tags: string[];
  variant: string;
  minWidth: number;
  minHeight: number;
};

/** Filter only the authorized server result; this never grants reuse or fetches an original. */
export function browseArt(revisions: ArtRevision[], filters: ArtBrowseFilters): ArtRevision[] {
  const words = filters.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return revisions.filter((revision) => {
    const metadata = revision.metadata;
    const text = [metadata.title, ...metadata.tags].join(' ').toLocaleLowerCase();
    return (
      words.every((word) => text.includes(word)) &&
      (!filters.kind || metadata.kind === filters.kind) &&
      artCameraMatches(filters.camera || undefined, metadata.camera) &&
      filters.tags.every((tag) =>
        metadata.tags.some((actual) => actual.toLocaleLowerCase() === tag),
      ) &&
      (!filters.variant.trim() ||
        metadata.variant.toLocaleLowerCase() === filters.variant.trim().toLocaleLowerCase()) &&
      revision.width >= filters.minWidth &&
      revision.height >= filters.minHeight
    );
  });
}

export function canSelectArt(revision: ArtRevision, kind?: ArtKind, camera?: ArtCamera): boolean {
  return (
    revision.canReuse &&
    (!kind || revision.metadata.kind === kind) &&
    artCameraMatches(camera, revision.metadata.camera)
  );
}
