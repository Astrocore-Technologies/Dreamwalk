import { estimateImageRequest } from '../generation/estimates';
import sharp from 'sharp';
import { ownerPricingIsCurrent, type OwnerGenerationConfig } from '../generation/config';
import { ImageProviderFailure, safeImageErrorDiagnostic } from './error-diagnostics';
import { createHash } from 'node:crypto';
import { generationRequestSchema, type GenerationRequest } from './contracts';
export interface ImageReference {
  revisionId: string;
  sha256: string;
  bytes: Buffer;
  mime: string;
}
export interface ImageResult {
  bytes: Buffer;
  mime: 'image/png' | 'image/webp';
  actualMicros?: number;
  requestId: string;
}
export interface ImageProvider {
  readonly id: string;
  generate(
    request: GenerationRequest,
    dispatchId: string,
    refs: ImageReference[],
  ): Promise<ImageResult>;
}
/** A fixed synthetic raster fixture, never advertised as AI-generated artwork. */
export class FixtureImageProvider implements ImageProvider {
  readonly id = 'mock-raster-fixture-v1';
  async generate(request: GenerationRequest, dispatchId: string): Promise<ImageResult> {
    const raw = Buffer.alloc(64 * 64 * 4);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4;
        raw[i] = 112;
        raw[i + 1] = 76;
        raw[i + 2] = 135;
        raw[i + 3] =
          request.background === 'opaque' || (x >= 12 && x < 52 && y >= 12 && y < 52) ? 255 : 0;
      }
    return {
      bytes: await sharp(raw, { raw: { width: 64, height: 64, channels: 4 } })
        .png()
        .toBuffer(),
      mime: 'image/png',
      actualMicros: 0,
      requestId: `fixture:${dispatchId}`,
    };
  }
}
export interface OpenAiImageOptions {
  enabled: boolean;
  apiKey?: string;
  resolveApiKey?: () => string | undefined;
  verifiedUpperMicros: number | null;
  costBasis?: 'verified_bound' | 'approved_estimate';
  estimateRiskApproved?: boolean;
  operationalReserveMicros?: number;
  networkApproved: boolean;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  approvedUntilMs?: number;
  now?: () => number;
  inputTextMicrosPerMillion: number;
  inputImageMicrosPerMillion: number;
  outputImageMicrosPerMillion: number;
}
/** Fixed origin, one response, no redirects/retries. Dispatch caller must reserve its verified bound. */
export class OpenAiImageProvider implements ImageProvider {
  readonly id: string;
  constructor(private options: OpenAiImageOptions) {
    if (
      options.model !== 'gpt-image-2.5-sunburst-2026-09-08' ||
      ![
        options.inputTextMicrosPerMillion,
        options.inputImageMicrosPerMillion,
        options.outputImageMicrosPerMillion,
      ].every((v) => Number.isSafeInteger(v) && v > 0) ||
      !Number.isSafeInteger(options.timeoutMs ?? 60000) ||
      (options.timeoutMs ?? 60000) < 1 ||
      (options.timeoutMs ?? 60000) > 90000
    )
      throw new Error('INVALID_IMAGE_PROVIDER_POLICY');
    this.options = Object.freeze({ ...options });
    this.id = `openai-images-v1:${createHash('sha256')
      .update(
        JSON.stringify({
          model: options.model,
          inputText: options.inputTextMicrosPerMillion,
          inputImage: options.inputImageMicrosPerMillion,
          outputImage: options.outputImageMicrosPerMillion,
          upper: options.verifiedUpperMicros,
          costBasis: options.costBasis,
          reserve: options.operationalReserveMicros,
          timeout: options.timeoutMs ?? 60000,
          size: '1024x1024',
          quality: 'low',
          n: 1,
          format: 'png',
          moderation: 'auto',
          stream: false,
          partial_images: 0,
        }),
      )
      .digest('hex')}`;
  }
  async generate(
    request: GenerationRequest,
    dispatchId: string,
    refs: ImageReference[],
  ): Promise<ImageResult> {
    request = generationRequestSchema.parse(request);
    if (
      Buffer.byteLength(request.prompt, 'utf8') > 8000 ||
      refs.length > 2 ||
      refs.length !==
        request.referenceRevisionIds.length + request.privateReferenceAssetIds.length ||
      refs.some(
        (r) =>
          ![...request.referenceRevisionIds, ...request.privateReferenceAssetIds].includes(
            r.revisionId,
          ) ||
          r.bytes.length > 5 * 1024 * 1024 ||
          !['image/png', 'image/webp'].includes(r.mime),
      )
    )
      throw new Error('INVALID_IMAGE_REQUEST');
    const o = this.options;
    const estimated = o.costBasis === 'approved_estimate';
    if (estimated && refs.length) throw new Error('IMAGE_REFERENCE_ESTIMATE_UNAVAILABLE');
    if (estimated) throw new Error('ESTIMATE_DISPATCH_APPROVAL_PENDING');
    const reserve = estimated ? o.operationalReserveMicros : o.verifiedUpperMicros;
    if (
      !o.enabled ||
      !o.networkApproved ||
      (o.approvedUntilMs !== undefined && o.approvedUntilMs <= (o.now?.() ?? Date.now())) ||
      (estimated && (!o.estimateRiskApproved || o.verifiedUpperMicros !== null)) ||
      reserve === null ||
      reserve === undefined ||
      !Number.isSafeInteger(reserve) ||
      reserve <= 0 ||
      reserve > 1000000
    )
      throw new Error('LIVE_COST_BOUND_REQUIRED');
    const apiKey = o.apiKey ?? o.resolveApiKey?.();
    if (typeof apiKey !== 'string' || !/^[^\s]{1,1024}$/.test(apiKey))
      throw new Error('IMAGE_CREDENTIAL_REQUIRED');
    const common = {
      model: o.model,
      prompt: request.prompt,
      n: 1,
      size: '1024x1024',
      quality: 'low',
      background: request.background,
      output_format: 'png',
      moderation: 'auto',
      stream: false,
      partial_images: 0,
    };
    let body: BodyInit,
      headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'X-Client-Request-Id': dispatchId,
      };
    if (refs.length) {
      const form = new FormData();
      for (const [k, v] of Object.entries(common)) form.append(k, String(v));
      for (const [r, i] of refs.map((r, i) => [r, i] as const))
        form.append(
          'image[]',
          new Blob([new Uint8Array(r.bytes)], { type: r.mime }),
          `owned-reference-${i}.webp`,
        );
      body = form;
    } else {
      body = JSON.stringify(common);
      headers = { ...headers, 'Content-Type': 'application/json' };
    }
    const response = await (o.fetchImpl ?? fetch)(
      `https://api.openai.com/v1/images/${refs.length ? 'edits' : 'generations'}`,
      {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(o.timeoutMs ?? 60000),
      },
    );
    return readImageResult(response, dispatchId, o);
  }
}

