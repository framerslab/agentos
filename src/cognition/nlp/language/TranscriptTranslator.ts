/**
 * @fileoverview A live transcript's translator: each final line is translated into one target through `generateText`
 * on the configured OpenAI provider with no fallback, the last lines as context, the result priced by the caller from
 * its usage. A line whose source reliably equals the target is skipped with no call; a line whose language is unknown
 * is translated from its own language. A failed call throws {@link TranslationProviderError}, never returning the
 * input, and carries the usage of an answer the provider billed and the count of attempts that got no usable answer.
 * An OpenAI reasoning model runs at effort `low` with 1,024 tokens of room for its reasoning over the default cap.
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
import { addModelUsage, generateText, hasBillableUsage, sumTokenUsage, usageOfError, type TokenUsage } from '../../../api/generateText.js';
import { resolveModelOption } from '../../../api/model.js';
import { estimateMaxCallCostUSD } from '../../../api/runtime/modelPricing.js';
import { tokensOfChars } from '../../../api/runtime/spendBudget.js';
import { isOpenAIReasoningModel } from '../../../core/llm/providers/implementations/openaiModelFamilies.js';
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
  /** How many context lines are sent, a whole number of 0 or more; default 6. */
  maxContextLines?: number;
  /** The call's own timeout, from 1 to 2,147,483,647 ms; default 15,000 ms. */
  timeoutMs?: number;
  /**
   * The output cap, the reasoning of a reasoning model included; default `TranscriptTranslator.defaultMaxOutputTokens(text)`,
   * and 1,024 tokens more for an OpenAI reasoning model (the o-series, GPT-5 and GPT-6), which runs at effort `low`.
   */
  maxOutputTokens?: number;
  /** A first try and the retries `generateText` makes, a whole number of 1 or more; default 2. */
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
      /**
       * The call's tokens, as the provider reported them: the answer's, and those of earlier attempts answered with an
       * error status or with a Responses result marked failed; null when the answer reported none, so a caller records
       * the bound.
       */
      usage: TokenUsage | null;
      /**
       * The attempts before the answer that got no usable one: no HTTP answer (a network failure, the provider layer's
       * own timeout), or a success status whose body did not become the answer (lost while it was read, or a Responses
       * result marked failed that was sent again, whose tokens `usage` holds). Each may have been billed for a whole
       * answer nobody saw, so a caller that records the call's cost records its bound (`boundMicro`) when this is above
       * 0 or `usage` is null, and the priced `usage` otherwise.
       */
      unansweredAttempts: number;
      /** The model the call sent, as the provider received it (`openai:gpt-4o-mini` is `gpt-4o-mini`). */
      model: string;
      providerId: string;
      version: typeof TRANSLATOR_VERSION;
    }
  | { itemId: string; target: string; source: string; status: 'skipped'; reason: 'same_language'; usage: null; model: string; providerId: string; version: typeof TRANSLATOR_VERSION };

const DEFAULTS = { maxContextLines: 6, timeoutMs: 15_000, maxAttempts: 2 } as const;
const OUTPUT_CEILING = 2_048;
/**
 * The room an OpenAI reasoning model is given for its reasoning, which comes out of the same output cap as the answer:
 * the 1,024 tokens the fallback chain grants its reasoning legs at effort `low` (`maxTokensHeadroom`, generateText.ts).
 */
const REASONING_HEADROOM = 1_024;

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
 * `en_us` are `en`; a script subtag is kept, so `zh-Hans` and `zh-Hant` stay two languages to translate between. A
 * Chinese code with a region and no script takes the script the region is written in, as Unicode's likely subtags
 * give it (`zh-TW` and `zh-HK` are `zh-hant`, `zh-CN` is `zh-hans`); a bare `zh` names no script.
 */
function languageOf(code: string): string {
  const [primary = '', ...rest] = code.trim().toLowerCase().split(/[-_]/);
  const script = rest.find((part) => /^[a-z]{4}$/.test(part)) ?? (primary === 'zh' ? chineseScriptOf(rest) : undefined);
  return script ? `${primary}-${script}` : primary;
}

