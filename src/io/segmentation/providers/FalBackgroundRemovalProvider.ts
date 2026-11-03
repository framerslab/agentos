/**
 * @module io/segmentation/providers/FalBackgroundRemovalProvider
 *
 * Background removal (matting) on fal's BiRefNet v2 endpoint,
 * `fal-ai/birefnet/v2`, through fal's synchronous API: one
 * `POST https://fal.run/fal-ai/birefnet/v2` with the image's URL or data URI,
 * answered with the cut-out in the same connection
 * (https://fal.ai/docs/api-reference/inference-api/sync/run.md). The key goes
 * as `Authorization: Key <key>`.
 *
 * The request and answer shapes follow the endpoint's schema
 * (https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/birefnet/v2):
 * `image_url` (a URL, or a base64 data URI, which fal takes as a file input),
 * `model` (the BiRefNet weights), `operating_resolution`, `output_format`,
 * `refine_foreground`, `output_mask` and `sync_mode` in; `image` and
 * `mask_image`, each `{ url, content_type, file_name, file_size, width,
 * height }`, out. With `sync_mode` the media comes back as a data URI and is
 * left out of fal's request history.
 *
 * fal does not retry a synchronous request; a caller that wants a retry on a
 * 503 makes it.
 */
import { ApiKeyPool } from '../../../core/providers/ApiKeyPool.js';
import { getImageProviderOptions, parseDataUrl } from '../../media/images/IImageProvider.js';
import { SegmentationProviderError } from '../errors.js';
import type {
  BackgroundRemovalImage,
  BackgroundRemovalOutput,
  BackgroundRemovalRequest,
  BackgroundRemovalResult,
  FalBackgroundRemovalOptions,
  IBackgroundRemovalProvider,
} from '../types.js';

/** fal's synchronous API, the provider's base URL unless one is configured. */
export const FAL_RUN_URL = 'https://fal.run';

/** The endpoint a background removal runs on when the call names none. */
export const FAL_BIREFNET_MODEL = 'fal-ai/birefnet/v2';

/** The endpoint's own defaults, sent explicitly so a call states what it ran. */
const DEFAULT_VARIANT = 'General Use (Light)';
const DEFAULT_RESOLUTION = '1024x1024';

/** The answers fal gives a request it refuses: a bad header, a body over 64 MiB, input the model rejected. */
const REFUSED_STATUSES = new Set([400, 413, 422]);

/** One file in fal's answer. @internal */
interface FalImageFile {
  url?: unknown;
  content_type?: unknown;
  file_size?: unknown;
  width?: unknown;
  height?: unknown;
}

/** fal's answer for `fal-ai/birefnet/v2`. @internal */
interface FalBiRefNetAnswer {
  image?: FalImageFile | null;
  mask_image?: FalImageFile | null;
}

/**
 * Whether `id` is a fal endpoint id: an owner and an app, then any path
 * segments, each of letters, digits, `.`, `_` or `-`, and none `.` or `..`.
 */