/** Owner configuration is not authorization: the durable engine rechecks DB consent before dispatch. */
export class OwnerOpenAiImageProvider implements ImageProvider {
  readonly id: string;
  constructor(
    private config: OwnerGenerationConfig,
    private dependencies: {
      resolveApiKey: () => string | undefined;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {
    this.config = structuredClone(config);
    this.id = `openai-owner-images-v1:${config.configFingerprint}`;
  }
  async generate(
    request: GenerationRequest,
    dispatchId: string,
    refs: ImageReference[],
  ): Promise<ImageResult> {
    request = generationRequestSchema.parse(request);
    const p = this.config.image;
    if (
      request.mode !== 'external' ||
      Buffer.byteLength(request.prompt, 'utf8') > p.maxPromptUtf8Bytes
    )
      throw new Error('INVALID_IMAGE_REQUEST');
    const referenceIds = [...request.referenceRevisionIds, ...request.privateReferenceAssetIds];
    if (referenceIds.length > p.maxReferenceImages || refs.length > p.maxReferenceImages)
      throw new Error('IMAGE_REFERENCE_ESTIMATE_UNAVAILABLE');
    if (
      refs.length !== referenceIds.length ||
      new Set(refs.map((ref) => ref.revisionId)).size !== refs.length ||
      refs.some(
        (ref) =>
          !referenceIds.includes(ref.revisionId) ||
          !Buffer.isBuffer(ref.bytes) ||
          !ref.bytes.length ||
          ref.bytes.length > p.maxReferenceBytes ||
          !['image/png', 'image/webp'].includes(ref.mime) ||
          createHash('sha256').update(ref.bytes).digest('hex') !== ref.sha256,
      )
    )
      throw new Error('INVALID_IMAGE_REFERENCE');
    for (const ref of refs) {
      try {
        const metadata = await sharp(ref.bytes, {
          limitInputPixels: p.maxReferencePixels,
        }).metadata();
        if (
          !metadata.width ||
          !metadata.height ||
          metadata.width > 4096 ||
          metadata.height > 4096 ||
          metadata.width * metadata.height > p.maxReferencePixels ||
          (metadata.pages ?? 1) !== 1 ||
          !['png', 'webp'].includes(metadata.format ?? '') ||
          `image/${metadata.format}` !== ref.mime
        )
          throw new Error('INVALID_IMAGE_REFERENCE');
      } catch {
        throw new Error('INVALID_IMAGE_REFERENCE');
      }
    }
    // Freshness is independent of owner authorization; recheck just before key resolution/network.
    if (!ownerPricingIsCurrent(p.pricing, this.dependencies.now?.() ?? Date.now()))
      throw new Error('OWNER_GENERATION_CURRENT_PRICING_REQUIRED');
    const requestEstimate = estimateImageRequest(request.prompt, referenceIds.length, p, this.id);
    if (
      !p.estimateRiskAccepted ||
      p.costBasis !== 'approved_estimate' ||
      p.providerEnforcesQuotedCap !== false ||
      p.outputs !== 1 ||
      !Number.isInteger(p.maxReferenceImages) ||
      p.maxReferenceImages < 0 ||
      p.maxReferenceImages > 2 ||
      !Number.isSafeInteger(requestEstimate.reserveMicros) ||
      requestEstimate.reserveMicros < requestEstimate.estimatedTotalMicros ||
      requestEstimate.estimatedTotalMicros <= 0 ||
      requestEstimate.reserveMicros > this.config.imageCapMicros ||
      requestEstimate.reserveMicros > this.config.totalCapMicros
    )
      throw new Error('INVALID_IMAGE_PROVIDER_POLICY');
    const apiKey = this.dependencies.resolveApiKey();
    if (typeof apiKey !== 'string' || !/^[^\s]{1,1024}$/.test(apiKey))
      throw new Error('IMAGE_CREDENTIAL_REQUIRED');
    const common = {
      model: p.model,
      prompt: request.prompt,
      n: p.outputs,
      size: p.size,
      quality: p.quality,
      background: request.background,
      output_format: p.format,
      moderation: 'auto',
      stream: false,
      partial_images: 0,
    };
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'X-Client-Request-Id': dispatchId,
    };
    let body: BodyInit;
    if (refs.length) {
      const form = new FormData();
      for (const [key, value] of Object.entries(common)) form.append(key, String(value));
      for (const [index, ref] of [...refs]
        .sort((a, b) => referenceIds.indexOf(a.revisionId) - referenceIds.indexOf(b.revisionId))
        .entries())
        form.append(
          'image[]',
          new Blob([new Uint8Array(ref.bytes)], { type: ref.mime }),
          `owned-reference-${index}.${ref.mime === 'image/png' ? 'png' : 'webp'}`,
        );
      body = form;
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(common);
    }
    const response = await (this.dependencies.fetchImpl ?? fetch)(
      `https://api.openai.com/v1/images/${refs.length ? 'edits' : 'generations'}`,
      {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
      },
    );
    return readImageResult(response, dispatchId, p);
  }
}
async function readImageResult(
  response: Response,
  dispatchId: string,
  rates: {
    inputTextMicrosPerMillion: number;
    inputImageMicrosPerMillion: number;
    outputImageMicrosPerMillion: number;
  },
): Promise<ImageResult> {
  if (!response.ok) throw new ImageProviderFailure(await safeImageErrorDiagnostic(response));
  if (!response.body) throw new Error('PROVIDER_RESULT_UNKNOWN');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > 8 * 1024 * 1024) {
      await reader.cancel();
      throw new Error('PROVIDER_RESULT_TOO_LARGE');
    }
    chunks.push(part.value);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    data?: { b64_json?: string }[];
    usage?: {
      input_tokens_details?: { text_tokens?: number; image_tokens?: number };
      output_tokens?: number;
      input_tokens?: number;
      total_tokens?: number;
      output_tokens_details?: { image_tokens?: number; text_tokens?: number };
    };
  };
  if (
    value.data?.length !== 1 ||
    typeof value.data[0].b64_json !== 'string' ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data[0].b64_json)
  )
    throw new Error('PROVIDER_RESULT_INVALID');
  const bytes = Buffer.from(value.data[0].b64_json, 'base64');
  if (bytes.length > 5 * 1024 * 1024) throw new Error('PROVIDER_RESULT_TOO_LARGE');
  const u = value.usage,
    counts = [
      u?.input_tokens_details?.text_tokens,
      u?.input_tokens_details?.image_tokens,
      u?.output_tokens,
    ];
  let actualMicros: number | undefined;
  if (counts.every((v) => Number.isSafeInteger(v) && v! >= 0)) {
    const sameCount = (value: unknown, expected: bigint) =>
      Number.isSafeInteger(value) && Number(value) >= 0 && BigInt(value as number) === expected;
    // Direct Images pricing here covers text/image INPUT and image OUTPUT only. Never
    // mislabel a future mixed text-output bill or contradictory counters as known image cost.
    const consistent =
      (u?.input_tokens === undefined ||
        sameCount(u.input_tokens, BigInt(counts[0]!) + BigInt(counts[1]!))) &&
      (u?.total_tokens === undefined ||
        sameCount(u.total_tokens, BigInt(counts[0]!) + BigInt(counts[1]!) + BigInt(counts[2]!))) &&
      (u?.output_tokens_details === undefined ||
        (u.output_tokens_details?.text_tokens === 0 &&
          sameCount(u.output_tokens_details?.image_tokens, BigInt(counts[2]!))));
    const micros =
      (BigInt(counts[0]!) * BigInt(rates.inputTextMicrosPerMillion) +
        BigInt(counts[1]!) * BigInt(rates.inputImageMicrosPerMillion) +
        BigInt(counts[2]!) * BigInt(rates.outputImageMicrosPerMillion) +
        999999n) /
      1000000n;
    // Unrepresentable usage is unknown liability, never a rounded or zero bill.
    if (consistent && micros <= BigInt(Number.MAX_SAFE_INTEGER)) actualMicros = Number(micros);
  }
  return {
    bytes,
    mime: 'image/png',
    actualMicros,
    requestId: (response.headers.get('x-request-id') ?? dispatchId).slice(0, 200),
  };
}
