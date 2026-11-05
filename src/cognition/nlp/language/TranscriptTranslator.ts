/**
 * @fileoverview A live transcript's translator: each final line is translated into one target through `generateText`
 * on the configured OpenAI provider with no fallback, the last lines as context, the result priced by the caller from
 * its usage. A line whose source reliably equals the target is skipped with no call; a line whose language is unknown
 * is translated from its own language. A failed call throws {@link TranslationProviderError}, never returning the
 * input, and carries the usage of an answer the provider billed and the count of attempts that got no usable answer.
 * `boundMicro` answers the most one call can cost, for a caller's spend check; `failedCallMicro` what a failed call is
 * recorded as costing.
 *
 * @example
 * ```ts
 * import { TranscriptTranslator } from '@framers/agentos';
 *
 * const translator = new TranscriptTranslator();
 * const options = { provider: 'openai', model: 'gpt-4o-mini', apiKey } as const;
 * const line = { itemId: 'item_7', text: 'Buenos días.', source: { code: 'es', provenance: 'detected' }, context } as const;
 * const most = translator.boundMicro(line, 'en', options); // reserve this much before the call
 * const result = await translator.translateLine(line, 'en', options);
 * if (result.status === 'translated') show(result.text);
 * ```
 *
 * @module agentos/cognition/nlp/language/TranscriptTranslator
 */
import { addModelUsage, generateText, hasBillableUsage, usageOfError, type TokenUsage } from '../../../api/generateText.js';
import { estimateMaxCallCostUSD } from '../../../api/runtime/modelPricing.js';
import { tokensOfChars } from '../../../api/runtime/spendBudget.js';
import { TranslationProviderError } from './interfaces.js';
import { logTranslationFailed, statusOf } from './log.js';

/** The prompt's and the context rule's version; moved when either changes, so a stored translation names the words that made it. */
export const TRANSLATOR_VERSION = 'v1' as const;

/** One final line to translate: its id, its words, what is known of its language, and the lines before it. */
export interface TranscriptLineInput {
  itemId: string;
  text: string;
  /** The code the hearing was configured with or detected, or null; `unknown` when neither is reliable. */
  source: { code: string | null; provenance: 'configured' | 'detected' | 'unknown' };
  /** The last final lines before this one, oldest first; at most `maxContextLines` are sent. */
  context: ReadonlyArray<{ text: string; speaker?: string | null }>;
}

/** How {@link TranscriptTranslator} calls the provider. */
export interface TranscriptTranslatorOptions {
  provider: 'openai';
  model: string;
  apiKey: string;
  baseUrl?: string;
  /** How many context lines are sent; default 6. */
  maxContextLines?: number;
  /** The call's own timeout; default 15,000 ms. */
  timeoutMs?: number;
  /** The output cap; default `TranscriptTranslator.defaultMaxOutputTokens(text)`. */
  maxOutputTokens?: number;
  /** A first try and the retries `generateText` makes; default 2. */
  maxAttempts?: number;
  /** Ends the call: it rejects with the signal's reason, and no request is sent once the signal has aborted. */
  abortSignal?: AbortSignal;
}

/** A translated line, or a line skipped because its source is the target, with no call made. */
export type TranslatedLine =
  | {
      itemId: string;
      target: string;
      source: string | null;
      text: string;
      status: 'translated';
      /** The answer's tokens, as the provider reported them. */
      usage: TokenUsage | null;
      /**
       * The attempts before the answer that got no usable one: no HTTP answer (a network failure, the provider layer's
       * own timeout), or a success status whose body was lost while it was read. Each may have been billed for a whole
       * answer nobody saw, so a caller that records the call's cost records its bound (`boundMicro`) when this is above
       * 0, and the priced `usage` otherwise.
       */
      unansweredAttempts: number;
      model: string;
      providerId: string;
      version: typeof TRANSLATOR_VERSION;
    }
  | { itemId: string; target: string; source: string; status: 'skipped'; reason: 'same_language'; usage: null; model: string; providerId: string; version: typeof TRANSLATOR_VERSION };

