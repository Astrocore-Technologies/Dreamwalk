import sharp from 'sharp';
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
  verifiedUpperMicros: number | null;
  networkApproved: boolean;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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
          timeout: options.timeoutMs ?? 60000,
          size: '1024x1024',
          quality: 'low',
          n: 1,
          format: 'png',
          moderation: 'auto',
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
      refs.length !== request.referenceRevisionIds.length ||
      refs.some(
        (r) =>
          !request.referenceRevisionIds.includes(r.revisionId) ||
          r.bytes.length > 5 * 1024 * 1024 ||
          !['image/png', 'image/webp'].includes(r.mime),
      )
    )
      throw new Error('INVALID_IMAGE_REQUEST');
    const o = this.options;
    if (
      !o.enabled ||
      !o.networkApproved ||
      !o.apiKey ||
      o.verifiedUpperMicros === null ||
      !Number.isSafeInteger(o.verifiedUpperMicros) ||
      o.verifiedUpperMicros <= 0 ||
      o.verifiedUpperMicros > 1000000
    )
      throw new Error('LIVE_COST_BOUND_REQUIRED');
    const common = {
      model: o.model,
      prompt: request.prompt,
      n: 1,
      size: '1024x1024',
      quality: 'low',
      background: request.background,
      output_format: 'png',
      moderation: 'auto',
    };
    let body: BodyInit,
      headers: Record<string, string> = {
        Authorization: `Bearer ${o.apiKey}`,
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
    const actualMicros = counts.every((v) => Number.isSafeInteger(v) && v! >= 0)
      ? Math.ceil(
          (counts[0]! * o.inputTextMicrosPerMillion +
            counts[1]! * o.inputImageMicrosPerMillion +
            counts[2]! * o.outputImageMicrosPerMillion) /
            1000000,
        )
      : undefined;
    return {
      bytes,
      mime: 'image/png',
      actualMicros,
      requestId: (response.headers.get('x-request-id') ?? dispatchId).slice(0, 200),
    };
  }
}
