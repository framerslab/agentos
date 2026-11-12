/**
 * @module guardrails/builtin/ImageGuardrail
 *
 * A guard over the images of an input. It holds the order of checks and no vendor code: every `match` check (a hash
 * service that knows material) runs on every image before any `classify` check (a model) runs on any image, a
 * quarantine ends the whole evaluation, and every check receives its own copy of bytes the guard captured once,
 * never a URL. An image no `classify` check answered for was judged by nobody and is refused as unavailable.
 */
import { listedErrorFields, safeWord } from '../../../core/logging/events.js';
import type { VisionInputData } from '../../../cognition/substrate/IGMI';
import { holdResult } from '../guardrailDispatcher';
import { markGuardFailure } from '../guardFailure';
import {
  GuardrailAction,
  type GuardrailConfig,
  type GuardrailContext,
  type GuardrailEvaluationResult,
  type GuardrailInputPayload,
  type IGuardrailService,
} from '../IGuardrailService';
import { guardrailLog } from '../log';

/** One image as every check sees it: the bytes the guard captured once, never a URL. Each check gets its own copy. */
export interface ImageUnderReview {
  /** The image's place in the input's `visionInputs`, from 0. */
  index: number;
  bytes: Uint8Array;
  mimeType: string;
}

/** What a check answers for one image. */
export type ImageCheckResult =
  | { verdict: 'pass' }
  | { verdict: 'flag'; reasonCode: string; scores?: Record<string, number> }
  | { verdict: 'hold'; reviewCode: string }
  | { verdict: 'block'; reasonCode: string; quarantine?: boolean };

/** One check the image guard runs on each image. */
export interface ImageCheck {
  /** A word of its own (letters, digits and `_ . : -`, at most 64), never `load`. */
  id: string;
  /** `match`: compares the image with known material (a hash service). `classify`: sends it to a model. */
  kind: 'match' | 'classify';
  /**
   * What a throw, or an answer with no verdict, does. `refuse` (default): the image is refused as unavailable. `skip`:
   * the check is a signal; its failure is written and the chain goes on. A `match` check is always `refuse`.
   */
  onError?: 'refuse' | 'skip';
  /**
   * Every reason code and review code the check can answer. The guard's `config.reasonCodes` is its own fixed codes
   * and every check's list. A vendor's check lists its category codes.
   */
  reasonCodes?: readonly string[];
  check(image: ImageUnderReview, context: GuardrailContext): Promise<ImageCheckResult>;
}

/** How an image guard is built. */
export interface ImageGuardrailOptions {
  /** A word (letters, digits and `_ . : -`, at most 64). */
  id: string;
  /**
   * Every `match` check runs on every image before any `classify` check runs. Every `match` check must come before
   * every `classify` check in the list, and at least one `classify` check is listed.
   */
  checks: ImageCheck[];
  /** `create()` throws unless a `match` check is listed. For a surface that takes people's uploads. Default false. */
  requireMatch?: boolean;
  /**
   * Fetches an `image_url` input once, under the host's own egress rules. Without it an `image_url` input is refused
   * as unavailable.
   */
  loadImage?: (url: string, context: GuardrailContext) => Promise<{ bytes: Uint8Array; mimeType?: string }>;
  /** The most images one input may carry; more are refused with `IMAGE_LIMIT` before any check runs. Default 4. */
  maxImages?: number;
  /** The deadline for one evaluation, every check of every image included. Default 15000 ms. */
  timeoutMs?: number;
  /** Sets `config.sequential`: the image checks finish before any phase 2 guard sees the input's text. Default false. */
  sequential?: boolean;
}

const WORD = /^[A-Za-z0-9_.:-]{1,64}$/;
const FIXED_CODES = ['IMAGE_LIMIT', 'IMAGE_CHECK_UNAVAILABLE'] as const;
const positiveInteger = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value > 0;
interface Captured { index: number; bytes: Uint8Array; mimeType: string }
/** What one image's checks amount to so far. `open` says whether a further check may still run on it. */
interface ImageState { open: boolean; judged: boolean; verdict?: GuardrailEvaluationResult; rank: 0 | 1 | 2 | 3 | 4 }
// rank: 4 a check's block, 3 a hold, 2 unavailable, 1 a flag, 0 nothing