const DEFAULTS = { maxContextLines: 6, timeoutMs: 15_000, maxAttempts: 2 } as const;
const OUTPUT_CEILING = 2_048;

/** The system message: the task, what to keep, and the answer's shape. Pinned by a test; a change moves TRANSLATOR_VERSION. */
function systemFor(target: string, source: string | null): string {
  const from = source === null ? 'from its own language' : `from ${source}`;
  return `Translate the newest line of a live transcript ${from} into ${target}. Keep names, numbers, times and the speaker's register. Answer with the translation alone: no quotes, no notes, no commentary.`;
}

/** The source the prompt names: none for a line of unknown provenance, so it is translated from its own language. */
function sourceOf(line: TranscriptLineInput): string | null {
  return line.source.provenance === 'unknown' ? null : line.source.code;
}

/**
 * A language code as the same-language skip compares it: without case and without a region, so `EN`, `en-US` and
 * `en_us` are `en`; a script subtag is kept, so `zh-Hans` and `zh-Hant` stay two languages to translate between.
 */
function languageOf(code: string): string {
  const [primary = '', ...rest] = code.trim().toLowerCase().split(/[-_]/);
  const script = rest.find((part) => /^[a-z]{4}$/.test(part));
  return script ? `${primary}-${script}` : primary;
}

/**
 * The tokens a provider error reported for the request it ended (`details.usage`): in the provider layer's form, or as
 * the wire spells them on a body the provider could not use (the Responses API's `input_tokens` and `output_tokens`,
 * Chat Completions' `prompt_tokens` and `completion_tokens`). Null when it reported none.
 */
function billedUsageOf(error: unknown): TokenUsage | null {
  const reported = usageOfError(error);
  if (!reported || typeof reported !== 'object') return null;
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  addModelUsage(usage, reported);
  if (!hasBillableUsage(usage)) {
    const wire = reported as Record<string, unknown>;
    const count = (...values: unknown[]): number => {
      for (const value of values) if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
      return 0;
    };
    usage.promptTokens = count(wire.input_tokens, wire.prompt_tokens);
    usage.completionTokens = count(wire.output_tokens, wire.completion_tokens);
    usage.totalTokens = usage.promptTokens + usage.completionTokens;
  }
  return hasBillableUsage(usage) ? usage : null;
}

/** The user message: the last `maxContextLines` lines, each after its speaker when it has one, then the line itself. */
function promptFor(line: TranscriptLineInput, maxContextLines: number): string {
  const context = maxContextLines > 0 ? line.context.slice(-maxContextLines) : [];
  const lines = context.map((each) => (each.speaker ? `${each.speaker}: ${each.text}` : each.text));
  return `${lines.length === 0 ? '' : `Earlier lines:\n${lines.join('\n')}\n\n`}Line to translate:\n${line.text}`;
}

/** Translates a live transcript's final lines, one line and one target a call. */
export class TranscriptTranslator {
  /** The default output cap: 64 tokens plus three times the line's estimated tokens, at most 2,048. */
  static defaultMaxOutputTokens(text: string): number {
    return Math.min(OUTPUT_CEILING, 64 + 3 * tokensOfChars(text.length));
  }

