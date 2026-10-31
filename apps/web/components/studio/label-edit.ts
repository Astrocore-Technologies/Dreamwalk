/** Renaming source copy invalidates curated variants; geometry-only edits preserve them. */
export function labelEditPatch<T extends object>(currentLabel: string | undefined, patch: T): T {
  return 'label' in patch && typeof patch.label === 'string' && patch.label !== currentLabel
    ? { ...patch, labelTranslations: undefined }
    : patch;
}