function isEndpointId(id: string): boolean {
  const segments = id.split('/');
  return segments.length >= 2 && segments.every((segment) => /^[\w.-]+$/.test(segment) && segment !== '.' && segment !== '..');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Background removal on fal BiRefNet.
 *
 * @example
 * ```ts
 * const provider = new FalBackgroundRemovalProvider();
 * await provider.initialize({ apiKey: process.env.FAL_API_KEY! });
 * const { image } = await provider.removeBackground({
 *   modelId: '',
 *   imageUrl: 'https://example.com/hero.png',
 *   output: 'url',
 *   format: 'png',
 *   returnMask: false,
 *   timeoutMs: 60_000,
 * });
 * ```
 */
export class FalBackgroundRemovalProvider implements IBackgroundRemovalProvider {
  public readonly providerId = 'fal';
  public isInitialized = false;
  public defaultModelId?: string;
  private keyPool!: ApiKeyPool;
  private baseURL = FAL_RUN_URL;

  /**
   * @param config - `apiKey` (required; a comma-separated list rotates),
   *   `baseURL` (default `https://fal.run`), `defaultModelId` (default
   *   `fal-ai/birefnet/v2`).
   * @throws {SegmentationProviderError} When `apiKey` is missing.
   */
  async initialize(config: Record<string, unknown>): Promise<void> {
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
    if (!apiKey) {
      throw new SegmentationProviderError('fal background removal provider requires apiKey (FAL_API_KEY).', 'invalid_request');
    }
    this.keyPool = new ApiKeyPool(apiKey);
    this.baseURL =
      typeof config.baseURL === 'string' && config.baseURL.trim() ? config.baseURL.trim().replace(/\/+$/, '') : FAL_RUN_URL;
    this.defaultModelId =
      typeof config.defaultModelId === 'string' && config.defaultModelId.trim()
        ? config.defaultModelId.trim()
        : FAL_BIREFNET_MODEL;
    this.isInitialized = true;
  }

  /**
   * Cuts the subject of `request.imageUrl` out of its background.
   *
   * @throws {SegmentationProviderError} `invalid_request` for a malformed
   *   endpoint id or an answer of 400, 413 or 422; `provider_failed` for any
   *   other failed answer, a network failure or an answer without an image;
   *   `timeout` when `request.timeoutMs` passes first. A failed answer carries
   *   its HTTP `status`.
   * @throws The reason of `request.signal` when the caller aborts.
   */
  async removeBackground(request: BackgroundRemovalRequest): Promise<BackgroundRemovalResult> {
    if (!this.isInitialized) {
      throw new SegmentationProviderError('fal background removal provider is not initialized.', 'provider_failed');
    }
    const startedAt = Date.now();
    const modelId = request.modelId || this.defaultModelId || FAL_BIREFNET_MODEL;
    if (!isEndpointId(modelId)) {
      throw new SegmentationProviderError(
        `Invalid fal endpoint "${modelId}": expected "owner/app" or "owner/app/path".`,
        'invalid_request',
      );
    }
    request.signal?.throwIfAborted();

    const options = getImageProviderOptions<FalBackgroundRemovalOptions>(this.providerId, request.providerOptions) ?? {};
    const body: Record<string, unknown> = {
      model: options.variant ?? DEFAULT_VARIANT,
      operating_resolution: options.operatingResolution ?? DEFAULT_RESOLUTION,
      output_format: request.format,
      refine_foreground: options.refineForeground ?? true,
    };
    if (request.returnMask) body.output_mask = true;
    if (request.output === 'buffer') body.sync_mode = true;
    if (options.input && typeof options.input === 'object') Object.assign(body, options.input);
    body.image_url = request.imageUrl;

    const deadline = AbortSignal.timeout(request.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
    /** The error a failure ends the call with: the caller's abort, the deadline, or the failure itself. */
    const failure = (error: unknown, step: string): unknown => {
      if (request.signal?.aborted) return request.signal.reason;
      if (deadline.aborted) {
        return new SegmentationProviderError(`fal background removal timed out after ${request.timeoutMs} ms.`, 'timeout', error);
      }
      if (error instanceof SegmentationProviderError) return error;
      return new SegmentationProviderError(`fal background removal ${step} failed: ${messageOf(error)}`, 'provider_failed', error);
    };

    let answer: FalBiRefNetAnswer | null;
    try {
      const response = await fetch(`${this.baseURL}/${modelId}`, {
        method: 'POST',
        headers: { Authorization: `Key ${this.keyPool.next()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new SegmentationProviderError(
          `fal background removal returned ${response.status}: ${text.slice(0, 500)}`,
          REFUSED_STATUSES.has(response.status) ? 'invalid_request' : 'provider_failed',
          undefined,
          response.status,
        );
      }
      try {
        answer = JSON.parse(text) as FalBiRefNetAnswer | null;
      } catch {
        answer = null;
      }
    } catch (error) {
      throw failure(error, 'request');
    }

    if (!answer?.image || typeof answer.image.url !== 'string' || !answer.image.url) {
      throw new SegmentationProviderError('fal background removal returned no image.', 'provider_failed');
    }
    const fallbackType = request.format === 'webp' ? 'image/webp' : 'image/png';
    try {
      const image = await this.readImage(answer.image, fallbackType, request.output, signal);
      const mask =
        request.returnMask && answer.mask_image && typeof answer.mask_image.url === 'string' && answer.mask_image.url
          ? await this.readImage(answer.mask_image, fallbackType, request.output, signal)
          : undefined;
      return {
        image,
        ...(mask ? { mask } : {}),
        providerId: this.providerId,
        modelId,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      throw failure(error, 'download');
    }
  }

  /**
   * One file of fal's answer as a {@link BackgroundRemovalImage}: an inline
   * data URI decoded, a URL kept, and with `output: 'buffer'` downloaded. The
   * download carries no key: the file is on fal's storage, and the key goes
   * to the API alone.
   */
  private async readImage(
    file: FalImageFile,
    fallbackType: string,
    output: BackgroundRemovalOutput,
    signal: AbortSignal,
  ): Promise<BackgroundRemovalImage> {
    const url = file.url as string;
    const image: BackgroundRemovalImage = {
      mimeType: typeof file.content_type === 'string' && file.content_type ? file.content_type : fallbackType,
    };
    if (typeof file.width === 'number') image.width = file.width;
    if (typeof file.height === 'number') image.height = file.height;
    if (typeof file.file_size === 'number') image.fileSize = file.file_size;

    if (url.startsWith('data:')) {
      const parsed = parseDataUrl(url);
      if (!parsed.base64) {
        throw new SegmentationProviderError('fal background removal returned an inline image that is not base64.', 'provider_failed');
      }
      if (typeof file.content_type !== 'string' && parsed.mimeType) image.mimeType = parsed.mimeType;
      image.dataUrl = url;
      image.buffer = Buffer.from(parsed.base64, 'base64');
      return image;
    }

    image.url = url;
    if (output === 'buffer') {
      if (!/^https?:\/\//i.test(url)) {
        throw new SegmentationProviderError(`fal background removal returned a file it cannot download: ${url.slice(0, 200)}`, 'provider_failed');
      }
      const response = await fetch(url, { signal });
      if (!response.ok) {
        throw new SegmentationProviderError(
          `fal background removal download returned ${response.status}.`,
          'provider_failed',
          undefined,
          response.status,
        );
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const servedType = response.headers.get('content-type')?.split(';')[0].trim();
      if (typeof file.content_type !== 'string' && servedType?.startsWith('image/')) image.mimeType = servedType;
      image.buffer = bytes;
      image.dataUrl = `data:${image.mimeType};base64,${bytes.toString('base64')}`;
    }
    return image;
  }
}