/** The script a Chinese code's region is written in (`Intl.Locale#maximize`), lower-cased; undefined without a region. */
function chineseScriptOf(subtags: readonly string[]): string | undefined {
  const region = subtags.find((part) => /^([a-z]{2}|\d{3})$/.test(part));
  if (region === undefined) return undefined;
  try {
    return new Intl.Locale(`zh-${region}`).maximize().script?.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The tokens a provider reported for a request in a usage report (`details.usage` of an error, `usage` of an attempt):
 * in the provider layer's form, or as the wire spells them on a body the provider could not use (the Responses API's
 * `input_tokens` and `output_tokens`, Chat Completions' `prompt_tokens` and `completion_tokens`). Null when it
 * reported none.
 */
function billedUsageOfReport(reported: unknown): TokenUsage | null {
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

/** The tokens a provider error reported for the request it ended (`details.usage`), null when it reported none. */
function billedUsageOf(error: unknown): TokenUsage | null {
  return billedUsageOfReport(usageOfError(error));
}

/** The sum of the reports present, null when neither is; a provider's cost that covers one of the two is left out. */
function sumUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (a === null || b === null) return a ?? b;
  const sum = sumTokenUsage(a, b);
  if (a.costUSD === undefined || b.costUSD === undefined) delete sum.costUSD;
  return sum;
}

/** The provider-side id the call sends, read as generateText reads it; the id as given where that read refuses it. */
function modelIdOf(options: TranscriptTranslatorOptions): string {
  try {
    return resolveModelOption(options, 'text').modelId;
  } catch {
    return options.model;
  }
}

/**
 * The attempts the call may make, the option's or the default. A count that is not a whole number of 1 or more is
 * refused with the `RangeError` the provider refuses it with, so no bound is ever priced on it and no call starts.
 */
function attemptsOf(options: TranscriptTranslatorOptions): number {
  const attempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError('maxAttempts is a whole number, 1 or more');
  return attempts;
}

/**
 * The earlier lines the call sends at most, the option's or the default. A count that is not a whole number of 0 or more
 * is refused with a `RangeError`: `slice` truncates a fraction, so `0.5` would send every earlier line, and the bound
 * would price them all.
 */
function contextLinesOf(options: TranscriptTranslatorOptions): number {
  const lines = options.maxContextLines ?? DEFAULTS.maxContextLines;
  if (!Number.isInteger(lines) || lines < 0) throw new RangeError('maxContextLines is a whole number, 0 or more');
  return lines;
}

/** The longest delay `setTimeout` keeps; Node runs a longer one, as one below 1 ms or not a number, after 1 ms. */
const TIMEOUT_CEILING_MS = 2_147_483_647;

/**
 * The call's own timeout, the option's or the default. A delay `setTimeout` cannot keep (below 1 ms, above
 * 2,147,483,647 ms, `Infinity` or not a number) is refused with a `RangeError`: Node would run it after 1 ms, so every
 * line would end as a timeout and be recorded at its bound.
 */
function timeoutOf(options: TranscriptTranslatorOptions): number {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  if (!(timeoutMs >= 1 && timeoutMs <= TIMEOUT_CEILING_MS)) {
    throw new RangeError(`timeoutMs is a number of milliseconds from 1 to ${TIMEOUT_CEILING_MS}`);
  }
  return timeoutMs;
}

/** The output cap the call sends: the host's, or the default with room for a reasoning model's reasoning. */
function capOf(line: TranscriptLineInput, options: TranscriptTranslatorOptions, modelId: string): number {
  if (options.maxOutputTokens !== undefined) return options.maxOutputTokens;
  const answer = TranscriptTranslator.defaultMaxOutputTokens(line.text);
  return isOpenAIReasoningModel(modelId) ? answer + REASONING_HEADROOM : answer;
}

/** The user message: the last `maxContextLines` lines, each after its speaker when it has one, then the line itself. */
function promptFor(line: TranscriptLineInput, maxContextLines: number): string {
  const context = maxContextLines > 0 ? line.context.slice(-maxContextLines) : [];
  const lines = context.map((each) => (each.speaker ? `${each.speaker}: ${each.text}` : each.text));
  return `${lines.length === 0 ? '' : `Earlier lines:\n${lines.join('\n')}\n\n`}Line to translate:\n${line.text}`;
}

/** Translates a live transcript's final lines, one line and one target a call. */
export class TranscriptTranslator {
  /**
   * The default output cap for the answer: 64 tokens plus three times the line's estimated tokens, at most 2,048. A call
   * to an OpenAI reasoning model sends 1,024 tokens more, for the reasoning that shares the cap.
   */
  static defaultMaxOutputTokens(text: string): number {
    return Math.min(OUTPUT_CEILING, 64 + 3 * tokensOfChars(text.length));
  }

  /**
   * The most one `translateLine` with these options can cost, in micro-dollars, times the attempts: the request as
   * `generateText` sends it, bounded by `estimateMaxCallCostUSD`, which counts a prompt at up to a token a byte, where
   * `estimateCallCostUSD`'s four characters a token undercounts CJK text, emoji and base64, and the output cap the call
   * sends, a reasoning model's room for its reasoning included. The model is read as the call reads it:
   * `openai:gpt-4o-mini` is priced as the `gpt-4o-mini` it sends.
   *
   * @throws {RangeError} For a `maxAttempts` that is not a whole number of 1 or more, a `maxContextLines` that is not a
   *   whole number of 0 or more, or a `timeoutMs` that is not a number from 1 to 2,147,483,647: a call with these
   *   options cannot run, so no bound is reserved for it.
   * @throws {Error} For a model with no price row, a model of another provider, or a request it cannot bound.
   */
  boundMicro(line: TranscriptLineInput, target: string, options: TranscriptTranslatorOptions): number {
    const attempts = attemptsOf(options);
    const maxContextLines = contextLinesOf(options);
    timeoutOf(options);
    const { modelId } = resolveModelOption(options, 'text');
    const maxOutputTokens = capOf(line, options, modelId);
    const usd = estimateMaxCallCostUSD(options.provider, modelId, {
      system: systemFor(target, sourceOf(line)),
      messages: [{ role: 'user', content: promptFor(line, maxContextLines) }],
      maxOutputTokens,
    });
    if (usd === undefined) throw new Error(`TranscriptTranslator: no bound for ${options.provider} ${options.model}`);
    // Up to the micro-dollar from the dollars themselves: a bound never rounds an attempt's fraction away.
    return Math.ceil(usd * 1_000_000) * attempts;
  }

  /**
   * What a failed call is recorded as costing, in micro-dollars: the tokens the provider reported for an answer it billed
   * and the translator refused (`error.usage`, priced by the caller's `price`); the bound where the bill is unknown (a
   * timeout, though its error carries the tokens earlier attempts reported, a network error, a caller's abort, an
   * attempt of the call that got no usable answer, anything not a `TranslationProviderError`); nothing where the
   * provider refused every attempt with an HTTP status and reported no tokens, since it wrote nothing. The bound covers
   * an unanswered attempt and the answer after it together: it is a whole answer's bound for every attempt the call may
   * make.
   */
  static failedCallMicro(error: unknown, boundMicro: number, price: (usage: TokenUsage) => number): number {
    if (!(error instanceof TranslationProviderError)) return boundMicro;
    // The attempt a timeout ended may have been billed for a whole answer nobody saw.
    if (error.unansweredAttempts > 0 || error.code === 'TRANSLATION_TIMEOUT') return boundMicro;
    if (error.usage) return price(error.usage);
    return error.code === 'TRANSLATION_REQUEST_FAILED' && error.status !== undefined ? 0 : boundMicro;
  }

  /**
   * Translates `line` into `target`, or skips it when its configured or detected source is the target's language,
   * compared without case or region (`en-US` is `en`, `zh-Hant` is not `zh-Hans`), a Chinese region naming its script
   * (`zh-TW` is `zh-Hant`, not `zh-CN`).
   *
   * @throws {TranslationProviderError} `TRANSLATION_REQUEST_FAILED` (with the HTTP `status` when the provider answered,
   *   and the `usage` the provider's error reported), `TRANSLATION_TIMEOUT` past `timeoutMs`, while the provider is
   *   still starting included (with the `usage` earlier attempts answered with an error status reported),
   *   `TRANSLATION_EMPTY_OUTPUT`, `TRANSLATION_TRUNCATED` and `TRANSLATION_INCOMPLETE` (each with the billed `usage`);
   *   each carries `unansweredAttempts`. A call ended through `abortSignal` rejects with the signal's reason at once.
   * @throws {RangeError} For a `maxAttempts` that is not a whole number of 1 or more, a `maxContextLines` that is not a
   *   whole number of 0 or more, or a `timeoutMs` that is not a number from 1 to 2,147,483,647, before anything is sent.
   */
  async translateLine(line: TranscriptLineInput, target: string, options: TranscriptTranslatorOptions): Promise<TranslatedLine> {
    options.abortSignal?.throwIfAborted();
    const attempts = attemptsOf(options);
    const maxContextLines = contextLinesOf(options);
    const timeoutMs = timeoutOf(options);
    // The model the call sends, so a result names what made it: `openai:gpt-4o-mini` is `gpt-4o-mini`.
    const modelId = modelIdOf(options);
    const base = { itemId: line.itemId, target, model: modelId, providerId: options.provider, version: TRANSLATOR_VERSION } as const;
    if (line.source.code !== null && line.source.provenance !== 'unknown' && languageOf(line.source.code) === languageOf(target)) {
      return { ...base, source: line.source.code, status: 'skipped', reason: 'same_language', usage: null };
    }
    const source = sourceOf(line);
    const maxOutputTokens = capOf(line, options, modelId);
    // Attempts that got no usable answer may each have been billed for a whole answer: those that got no HTTP answer,
    // and those whose success status came and whose body never became the answer (a connection cut while it was read).
    let noAnswer = 0;
    let succeeded = 0;
    let lastSucceeded = false;
    // The status the latest attempt answered with, kept for an error that loses it (a success body cut while it was read).
    let lastStatus: number | null = null;
    // The tokens attempts answered with an error status reported for themselves. A later attempt replaces such an
    // attempt's error, so its bill is kept here: `earlier` for the attempts before the latest, `latest` for the latest,
    // whose own error, when the call ends on it, reports the same tokens.
    let earlier: TokenUsage | null = null;
    let latest: TokenUsage | null = null;
    // `read` is how many successful attempts' bodies the call accounts for: the answer's, or the one whose usage an
    // error raised on a success carries.
    const unanswered = (read: number): number => noAnswer + Math.max(0, succeeded - read);
    const controller = new AbortController();
    // The timeout's error is made when it fires, so it carries the attempts that got no usable answer by then and the
    // tokens the attempts answered with an error status reported. The attempt it ends counts when its success status
    // had come, since its body is lost with it; one still waiting for its status reports itself only after the abort,
    // and is the attempt the error reports.
    const timer = setTimeout(
      () =>
        controller.abort(
          new TranslationProviderError('translation timed out', options.provider, 'TRANSLATION_TIMEOUT', undefined, undefined, sumUsage(earlier, latest), unanswered(0)),
        ),
      timeoutMs,
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
        prompt: promptFor(line, maxContextLines),
        // A translation goes to the provider the host configured, never to another vendor's key.
        fallbackProviders: [],
        source: 'transcript_translation',
        maxTokens: maxOutputTokens,
        // A reasoning model reasons at the lowest effort the provider layer sends (`low`): a line's translation needs
        // little, and the reasoning comes out of the cap above.
        ...(isOpenAIReasoningModel(modelId) ? { effort: 'low' } : {}),
        maxAttempts: attempts,
        // The provider reports each attempt once, when its status comes or when none came; a body lost after a
        // success status is not reported again, so it is counted here as a success the answer did not come from.
        onAttempt: (outcome) => {
          earlier = sumUsage(earlier, latest);
          latest = !outcome.ok && outcome.status !== null ? billedUsageOfReport(outcome.usage) : null;
          lastSucceeded = outcome.ok;
          lastStatus = outcome.status;
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
      // A body lost after a success status ends as a network error with no status: the attempt's own status stands.
      const status = statusOf(error) ?? (lastSucceeded && lastStatus !== null ? lastStatus : undefined);
      const billed = billedUsageOf(error) ?? latest;
      // Usage on an error accounts for a successful attempt's body only when that attempt was the last. A 500's usage
      // says nothing of the answer an earlier 200 may have been billed for, and the error of a response marked failed
      // can read a status of 500 though the attempt that brought it answered 200.
      const fromSuccess = billed !== null && lastSucceeded;
      logTranslationFailed('openai', 'request_failed', status, error);
      throw new TranslationProviderError(
        `translation failed${status ? ` with HTTP ${status}` : ''}`,
        options.provider,
        'TRANSLATION_REQUEST_FAILED',
        status,
        error,
        // The bill of the attempt the error reports, and of the attempts before it that answered with an error status.
        sumUsage(earlier, billed),
        unanswered(fromSuccess ? 1 : 0),
      );
    } finally {
      clearTimeout(timer);
      options.abortSignal?.removeEventListener('abort', onCallerAbort);
    }
    // A refused answer was still billed: its usage rides the error, so the caller records its cost (failedCallMicro).
    // generateText counts up from zeros, so an answer that reported no usage reads as zeros: that is no report, not a
    // bill of nothing, and it is null here so the call is recorded at its bound.
    // The attempts before it that answered with an error status and reported tokens were billed too.
    const usage = result.usage && hasBillableUsage(result.usage) ? sumUsage(earlier, result.usage) : null;
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
