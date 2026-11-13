/**
 * @module guardrails/builtin/ImageGuardrail
 *
 * A guard over the images of an input. It holds the order of checks and no vendor code: every `match` check (a hash
 * service that knows material) runs on every image before any `classify` check (a model) runs on any image, a
 * quarantine ends the whole evaluation, and every check receives its own copy of bytes the guard captured once,
 * never a URL. An image no `classify` check answered for was judged by nobody and is refused as unavailable. Past its
 * deadline the guard starts no further capture or check, and the `deadlineSignal` it hands every check is aborted, so a
 * check sends nothing more and stops a request in flight.
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
  /**
   * Aborted once the guard's deadline has passed (its own `timeoutMs`, or the dispatcher's when that comes first) or the
   * guard has answered: nobody waits for the check's answer. A check sends nothing once it is aborted, and hands it to a
   * request in flight so the request stops. The guard sets it on every call; it is optional so that an
   * `ImageUnderReview` a host or a test builds itself needs none.
   */
  deadlineSignal?: AbortSignal;
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
  /**
   * Judges one image: receives the guard's own copy of its bytes (never a URL) with the guard's `deadlineSignal`, and
   * the call's context, and answers an {@link ImageCheckResult}. A throw, or any other answer, is a check that could not
   * answer. Once `image.deadlineSignal` is aborted, send nothing, and stop a request in flight (hand the signal to it).
   */
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
  /**
   * The most bytes one image may hold. A larger image is refused with `IMAGE_LIMIT` and no check runs on it: base64 is
   * measured before it is decoded, `loadImage` bytes as they come back. Default 20 MiB (20971520).
   */
  maxBytes?: number;
  /**
   * The deadline for one evaluation, every check of every image included. Default 15000 ms. Past it no further capture
   * or check starts, an image whose checks had not all run, or whose last check was still running, is refused as
   * unavailable unless a check blocked or held it, and the `deadlineSignal` every check received is aborted.
   */
  timeoutMs?: number;
  /** Sets `config.sequential`: the image checks finish before any phase 2 guard sees the input's text. Default false. */
  sequential?: boolean;
}

const WORD = /^[A-Za-z0-9_.:-]{1,64}$/;
const FIXED_CODES = ['IMAGE_LIMIT', 'IMAGE_CHECK_UNAVAILABLE'] as const;
const positiveInteger = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value > 0;
const isWord = (value: unknown): value is string => typeof value === 'string' && WORD.test(value);
/** An image over `maxBytes`: refused with `IMAGE_LIMIT`, not as a check that failed. */
class ImageTooLarge extends Error {}
interface Captured { index: number; bytes: Uint8Array; mimeType: string }
/** What one image's checks amount to so far. `open` says whether a further check may still run on it. */
interface ImageState { open: boolean; judged: boolean; verdict?: GuardrailEvaluationResult; rank: 0 | 1 | 2 | 3 | 4 }
// rank: 4 a check's block, 3 a hold, 2 unavailable, 1 a flag, 0 nothing

/**
 * Decodes base64 (white space allowed), or throws when the text is not base64 or would decode to more than `maxBytes`.
 * The size is read from the text's length before any copy is made.
 */