/** Decodes base64 (white space allowed), or throws when the text is not base64. */
function decodeBase64(text: string): Uint8Array {
  const compact = text.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new TypeError('the image is not base64');
  const binary = atob(compact);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * A guard over an input's images (`visionInputs`), on the input stage. Built with {@link ImageGuardrail.create}.
 *
 * @example
 * ```ts
 * const images = ImageGuardrail.create({ id: 'images', checks: [hashCheck, visionCheck], requireMatch: true, sequential: true });
 * const decision = await moderateContent({ text, images: uploads }, { guards: [images, textGuard], context });
 * ```
 */
export class ImageGuardrail implements IGuardrailService {
  readonly id: string;
  readonly config: GuardrailConfig;
  /** The guard judges what a person sends: the input stage. */
  readonly stages: ReadonlyArray<'input' | 'output'> = ['input'];
  private readonly matches: ImageCheck[];
  private readonly classifies: ImageCheck[];
  private readonly maxImages: number;

  private constructor(private readonly opts: ImageGuardrailOptions) {
    this.id = opts.id;
    this.matches = opts.checks.filter((check) => check.kind === 'match');
    this.classifies = opts.checks.filter((check) => check.kind === 'classify');
    this.maxImages = opts.maxImages ?? 4;
    this.config = {
      canSanitize: false,
      evaluateStreamingChunks: false,
      failClosed: true,
      timeoutMs: opts.timeoutMs ?? 15_000,
      ...(opts.sequential === true ? { sequential: true } : {}),
      // every code this guard can answer: its own two and each check's list
      reasonCodes: Object.freeze([...new Set<string>([...FIXED_CODES, ...opts.checks.flatMap((check) => [...(check.reasonCodes ?? [])])])]),
    };
  }

  /**
   * Builds the guard, or throws when the list could send an image to a model unchecked or could judge nothing: an
   * empty list, no `classify` check, a `classify` check before a `match` check, a `match` check with
   * `onError: 'skip'`, and, with `requireMatch`, no `match` check.
   *
   * @param options - The id, the checks in order, and the guard's limits.
   * @returns The guard.
   * @throws TypeError when the options cannot make a guard that judges every image it lets through.
   */
  static create(options: ImageGuardrailOptions): ImageGuardrail {
    if (typeof options.id !== 'string' || !WORD.test(options.id)) throw new TypeError('ImageGuardrail: id must be a word: letters, digits and _ . : - (at most 64)');
    if (!Array.isArray(options.checks) || options.checks.length === 0) throw new TypeError('ImageGuardrail: at least one check is needed');
    if (options.maxImages !== undefined && !positiveInteger(options.maxImages)) throw new TypeError('ImageGuardrail: maxImages must be a whole number above 0');
    if (options.timeoutMs !== undefined && !positiveInteger(options.timeoutMs)) throw new TypeError('ImageGuardrail: timeoutMs must be a whole number above 0');
    if (options.loadImage !== undefined && typeof options.loadImage !== 'function') throw new TypeError('ImageGuardrail: loadImage must be a function');
    let sawClassify = false;
    const ids = new Set<string>();
    for (const check of options.checks) {
      if (typeof check?.id !== 'string' || !WORD.test(check.id) || check.id === 'load' || ids.has(check.id)) throw new TypeError('ImageGuardrail: every check needs an id of its own that is a word, and not "load"');
      ids.add(check.id);
      if (check.kind !== 'match' && check.kind !== 'classify') throw new TypeError(`ImageGuardrail: check ${check.id} needs a kind of match or classify`);
      if (typeof check.check !== 'function') throw new TypeError(`ImageGuardrail: check ${check.id} has no check function`);
      if (check.reasonCodes !== undefined && (!Array.isArray(check.reasonCodes) || !check.reasonCodes.every((code) => typeof code === 'string'))) throw new TypeError(`ImageGuardrail: check ${check.id} lists reasonCodes that are not strings`);
      if (check.kind === 'classify') sawClassify = true;
      else if (sawClassify) throw new TypeError(`ImageGuardrail: match check ${check.id} is listed after a classify check; every match check comes first`);
      if (check.kind === 'match' && check.onError === 'skip') throw new TypeError(`ImageGuardrail: match check ${check.id} cannot be skipped when it fails`);
    }
    if (!sawClassify) throw new TypeError('ImageGuardrail: at least one classify check is needed, or every image would be refused as unjudged');
    if (options.requireMatch === true && !options.checks.some((check) => check.kind === 'match')) throw new TypeError('ImageGuardrail: requireMatch is set and no match check is listed');
    return new ImageGuardrail({ ...options, checks: [...options.checks] });
  }

  private failed(checkId: string, posture: 'refuse' | 'skip', error: unknown): void {
    guardrailLog.warn('image_guard.check_failed', { guardrailId: safeWord(this.id), checkId: safeWord(checkId), posture, ...listedErrorFields(error) });
  }

  /**
   * An image nobody could judge: a BLOCK the library marks as a closed check's failure, so `moderateContent()` reports
   * it `unavailable` and ranks it below another guard's refusal or hold.
   */
  private unavailable(imageIndex: number, checkId: string): GuardrailEvaluationResult {
    return markGuardFailure({
      action: GuardrailAction.BLOCK,
      reason: 'An image could not be checked.',
      reasonCode: 'IMAGE_CHECK_UNAVAILABLE',
      metadata: { failClosed: true, guardrailId: this.id, imageIndex, checkId },
    });
  }

  /** One image, captured once: a base64 input decoded, an `image_url` input fetched by the host's `loadImage`. */
  private async capture(image: VisionInputData, context: GuardrailContext): Promise<{ bytes: Uint8Array; mimeType: string }> {
    if (typeof image?.data !== 'string') throw new TypeError('the image carries no data');
    if (image.type === 'base64') {
      const dataUrl = /^data:([^;,]*)(?:;[^,]*)?,(.*)$/s.exec(image.data);
      const bytes = decodeBase64(dataUrl ? dataUrl[2] : image.data);
      const mimeType = image.mimeType ?? (dataUrl && dataUrl[1] ? dataUrl[1] : undefined);
      if (!mimeType) throw new TypeError('the image names no mime type');
      return { bytes, mimeType };
    }
    if (image.type !== 'image_url') throw new TypeError('the image is neither base64 nor image_url');
    if (typeof this.opts.loadImage !== 'function') throw new TypeError('an image_url input needs loadImage');
    const loaded = await this.opts.loadImage(image.data, context);
    const mimeType = image.mimeType ?? loaded?.mimeType;
    if (!(loaded?.bytes instanceof Uint8Array) || loaded.bytes.length === 0) throw new TypeError('loadImage returned no bytes');
    if (!mimeType) throw new TypeError('the image names no mime type');
    return { bytes: new Uint8Array(loaded.bytes), mimeType };
  }

  /** Runs one check on one image and folds its answer into the image's state. A quarantine is returned at once. */
  private async run(check: ImageCheck, image: Captured, state: ImageState, context: GuardrailContext): Promise<GuardrailEvaluationResult | undefined> {
    const metadata = { guardrailId: this.id, imageIndex: image.index, checkId: check.id };
    // A throw, or an answer with no verdict: the image is refused as unavailable, or, for a signal, the chain goes on.
    const couldNotAnswer = (error: unknown): undefined => {
      const skip = check.kind === 'classify' && check.onError === 'skip';
      this.failed(check.id, skip ? 'skip' : 'refuse', error);
      if (!skip) {
        state.open = false;
        if (state.rank < 2) { state.rank = 2; state.verdict = this.unavailable(image.index, check.id); }
      }
      return undefined;
    };
    let answer: Awaited<ReturnType<ImageCheck['check']>>;
    try {
      // its own copy: a check cannot change what the next one reads
      answer = await check.check({ index: image.index, bytes: new Uint8Array(image.bytes), mimeType: image.mimeType }, context);
    } catch (error) {
      return couldNotAnswer(error);
    }
    const verdict = (answer as { verdict?: unknown } | null | undefined)?.verdict;
    if (verdict === 'block') {
      const blocked = answer as Extract<ImageCheckResult, { verdict: 'block' }>;
      const block: GuardrailEvaluationResult = { action: GuardrailAction.BLOCK, reasonCode: blocked.reasonCode, metadata: { ...metadata, ...(blocked.quarantine === true ? { quarantine: true } : {}) } };
      state.open = false; state.judged = true; state.rank = 4; state.verdict = block;
      return blocked.quarantine === true ? block : undefined;
    }
    if (verdict === 'hold') {
      state.open = false; state.judged = true;
      if (state.rank < 3) { state.rank = 3; state.verdict = holdResult((answer as Extract<ImageCheckResult, { verdict: 'hold' }>).reviewCode, { metadata }); }
      return undefined;
    }
    if (verdict === 'flag') {
      const flagged = answer as Extract<ImageCheckResult, { verdict: 'flag' }>;
      if (check.kind === 'classify') state.judged = true;
      if (state.rank < 1) { state.rank = 1; state.verdict = { action: GuardrailAction.FLAG, reasonCode: flagged.reasonCode, metadata: { ...metadata, ...(flagged.scores ? { scores: flagged.scores } : {}) } }; }
      return undefined;
    }
    if (verdict === 'pass') {
      // a match check's pass says the image is not known material, not what it shows
      if (check.kind === 'classify') state.judged = true;
      return undefined;
    }
    // an answer of another shape is a check that could not answer
    return couldNotAnswer(new TypeError('the check answered no verdict'));
  }

  /**
   * Judges the input's images. An input with no images answers null.
   *
   * @param payload - The input and its context; `context.vendorSignal` stops further `classify` checks once aborted.
   * @returns A check's block, else a hold, else an image refused as unavailable, else a flag, else null.
   */
  async evaluateInput({ context, input }: GuardrailInputPayload): Promise<GuardrailEvaluationResult | null> {
    const inputs = input.visionInputs ?? [];
    if (inputs.length === 0) return null;
    if (inputs.length > this.maxImages) {
      return { action: GuardrailAction.BLOCK, reason: 'Too many images.', reasonCode: 'IMAGE_LIMIT', metadata: { guardrailId: this.id } };
    }

    // One capture per image, before any check runs.
    const images: Captured[] = [];
    const states: ImageState[] = inputs.map(() => ({ open: true, judged: false, rank: 0 }));
    for (const [index, image] of inputs.entries()) {
      try {
        images.push({ index, ...(await this.capture(image, context)) });
      } catch (error) {
        this.failed('load', 'refuse', error);
        states[index] = { open: false, judged: false, rank: 2, verdict: this.unavailable(index, 'load') };
      }
    }

    // Every match check on every image, before any model check on any image. A quarantine ends everything.
    for (const image of images) {
      for (const check of this.matches) {
        if (!states[image.index].open) break;
        const quarantine = await this.run(check, image, states[image.index], context);
        if (quarantine) return quarantine;
      }
    }

    // The model checks, image by image. Once the call's signal says stop, no further one runs.
    for (const image of images) {
      const state = states[image.index];
      for (const check of this.classifies) {
        if (!state.open || context.vendorSignal?.aborted) break;
        const quarantine = await this.run(check, image, state, context);
        // a model check's quarantine ends the evaluation too: no further image goes to a model
        if (quarantine) return quarantine;
      }
      // A match check's pass says the image is not known material, not what it shows: an image no model check
      // answered for, and no check held or blocked, was judged by nobody.
      if (!state.judged && state.rank < 2) { state.rank = 2; state.verdict = this.unavailable(image.index, 'classify'); }
    }

    // Over all images: a check's block, then a hold, then unavailable, then a flag; the first image wins a tie.
    let worst: ImageState | undefined;
    for (const state of states) if (state.verdict && (!worst || state.rank > worst.rank)) worst = state;
    return worst?.verdict ?? null;
  }
}
