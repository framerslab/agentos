/**
 * @fileoverview A live transcript's translator: each final line is translated into one target through `generateText`
 * on the configured OpenAI provider with no fallback, the last lines as context, the result priced by the caller from
 * its usage. A line whose source reliably equals the target is skipped with no call; a line whose language is unknown
 * is translated from its own language. A failed call throws {@link TranslationProviderError}, never returning the
 * input, and carries the usage of an answer the provider billed. `boundMicro` answers the most one call can cost, for
 * a caller's spend check; `failedCallMicro` what a failed call is recorded as costing.
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
import { generateText, type TokenUsage } from '../../../api/generateText.js';
import { estimateMaxCallCostUSD } from '../../../api/runtime/modelPricing.js';
import { tokensOfChars } from '../../../api/runtime/spendBudget.js';
import { toMicro } from '../../../safety/runtime/SpendReservations.js';
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
  | { itemId: string; target: string; source: string | null; text: string; status: 'translated'; usage: TokenUsage | null; model: string; providerId: string; version: typeof TRANSLATOR_VERSION }
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
    return Math.ceil(toMicro(usd)) * (options.maxAttempts ?? DEFAULTS.maxAttempts);
  }

  /**
   * What a failed call is recorded as costing, in micro-dollars: the tokens the provider reported for an answer it billed
   * and the translator refused (`error.usage`, priced by the caller's `price`); the bound where the bill is unknown (a
   * timeout, a network error, a caller's abort, anything not a `TranslationProviderError`); nothing where the provider
   * refused with an HTTP status and reported no tokens, since it wrote nothing.
   */
  static failedCallMicro(error: unknown, boundMicro: number, price: (usage: TokenUsage) => number): number {
    if (!(error instanceof TranslationProviderError)) return boundMicro;
    if (error.usage) return price(error.usage);
    return error.code === 'TRANSLATION_REQUEST_FAILED' && error.status !== undefined ? 0 : boundMicro;
  }

  /**
   * Translates `line` into `target`, or skips it when its configured or detected source is the target.
   *
   * @throws {TranslationProviderError} `TRANSLATION_REQUEST_FAILED` (with the HTTP `status` when the provider answered),
   *   `TRANSLATION_TIMEOUT` past `timeoutMs`, `TRANSLATION_EMPTY_OUTPUT` and `TRANSLATION_TRUNCATED` (each with the
   *   billed `usage`). A call ended through `abortSignal` rejects with the signal's reason.
   */
  async translateLine(line: TranscriptLineInput, target: string, options: TranscriptTranslatorOptions): Promise<TranslatedLine> {
    options.abortSignal?.throwIfAborted();
    const base = { itemId: line.itemId, target, model: options.model, providerId: options.provider, version: TRANSLATOR_VERSION } as const;
    if (line.source.code !== null && line.source.provenance !== 'unknown' && line.source.code === target) {
      return { ...base, source: line.source.code, status: 'skipped', reason: 'same_language', usage: null };
    }
    const source = sourceOf(line);
    const maxOutputTokens = options.maxOutputTokens ?? TranscriptTranslator.defaultMaxOutputTokens(line.text);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new TranslationProviderError('translation timed out', options.provider, 'TRANSLATION_TIMEOUT')),
      options.timeoutMs ?? DEFAULTS.timeoutMs,
    );
    const onCallerAbort = () => controller.abort(options.abortSignal?.reason);
    options.abortSignal?.addEventListener('abort', onCallerAbort, { once: true });
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
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
        abortSignal: controller.signal,
      });
    } catch (error) {
      if (options.abortSignal?.aborted) throw error;
      if (controller.signal.aborted && controller.signal.reason instanceof TranslationProviderError) {
        logTranslationFailed('openai', 'timeout', undefined, error);
        throw controller.signal.reason;
      }
      const status = statusOf(error);
      logTranslationFailed('openai', 'request_failed', status, error);
      throw new TranslationProviderError(`translation failed${status ? ` with HTTP ${status}` : ''}`, options.provider, 'TRANSLATION_REQUEST_FAILED', status, error);
    } finally {
      clearTimeout(timer);
      options.abortSignal?.removeEventListener('abort', onCallerAbort);
    }
    // A refused answer was still billed: its usage rides the error, so the caller records its cost (failedCallMicro).
    if (result.finishReason === 'length') {
      logTranslationFailed('openai', 'truncated', 200);
      throw new TranslationProviderError('translation was cut at the output cap', options.provider, 'TRANSLATION_TRUNCATED', 200, undefined, result.usage ?? null);
    }
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (text === '') {
      logTranslationFailed('openai', 'empty_output', 200);
      throw new TranslationProviderError('translation answered with no text', options.provider, 'TRANSLATION_EMPTY_OUTPUT', 200, undefined, result.usage ?? null);
    }
    return { ...base, source, text, status: 'translated', usage: result.usage ?? null };
  }
}