  /**
   * The most one `translateLine` with these options can cost, in micro-dollars, times the attempts: the request as
   * `generateText` sends it, bounded by `estimateMaxCallCostUSD`, which counts a prompt at up to a token a byte, where
   * `estimateCallCostUSD`'s four characters a token undercounts CJK text, emoji and base64.
   *
   * @throws {Error} For a model with no price row or a request it cannot bound.
   */
  boundMicro(line: TranscriptLineInput, target: string, options: TranscriptTranslatorOptions): number {
    const maxContextLines = options.maxContextLines ?? DEFAULTS.maxContextLines;
    const maxOutputTokens = options.maxOutputTokens ?? TranscriptTranslator.defaultMaxOutputTokens(line.text);
    const usd = estimateMaxCallCostUSD(options.provider, options.model, {
      system: systemFor(target, sourceOf(line)),
      messages: [{ role: 'user', content: promptFor(line, maxContextLines) }],
      maxOutputTokens,
    });
    if (usd === undefined) throw new Error(`TranscriptTranslator: no bound for ${options.provider} ${options.model}`);
    // Up to the micro-dollar from the dollars themselves: a bound never rounds an attempt's fraction away.
    return Math.ceil(usd * 1_000_000) * (options.maxAttempts ?? DEFAULTS.maxAttempts);
  }

  /**
   * What a failed call is recorded as costing, in micro-dollars: the tokens the provider reported for an answer it billed
   * and the translator refused (`error.usage`, priced by the caller's `price`); the bound where the bill is unknown (a
   * timeout, a network error, a caller's abort, an attempt of the call that got no usable answer, anything not a
   * `TranslationProviderError`); nothing where the provider refused every attempt with an HTTP status and reported no
   * tokens, since it wrote nothing. The bound covers an unanswered attempt and the answer after it together: it is a
   * whole answer's bound for every attempt the call may make.
   */
  static failedCallMicro(error: unknown, boundMicro: number, price: (usage: TokenUsage) => number): number {
    if (!(error instanceof TranslationProviderError)) return boundMicro;
    if (error.unansweredAttempts > 0) return boundMicro;
    if (error.usage) return price(error.usage);
    return error.code === 'TRANSLATION_REQUEST_FAILED' && error.status !== undefined ? 0 : boundMicro;
  }

