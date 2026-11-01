/** Synthetic numbers/models only: not a claim about current provider pricing or availability. */
export function ownerProfile(now = Date.now()) {
  const pricing = {
    source: 'https://developers.openai.com/api/docs/pricing',
    reviewedAt: new Date(now - 60000).toISOString(),
    validUntil: new Date(now + 30 * 86400000).toISOString(),
  };
  return {
    totalCapMicros: 1000000,
    textCapMicros: 300000,
    imageCapMicros: 700000,
    text: {
      model: 'synthetic-owner-text',
      contextTokens: 131072,
      maxOutputTokens: 512,
      maxInputBytes: 64000,
      inputMicrosPerMillion: 1000000,
      outputMicrosPerMillion: 2000000,
      pricing: { ...pricing },
    },
    image: {
      model: 'synthetic-owner-image',
      size: '1536x1024',
      quality: 'medium',
      outputs: 1,
      format: 'png',
      maxPromptUtf8Bytes: 8000,
      maxReferenceImages: 0,
      inputTextMicrosPerMillion: 1000000,
      inputImageMicrosPerMillion: 2000000,
      outputImageMicrosPerMillion: 3000000,
      estimatedTotalMicros: 50000,
      reserveMicros: 100000,
      estimateRiskAccepted: true,
      pricing: { ...pricing },
    },
  };
}
export function ownerEnvironment(profile = ownerProfile(), handle = 'synthetic_owner') {
  return {
    GENERATION_MODE: 'owner',
    GENERATION_OWNER_HANDLE: handle,
    GENERATION_OWNER_CONFIG_JSON: JSON.stringify(profile),
  };
}
/** Preferred synthetic fixture: per-request planning, not a current tariff/model recommendation. */
export function requestEstimateOwnerProfile(now = Date.now()) {
  const profile = ownerProfile(now);
  profile.text.estimation = {
    kind: 'operator_heuristic',
    textTokensPerKiBUtf8: 1024,
    textProtocolTokens: 4096,
    marginBps: 2500,
    fixedMarginMicros: 100,
  };
  profile.image.estimation = {
    kind: 'operator_heuristic',
    textTokensPerKiBUtf8: 1024,
    textProtocolTokens: 32,
    outputImageTokens: 1000,
    referenceImageTokensPerImage: 1200,
    referenceAllowanceMicros: 10000,
    marginBps: 2500,
    fixedMarginMicros: 1000,
  };
  profile.image.maxReferenceImages = 2;
  delete profile.image.estimatedTotalMicros;
  delete profile.image.reserveMicros;
  return profile;
}
/** Explicit compatibility alias; this profile preserves the historical fixed reserve. */
export const legacyOwnerProfile = ownerProfile;
