export type ArtKind = 'background' | 'portrait' | 'sprite' | 'object' | 'effect' | 'ui';
export type ArtCamera = 'top-down' | 'side' | 'isometric' | 'portrait' | 'unrestricted';
export type ArtMetadata = {
  title: string;
  kind: ArtKind;
  style: 'drawn2D';
  camera: ArtCamera;
  tags: string[];
  variant: string;
  provenance: {
    source: 'upload' | 'licensed-import' | 'generated';
    provider?: string;
  };
  rights: {
    basis: 'owned' | 'licensed' | 'generated';
    licenseLabel: string;
    attribution: string;
    allowAuthorReuse: boolean;
    attested: true;
  };
};
export type ArtRevision = {
  id: string;
  familyId: string;
  revision: number;
  sha256: string;
  mime: string;
  width: number;
  height: number;
  metadata: ArtMetadata;
  url: string;
  owned: boolean;
  canReuse: boolean;
};
export type ArtSpec = {
  kind: ArtKind;
  style: 'drawn2D';
  camera: ArtCamera;
  tags: string[];
  minWidth: number;
  minHeight: number;
  variant?: string;
};
export type ArtResolution = {
  decision: 'reuse' | 'propose_generation';
  revision: ArtRevision | null;
  alternatives: ArtRevision[];
  generation: {
    id: string;
    requiresExplicitApproval: true;
    estimatedCost: null;
  } | null;
  providerCalls: 0;
  charge: 0;
};
export type ArtGrant = {
  id: string;
  revisionId?: string;
  granteeUserId: string;
  granteeHandle?: string;
  retainExistingPins: true;
  revoked: boolean;
};
export type ArtBinding = { slot: string; revisionId: string };
export function artPreviewUrl(url: string): string | undefined {
  return /^\/api\/v1\/asset-library\/revisions\/[0-9a-f-]{36}\/file(?:\?(?:campaignId|playableVersionId)=[0-9a-f-]{36})?$/.test(
    url,
  )
    ? url
    : undefined;
}

/** A generic-camera asset fits specific slots; an unrestricted query accepts any camera. */
export function artCameraMatches(required: ArtCamera | undefined, actual: ArtCamera): boolean {
  return (
    required === undefined ||
    required === 'unrestricted' ||
    actual === required ||
    actual === 'unrestricted'
  );
}
