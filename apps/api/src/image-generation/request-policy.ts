import { defaultImageStylePrompt } from '@dreamwalk/contracts';
import type { GenerationRequest } from './contracts';

/** Only new quotes opt in. Existing immutable requests keep their original bytes. */
export function imageProviderRequest(input: GenerationRequest): GenerationRequest {
  if (input.requestPolicyVersion !== 2) return input;
  // Grounded location/media builders already include this same default instruction.
  if (input.prompt.includes('Default art: detailed drawn 2D anime,')) return input;
  const subject = input.storyCoverContext
    ? 'cover'
    : input.kind === 'portrait' || input.kind === 'sprite'
      ? 'character'
      : input.kind === 'background'
        ? input.camera === 'top-down'
          ? 'battlemap'
          : 'location'
        : 'asset';
  return { ...input, prompt: `${defaultImageStylePrompt(subject)}\n${input.prompt}` };
}
