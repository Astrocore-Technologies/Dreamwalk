import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TextTokenCounter } from './text-context';
export const storyMapImageSchema = z
  .object({
    locationId: z.string().min(1).max(80),
    revisionId: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.literal(768),
    height: z.literal(768),
    framing: z.literal('contain-24x24'),
    dataUrl: z
      .string()
      .max(800000)
      .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/),
  })
  .strict();
export type StoryMapImage = z.infer<typeof storyMapImageSchema>;

export interface ReviewedStoryVisionPolicy {
  model: string;
  inputTokensPerImage: number;
  maxImages: number;
  detail: 'high';
  billing: 'text_input_rate';
  maxPricedInputTokens: number;
  pricing: { source: string; reviewedAt: string; validUntil: string };
}
export type StoryVisionPolicy =
  | ReviewedStoryVisionPolicy
  | (Omit<ReviewedStoryVisionPolicy, 'inputTokensPerImage'> & {
      counting: 'operational_exact';
      inputTokensPerImage?: never;
    });
export const usesStoryExactCount = (policy?: StoryVisionPolicy | false) =>
  !!policy && 'counting' in policy && policy.counting === 'operational_exact';
export function readStoryImages(context: unknown): StoryMapImage[] {
  const value = (context as { mapImages?: unknown } | null)?.mapImages;
  if (value === undefined) return [];
  const images = z.array(storyMapImageSchema).max(4).parse(value);
  if (new Set(images.map((i) => i.locationId)).size !== images.length)
    throw new Error('MAP_IMAGE_DUPLICATE');
  for (const image of images) {
    const bytes = Buffer.from(image.dataUrl.split(',')[1], 'base64');
    if (createHash('sha256').update(bytes).digest('hex') !== image.inputSha256)
      throw new Error('MAP_IMAGE_INTEGRITY_FAILED');
  }
  return images;
}
export function storyVisionInput(context: unknown, policy?: StoryVisionPolicy | false) {
  const images = readStoryImages(context);
  if (!images.length) return JSON.stringify(context);
  if (
    !policy ||
    images.length > policy.maxImages ||
    policy.detail !== 'high' ||
    policy.billing !== 'text_input_rate' ||
    (!usesStoryExactCount(policy) &&
      (!Number.isSafeInteger(policy.inputTokensPerImage) || policy.inputTokensPerImage! < 1)) ||
    !(
      Date.parse(policy.pricing.reviewedAt) <= Date.now() &&
      Date.parse(policy.pricing.validUntil) > Date.now()
    )
  )
    throw new Error('MAP_VISION_POLICY_REQUIRED');
  const source = {
    ...(context as Record<string, unknown>),
    mapImages: images.map(({ dataUrl: _dataUrl, ...image }) => image),
  };
  return [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: JSON.stringify(source) },
        ...images.flatMap((image) => [
          {
            type: 'input_text',
            text: JSON.stringify({
              locationId: image.locationId,
              revisionId: image.revisionId,
              framing: image.framing,
            }),
          },
          { type: 'input_image', image_url: image.dataUrl, detail: policy.detail },
        ]),
      ],
    },
  ];
}
/** Reviewed model-specific image allowance plus conservative text-envelope accounting.
 * Image bytes are transport bytes, never text tokens. The original body hash pins both.
 */
export function storyVisionCounter(
  body: string,
  model: string,
  policy?: StoryVisionPolicy | false,
  exact?: TextTokenCounter,
): TextTokenCounter | undefined {
  const envelope = JSON.parse(body);
  if (!Array.isArray(envelope.input)) return undefined;
  let images = 0;
  for (const message of envelope.input)
    for (const part of message.content ?? [])
      if (part.type === 'input_image') {
        images++;
        part.image_url = '[pinned raster]';
      }
  if (!images) return undefined;
  if (!policy || policy.model !== model || images > policy.maxImages)
    throw new Error('MAP_VISION_POLICY_REQUIRED');
  if (usesStoryExactCount(policy)) {
    if (!exact || exact.precision !== 'exact' || !exact.supports(model))
      throw new Error('STORY_MAP_EXACT_COUNT_REQUIRED');
    if (
      !Number.isSafeInteger(policy.maxPricedInputTokens) ||
      exact.countInput(body, model) > policy.maxPricedInputTokens
    )
      throw new Error('MAP_VISION_POLICY_REQUIRED');
    return exact;
  }
  const tokens =
    Buffer.byteLength(JSON.stringify(envelope)) + 4096 + images * policy.inputTokensPerImage!;
  if (!Number.isSafeInteger(policy.maxPricedInputTokens) || tokens > policy.maxPricedInputTokens)
    throw new Error('MAP_VISION_POLICY_REQUIRED');
  const hash = createHash('sha256').update(body).digest('hex');
  return {
    id: 'reviewed-image-allowance-v1',
    precision: 'conservative_estimate',
    supports: (m) => m === model,
    countInput: (candidate) => {
      if (createHash('sha256').update(candidate).digest('hex') !== hash)
        throw new Error('MAP_IMAGE_CONTEXT_CHANGED');
      return tokens;
    },
  };
}