  /**
   * Translates `line` into `target`, or skips it when its configured or detected source is the target's language,
   * compared without case or region (`en-US` is `en`, `zh-Hant` is not `zh-Hans`).
   *
   * @throws {TranslationProviderError} `TRANSLATION_REQUEST_FAILED` (with the HTTP `status` when the provider answered,
   *   and the `usage` the provider's error reported), `TRANSLATION_TIMEOUT` past `timeoutMs`, while the provider is
   *   still starting included, `TRANSLATION_EMPTY_OUTPUT`, `TRANSLATION_TRUNCATED` and `TRANSLATION_INCOMPLETE` (each
   *   with the billed `usage`); each carries `unansweredAttempts`. A call ended through `abortSignal` rejects with the
   *   signal's reason at once.
   */
  async translateLine(line: TranscriptLineInput, target: string, options: TranscriptTranslatorOptions): Promise<TranslatedLine> {
    options.abortSignal?.throwIfAborted();
    const base = { itemId: line.itemId, target, model: options.model, providerId: options.provider, version: TRANSLATOR_VERSION } as const;
    if (line.source.code !== null && line.source.provenance !== 'unknown' && languageOf(line.source.code) === languageOf(target)) {
      return { ...base, source: line.source.code, status: 'skipped', reason: 'same_language', usage: null };
    }
    const source = sourceOf(line);
    const maxOutputTokens = options.maxOutputTokens ?? TranscriptTranslator.defaultMaxOutputTokens(line.text);
    // Attempts that got no usable answer may each have been billed for a whole answer: those that got no HTTP answer,
    // and those whose success status came and whose body never became the answer (a connection cut while it was read).
    let noAnswer = 0;
    let succeeded = 0;
    // `read` is how many successful attempts' bodies the call accounts for: the answer's, or the one whose usage an
    // error raised on a success carries.
    const unanswered = (read: number): number => noAnswer + Math.max(0, succeeded - read);
    const controller = new AbortController();
    // The timeout's error is made when it fires, so it carries the attempts that got no usable answer by then. The
    // attempt it ends counts when its success status had come, since its body is lost with it; one still waiting for
    // its status reports itself only after the abort, and is the attempt the error reports.
    const timer = setTimeout(
      () =>
        controller.abort(
          new TranslationProviderError('translation timed out', options.provider, 'TRANSLATION_TIMEOUT', undefined, undefined, null, unanswered(0)),
        ),
      options.timeoutMs ?? DEFAULTS.timeoutMs,
    );
    const onCallerAbort = () => controller.abort(options.abortSignal?.reason);
    options.abortSignal?.addEventListener('abort', onCallerAbort, { once: true });
    // generateText starts the provider (its model listing) before the first send without the signal, so the call is
    // ended here as well, the moment the signal aborts; the request is never sent, since no step starts after it. The
    // listing itself runs to its end: the provider is cached per key and base URL and shared by every caller of them.
    const stopped = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      const call = generateText({
        provider: options.provider,
        model: options.model,
        apiKey: options.apiKey,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        system: systemFor(target, source),
        prompt: promptFor(line, options.maxContextLines ?? DEFAULTS.maxContextLines),
        // A translation goes to the provider the host configured, never to another vendor's key.
        fallbackProviders: [],
        source: 'transcript_translation',
        maxTokens: maxOutputTokens,
        maxAttempts: options.maxAttempts ?? DEFAULTS.maxAttempts,
        // The provider reports each attempt once, when its status comes or when none came; a body lost after a
        // success status is not reported again, so it is counted here as a success the answer did not come from.
        onAttempt: (outcome) => {
          if (outcome.ok) succeeded += 1;
          else if (outcome.status === null) noAnswer += 1;
        },
        abortSignal: controller.signal,
      });
      result = await Promise.race([call, stopped]);
    } catch (error) {
      if (options.abortSignal?.aborted) throw error;
      if (controller.signal.aborted && controller.signal.reason instanceof TranslationProviderError) {
        logTranslationFailed('openai', 'timeout', undefined, error);
        throw controller.signal.reason;
      }
      const status = statusOf(error);
      const billed = billedUsageOf(error);
      // Usage on an error accounts for a successful attempt's body only when the error is not an HTTP failure of its
      // own: a 500's usage says nothing of the answer an earlier 200 may have been billed for.
      const fromSuccess = billed !== null && (status === undefined || (status >= 200 && status < 300));
      logTranslationFailed('openai', 'request_failed', status, error);
      throw new TranslationProviderError(
        `translation failed${status ? ` with HTTP ${status}` : ''}`,
        options.provider,
        'TRANSLATION_REQUEST_FAILED',
        status,
        error,
        billed,
        unanswered(fromSuccess ? 1 : 0),
      );
    } finally {
      clearTimeout(timer);
      options.abortSignal?.removeEventListener('abort', onCallerAbort);
    }
    // A refused answer was still billed: its usage rides the error, so the caller records its cost (failedCallMicro).
    const usage = result.usage ?? null;
    const unansweredAttempts = unanswered(1);
    if (result.finishReason === 'length') {
      logTranslationFailed('openai', 'truncated', 200);
      throw new TranslationProviderError('translation was cut at the output cap', options.provider, 'TRANSLATION_TRUNCATED', 200, undefined, usage, unansweredAttempts);
    }
    // Only a `stop` finish is a whole answer: text a content filter stopped is part of one.
    if (result.finishReason !== 'stop') {
      logTranslationFailed('openai', 'incomplete', 200);
      throw new TranslationProviderError(`translation stopped before its end (${String(result.finishReason)})`, options.provider, 'TRANSLATION_INCOMPLETE', 200, undefined, usage, unansweredAttempts);
    }
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (text === '') {
      logTranslationFailed('openai', 'empty_output', 200);
      throw new TranslationProviderError('translation answered with no text', options.provider, 'TRANSLATION_EMPTY_OUTPUT', 200, undefined, usage, unansweredAttempts);
    }
    return { ...base, source, text, status: 'translated', usage, unansweredAttempts };
  }
}