function decodeBase64(text: string, maxBytes: number): Uint8Array {
  // four characters carry three bytes; white space beyond the encoded length is allowed up to as much again
  if (text.length > 2 * 4 * Math.ceil(maxBytes / 3)) throw new ImageTooLarge();
  const compact = text.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new TypeError('the image is not base64');
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  if ((compact.length / 4) * 3 - padding > maxBytes) throw new ImageTooLarge();
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
  /** The id given to `create()`, a word. */
  readonly id: string;
  /**
   * Fail-closed, never a sanitizer, with the guard's deadline; `sequential` when asked; `reasonCodes` is the guard's two
   * fixed codes (`IMAGE_LIMIT`, `IMAGE_CHECK_UNAVAILABLE`) and every check's list.
   */
  readonly config: GuardrailConfig;
  /** The guard judges what a person sends: the input stage. */
  readonly stages: ReadonlyArray<'input' | 'output'> = ['input'];
  private readonly matches: ImageCheck[];
  private readonly classifies: ImageCheck[];
  private readonly maxImages: number;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  private constructor(private readonly opts: ImageGuardrailOptions) {
    this.id = opts.id;
    this.matches = opts.checks.filter((check) => check.kind === 'match');
    this.classifies = opts.checks.filter((check) => check.kind === 'classify');
    this.maxImages = opts.maxImages ?? 4;
    this.maxBytes = opts.maxBytes ?? 20 * 1024 * 1024;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.config = {
      canSanitize: false,
      evaluateStreamingChunks: false,
      failClosed: true,
      timeoutMs: this.timeoutMs,
      ...(opts.sequential === true ? { sequential: true } : {}),
      // every code this guard can answer: its own two and each check's list
      reasonCodes: Object.freeze([...new Set<string>([...FIXED_CODES, ...opts.checks.flatMap((check) => [...(check.reasonCodes ?? [])])])]),
    };
  }

  /**
   * Builds the guard, or throws when the list could send an image to a model unchecked or could judge nothing: an
   * empty list, no `classify` check, a `classify` check before a `match` check, a `match` check with
   * `onError: 'skip'`, an `onError` other than `refuse` or `skip`, a reason code that is not a word, and, with
   * `requireMatch`, no `match` check.
   *
   * @param options - The id, the checks in order, and the guard's limits.
   * @returns The guard.
   * @throws TypeError when the options cannot make a guard that judges every image it lets through.
   */
  static create(options: ImageGuardrailOptions): ImageGuardrail {
    if (typeof options.id !== 'string' || !WORD.test(options.id)) throw new TypeError('ImageGuardrail: id must be a word: letters, digits and _ . : - (at most 64)');
    if (!Array.isArray(options.checks) || options.checks.length === 0) throw new TypeError('ImageGuardrail: at least one check is needed');
    if (options.maxImages !== undefined && !positiveInteger(options.maxImages)) throw new TypeError('ImageGuardrail: maxImages must be a whole number above 0');
    if (options.maxBytes !== undefined && !positiveInteger(options.maxBytes)) throw new TypeError('ImageGuardrail: maxBytes must be a whole number above 0');
    if (options.timeoutMs !== undefined && !positiveInteger(options.timeoutMs)) throw new TypeError('ImageGuardrail: timeoutMs must be a whole number above 0');
    if (options.loadImage !== undefined && typeof options.loadImage !== 'function') throw new TypeError('ImageGuardrail: loadImage must be a function');
    let sawClassify = false;
    const ids = new Set<string>();
    for (const check of options.checks) {
      if (typeof check?.id !== 'string' || !WORD.test(check.id) || check.id === 'load' || ids.has(check.id)) throw new TypeError('ImageGuardrail: every check needs an id of its own that is a word, and not "load"');
      ids.add(check.id);
      if (check.kind !== 'match' && check.kind !== 'classify') throw new TypeError(`ImageGuardrail: check ${check.id} needs a kind of match or classify`);
      if (typeof check.check !== 'function') throw new TypeError(`ImageGuardrail: check ${check.id} has no check function`);
      if (check.reasonCodes !== undefined && (!Array.isArray(check.reasonCodes) || !check.reasonCodes.every(isWord))) throw new TypeError(`ImageGuardrail: check ${check.id} lists reasonCodes that are not words: letters, digits and _ . : - (at most 64)`);
      if (check.onError !== undefined && check.onError !== 'refuse' && check.onError !== 'skip') throw new TypeError(`ImageGuardrail: check ${check.id} has an onError other than refuse or skip`);
      if (check.kind === 'classify') sawClassify = true;
      else if (sawClassify) throw new TypeError(`ImageGuardrail: match check ${check.id} is listed after a classify check; every match check comes first`);
      if (check.kind === 'match' && check.onError === 'skip') throw new TypeError(`ImageGuardrail: match check ${check.id} cannot be skipped when it fails`);
    }
    if (!sawClassify) throw new TypeError('ImageGuardrail: at least one classify check is needed, or every image would be refused as unjudged');
    if (options.requireMatch === true && !options.checks.some((check) => check.kind === 'match')) throw new TypeError('ImageGuardrail: requireMatch is set and no match check is listed');
    // The guard keeps its own copy of each check as validated: a host that edits a check object later changes nothing.
    const checks = options.checks.map((check): ImageCheck => {
      const run = check.check;
      return Object.freeze({
        id: check.id,
        kind: check.kind,
        ...(check.onError !== undefined ? { onError: check.onError } : {}),
        ...(check.reasonCodes !== undefined ? { reasonCodes: Object.freeze([...check.reasonCodes]) } : {}),
        // called on the host's own object, so a check that reads `this` still works
        check: (image: ImageUnderReview, context: GuardrailContext) => run.call(check, image, context),
      });
    });
    return new ImageGuardrail({ ...options, checks });
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
      const dataUrl = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(image.data);
      // a data URL is base64 only when it says so; its other form is percent-encoded text
      if (dataUrl && !dataUrl[2].split(';').includes('base64')) throw new TypeError('the data URL is not base64');
      const bytes = decodeBase64(dataUrl ? dataUrl[3] : image.data, this.maxBytes);
      const mimeType = image.mimeType ?? (dataUrl && dataUrl[1] ? dataUrl[1] : undefined);
      if (!mimeType) throw new TypeError('the image names no mime type');
      return { bytes, mimeType };
    }
    if (image.type !== 'image_url') throw new TypeError('the image is neither base64 nor image_url');
    if (typeof this.opts.loadImage !== 'function') throw new TypeError('an image_url input needs loadImage');
    const loaded = await this.opts.loadImage(image.data, context);
    const mimeType = image.mimeType ?? loaded?.mimeType;
    if (!(loaded?.bytes instanceof Uint8Array) || loaded.bytes.length === 0) throw new TypeError('loadImage returned no bytes');
    if (loaded.bytes.length > this.maxBytes) throw new ImageTooLarge();
    if (!mimeType) throw new TypeError('the image names no mime type');
    return { bytes: new Uint8Array(loaded.bytes), mimeType };
  }

  /**
   * Runs one check on one image and folds its answer into the image's state. A quarantine is returned at once.
   * `deadlineSignal` is the evaluation's, handed to the check on the image.
   */
  private async run(check: ImageCheck, image: Captured, state: ImageState, context: GuardrailContext, deadlineSignal: AbortSignal): Promise<GuardrailEvaluationResult | undefined> {
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
      answer = await check.check({ index: image.index, bytes: new Uint8Array(image.bytes), mimeType: image.mimeType, deadlineSignal }, context);
    } catch (error) {
      return couldNotAnswer(error);
    }
    const verdict = (answer as { verdict?: unknown } | null | undefined)?.verdict;
    // a block, a flag or a hold carries a code that is a word, or it is no verdict: an answer nobody can route by code
    const code = verdict === 'hold' ? (answer as { reviewCode?: unknown }).reviewCode : (answer as { reasonCode?: unknown } | null | undefined)?.reasonCode;
    if ((verdict === 'block' || verdict === 'flag' || verdict === 'hold') && !isWord(code)) return couldNotAnswer(new TypeError('the check answered a verdict without a code'));
    if (verdict === 'block') {
      const blocked = answer as Extract<ImageCheckResult, { verdict: 'block' }>;
      const block: GuardrailEvaluationResult = { action: GuardrailAction.BLOCK, reasonCode: blocked.reasonCode, metadata: { ...metadata, ...(blocked.quarantine === true ? { quarantine: true } : {}) } };
      state.open = false; state.judged = true;
      // the first block on an image decides it; a later match check still runs and may quarantine
      if (state.rank < 4) { state.rank = 4; state.verdict = block; }
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
      // only finite numbers under word keys reach the verdict: a score carries no text about the image
      const scores = flagged.scores && typeof flagged.scores === 'object'
        ? Object.fromEntries(Object.entries(flagged.scores).filter(([key, value]) => WORD.test(key) && typeof value === 'number' && Number.isFinite(value)))
        : {};
      if (state.rank < 1) { state.rank = 1; state.verdict = { action: GuardrailAction.FLAG, reasonCode: flagged.reasonCode, metadata: { ...metadata, ...(Object.keys(scores).length > 0 ? { scores } : {}) } }; }
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
   * @param payload - The input and its context; `context.vendorSignal` stops further `classify` checks once aborted, and
   *   `deadlineSignal` (the dispatcher's deadline, which a required guard's spec may set shorter than `timeoutMs`) stops
   *   every further capture and check.
   * @returns A check's block, else a hold, else an image refused as unavailable, else a flag, else null.
   */
  async evaluateInput({ context, input, deadlineSignal }: GuardrailInputPayload): Promise<GuardrailEvaluationResult | null> {
    const inputs = input.visionInputs ?? [];
    if (inputs.length === 0) return null;
    if (inputs.length > this.maxImages) {
      return { action: GuardrailAction.BLOCK, reason: 'Too many images.', reasonCode: 'IMAGE_LIMIT', metadata: { guardrailId: this.id } };
    }

    // The checks' signal, one per evaluation: aborted at the guard's own deadline, at the dispatcher's when that comes
    // first, and once the guard has answered. A check still waiting then sends nothing, and a request in flight stops.
    const checks = new AbortController();
    const stop = (): void => checks.abort();
    const timer = setTimeout(stop, this.timeoutMs);
    if (deadlineSignal?.aborted) stop();
    else deadlineSignal?.addEventListener('abort', stop, { once: true });
    try {
      return await this.judge(inputs, context, checks.signal);
    } finally {
      clearTimeout(timer);
      deadlineSignal?.removeEventListener('abort', stop);
      stop();
    }
  }

  /**
   * Captures and checks the images under one evaluation's `deadlineSignal`, which every check receives on its image.
   *
   * @returns The verdict {@link ImageGuardrail.evaluateInput} answers.
   */
  private async judge(inputs: VisionInputData[], context: GuardrailContext, deadlineSignal: AbortSignal): Promise<GuardrailEvaluationResult | null> {
    // The dispatcher answers at the deadline and does not stop this evaluation: past it, nothing further starts, so no
    // image goes to a vendor after the decision. The deadline is the guard's own and the dispatcher's, whichever comes
    // first (a required guard runs under its spec's). An image whose next step would start late is refused as unavailable.
    const deadline = Date.now() + this.timeoutMs;
    const past = (): boolean => Date.now() >= deadline || deadlineSignal.aborted;
    const late = (state: ImageState, index: number, step: string): boolean => {
      if (!past()) return false;
      state.open = false;
      if (state.rank < 2) { state.rank = 2; state.verdict = this.unavailable(index, step); }
      return true;
    };

    // One capture per image, before any check runs.
    const images: Captured[] = [];
    const states: ImageState[] = inputs.map(() => ({ open: true, judged: false, rank: 0 }));
    for (const [index, image] of inputs.entries()) {
      if (late(states[index], index, 'load')) continue;
      try {
        images.push({ index, ...(await this.capture(image, context)) });
      } catch (error) {
        if (error instanceof ImageTooLarge) {
          // refused, as too many images are: no check runs on it, and the other images are still checked
          states[index] = { open: false, judged: true, rank: 4, verdict: { action: GuardrailAction.BLOCK, reason: 'An image is too large.', reasonCode: 'IMAGE_LIMIT', metadata: { guardrailId: this.id, imageIndex: index } } };
          continue;
        }
        this.failed('load', 'refuse', error);
        states[index] = { open: false, judged: false, rank: 2, verdict: this.unavailable(index, 'load') };
      }
    }

    // Every match check on every image, before any model check on any image. A quarantine ends everything. A block, a
    // hold or a failure keeps the image from the model checks but not from the other match checks: a later one may
    // still find known material.
    for (const image of images) {
      const state = states[image.index];
      for (const check of this.matches) {
        if (late(state, image.index, check.id)) break;
        const quarantine = await this.run(check, image, state, context, deadlineSignal);
        if (quarantine) return quarantine;
      }
    }

    // The model checks, image by image. Once the call's signal says stop, no further one runs.
    for (const image of images) {
      const state = states[image.index];
      let last = 'classify';
      for (const check of this.classifies) {
        if (!state.open || context.vendorSignal?.aborted) break;
        // a model check that never ran past the deadline leaves the image refused, whatever an earlier one answered
        if (late(state, image.index, check.id)) break;
        last = check.id;
        const quarantine = await this.run(check, image, state, context, deadlineSignal);
        // a model check's quarantine ends the evaluation too: no further image goes to a model
        if (quarantine) return quarantine;
      }
      // A match check's pass says the image is not known material, not what it shows: an image no model check
      // answered for, and no check held or blocked, was judged by nobody.
      if (!state.judged && state.rank < 2) { state.rank = 2; state.verdict = this.unavailable(image.index, 'classify'); }
      // A check still running when the deadline passed (the deadline stopped it, or it answered late, a skipped signal
      // included) leaves the image refused unless a check blocked or held it: the guard's answer past its deadline is
      // never an allow or a flag, which would otherwise come before the dispatcher's fail-closed timeout.
      else if (state.rank < 2 && past()) { state.rank = 2; state.verdict = this.unavailable(image.index, last); }
    }

    // Over all images: a check's block, then a hold, then unavailable, then a flag; the first image wins a tie.
    let worst: ImageState | undefined;
    for (const state of states) if (state.verdict && (!worst || state.rank > worst.rank)) worst = state;
    return worst?.verdict ?? null;
  }
}
