/**
 * @file interfaces.ts
 * @description Core multilingual service contracts for AgentOS.
 * Defines provider-agnostic interfaces for language detection, translation,
 * and the high-level language orchestration service used throughout the runtime.
 *
 * The goal is to allow hosts to plug in any combination of third-party APIs
 * (e.g., OpenAI, DeepL, Azure Translator, Google Cloud Translation, custom ML models)
 * while retaining consistent negotiation, auditing, and fallback behavior.
 */

import type { TokenUsage } from '../../../api/generateText.js';

/**
 * Represents a single language confidence result.
 * Code SHOULD be a BCP-47 or ISO 639-1 code (e.g. "en", "en-US", "es", "fr-FR").
 */
export interface DetectedLanguageResult {
  /** Detected language code (BCP-47 preferred; may degrade to ISO 639-1). */
  code: string;
  /** Confidence score in range [0,1]. */
  confidence: number;
  /** Optional provider-specific metadata (raw probabilities, tokens, etc.). */
  providerMetadata?: Record<string, unknown>;
}

/**
 * Configuration descriptor for a language detection provider.
 */
export interface ILanguageDetectionProviderConfig {
  /** Unique ID referenced in AgentOSConfig.languageConfig.detectionProviders. */
  id: string;
  /** Optional initialization parameters (API keys, model hints, etc.). */
  params?: Record<string, unknown>;
  /** Relative priority (lower executes earlier). */
  priority?: number;
  /** Minimum confidence threshold before a result is considered. */
  minConfidence?: number;
}

/**
 * Pluggable detection provider interface.
 * Providers SHOULD return an ordered list with the highest confidence first.
 */
export interface ILanguageDetectionProvider {
  readonly id: string;
  readonly isInitialized: boolean;
  /** Perform any async setup (API key validation, model warm-up). */
  initialize(): Promise<void>;
  /** Detect language from plain text. */
  detect(text: string): Promise<DetectedLanguageResult[]>;
  /** Optional audio-based detection (e.g., short clip classification). */
  detectFromAudio?(audio: Buffer): Promise<DetectedLanguageResult[]>;
  /** Dispose resources (close handles, free model memory). */
  shutdown?(): Promise<void>;
}

/**
 * Configuration descriptor for a translation provider.
 */
export interface ITranslationProviderConfig {
  id: string;
  params?: Record<string, unknown>;
  /** Cost tier hint for routing ("low", "medium", "high"). */
  costTier?: 'low' | 'medium' | 'high';
  /** Relative priority for fallback ordering. */
  priority?: number;
  /** Maximum characters per request (provider constraint). */
  maxCharsPerRequest?: number;
  /** Supported language codes subset; undefined means provider attempts all. */
  supportedLanguages?: string[];
}

/** Domain categories inform provider-specific prompt tuning or glossary application. */
export type TranslationDomain = 'general' | 'technical' | 'code' | 'prompt' | 'rag' | 'ui';

/** Options for translation calls. */
export interface TranslationOptions {
  domain?: TranslationDomain;
  /** Preserve markdown/code fencing. */
  preserveFormatting?: boolean;
  /** If streaming incremental translation is desired (phase 2). */
  streamingCallback?: (delta: string) => void;
  /** Abort controller for cancellation semantics. */
  abortSignal?: AbortSignal;
}

/** Result of a translation operation. */
export interface TranslationResult {
  output: string;
  providerId: string;
  sourceLanguage: string;
  targetLanguage: string;
  /** Raw provider timing or token usage. */
  providerMetadata?: Record<string, unknown>;
}

/** Pluggable translation provider interface. */
export interface ITranslationProvider {
  readonly id: string;
  readonly isInitialized: boolean;
  initialize(): Promise<void>;
  translate(input: string, source: string, target: string, options?: TranslationOptions): Promise<TranslationResult>;
  shutdown?(): Promise<void>;
}

/** Negotiation input parameters for the LanguageService. */
export interface LanguageNegotiationParams {
  explicitUserLanguage?: string; // UI selection (e.g. from language switcher)
  detectedLanguages?: DetectedLanguageResult[]; // From detection providers
  conversationPreferred?: string; // Persisted preference for this conversation
  personaDefault?: string; // Persona's default language
  configDefault: string; // Global defaultLanguage from AgentOSConfig
  supported: string[]; // Supported set
  fallbackChain: string[]; // Fallback languages from config
  preferSourceLanguageResponses?: boolean; // Whether to answer in detected source if viable
  /** Optional pre-specified target language override. */
  targetLanguage?: string;
}

/** Output of negotiation step. */
export interface LanguageNegotiationResult {
  sourceLanguage: string; // Primary detected or explicit
  targetLanguage: string; // Language selected for response generation
  pivotLanguage?: string; // Optional normalization language
  confidence: number; // Confidence of source
  negotiationPath: string[]; // Trace of decision steps
  warnings?: string[]; // Non-fatal issues (unsupported source, low confidence)
}

/**
 * High-level language orchestration service used by AgentOS runtime.
 */
export interface ILanguageService {
  /** Initialize providers and internal caches. */
  initialize(): Promise<void>;

  /** Perform language detection across configured providers & merge results. */
  detectLanguages(text: string): Promise<DetectedLanguageResult[]>;

  /** Determine target/pivot languages given negotiation inputs. */
  negotiate(params: LanguageNegotiationParams): LanguageNegotiationResult;

  /** Optional normalization before prompt construction (pivot). */
  maybeNormalizeForPivot(content: string, source: string, pivot?: string): Promise<{ normalized: string; providerId?: string } | null>;

  /** Translate post-generation to user display target (if differs). */
  maybeTranslateForDisplay(content: string, source: string, target: string): Promise<TranslationResult | null>;

  /** Translate query for RAG pivot search. */
  translateQueryForRag(query: string, source: string, pivot: string): Promise<TranslationResult | null>;

  /** Translate retrieved RAG results back to target language. */
  translateRagResults(results: Array<{ content: string; language: string }>, target: string): Promise<Array<{ content: string; sourceLanguage: string; translated?: string }>>;

  /** Wrap tool input translation logic. */
  translateToolArguments(args: Record<string, any>, source: string, toolLanguage: string): Promise<{ translatedArgs: Record<string, any>; providerId?: string } | null>;

  /** Wrap tool result translation logic. */
  translateToolResult(result: any, source: string, target: string): Promise<{ translatedResult: any; providerId?: string } | null>;

  /** Graceful shutdown for providers. */
  shutdown(): Promise<void>;
}

/** Utility to determine if a code block should be excluded from translation. */
export function isLikelyCodeBlock(snippet: string): boolean {
  return /```[a-zA-Z0-9_-]*[\s\S]*?```/.test(snippet) || /class\s+\w+|function\s+\w+|=>/.test(snippet);
}

/** Simple heuristic partition for mixed content translation strategies. */
export function partitionCodeAndProse(content: string): { codeBlocks: string[]; prose: string } {
  const codeBlocks: string[] = [];
  let prose = content;
  const codeRegex = /```[\s\S]*?```/g;
  const matches = content.match(codeRegex);
  if (matches) {
    matches.forEach(m => {
      codeBlocks.push(m);
      prose = prose.replace(m, `@@CODE_BLOCK_${codeBlocks.length - 1}@@`);
    });
  }
  return { codeBlocks, prose };
}

/** Recombine partitioned content after translating prose only. */
export function recombineCodeAndProse(translatedProse: string, codeBlocks: string[]): string {
  let output = translatedProse;
  codeBlocks.forEach((block, idx) => {
    output = output.replace(`@@CODE_BLOCK_${idx}@@`, block);
  });
  return output;
}

/**
 * Why a translation provider refused to return a translation: the request failed (an HTTP
 * status other than 2xx, a network error or the provider layer's own timeout), the provider
 * answered with no text, the call was aborted at the translator's own timeout
 * (`TRANSLATION_TIMEOUT`, which `TranscriptTranslator` throws), the answer stopped at
 * the output cap with a `length` finish (`TRANSLATION_TRUNCATED`), or it stopped for
 * another reason before its end, a content filter among them (`TRANSLATION_INCOMPLETE`).
 */
export type TranslationErrorCode =
  | 'TRANSLATION_REQUEST_FAILED'
  | 'TRANSLATION_EMPTY_OUTPUT'
  | 'TRANSLATION_TIMEOUT'
  | 'TRANSLATION_TRUNCATED'
  | 'TRANSLATION_INCOMPLETE';

/**
 * Thrown by a translation provider, and so by every `LanguageService` method that translates,
 * when no translation came back. A provider never returns its input as the output of a failed
 * call, so a caller that receives a {@link TranslationResult} holds a real translation, and a
 * caller that wants to show the original line on failure catches this error and decides so.
 *
 * @example
 * ```ts
 * try {
 *   const res = await languageService.maybeTranslateForDisplay(line, 'en', 'es');
 *   show(res?.output ?? line);
 * } catch (err) {
 *   if (err instanceof TranslationProviderError) showUntranslated(line, err.code, err.status);
 *   else throw err;
 * }
 * ```
 */
export class TranslationProviderError extends Error {
  /** {@link TranslationErrorCode}: what failed. */
  public readonly code: TranslationErrorCode;
  /** The id of the provider that failed, as configured (`openai_chat`, `deepl`). */
  public readonly providerId: string;
  /** The HTTP status the provider answered with, when it answered. */
  public readonly status?: number;
  /** The underlying error, when there was one. */
  public readonly cause?: unknown;
  /**
   * The tokens the provider reported for an answer it billed and the translator refused (an
   * empty answer, a `length` finish, an answer a filter stopped, a body the provider could not
   * use), so the caller records what the failed call cost; null when no answer came back or
   * the provider reported none.
   */
  public readonly usage: TokenUsage | null;
  /**
   * The attempts of the call that got no usable answer before the one this error reports: no
   * HTTP answer (a network failure, the provider layer's own timeout), or a success status
   * whose body was lost while it was read. Each may have been billed for a whole answer nobody
   * saw, so a caller records such a call at its bound rather than at `usage` or at nothing; 0
   * when every attempt was answered, and from every provider but the transcript translator.
   */
  public readonly unansweredAttempts: number;

  constructor(
    message: string,
    providerId: string,
    code: TranslationErrorCode,
    status?: number,
    cause?: unknown,
    usage: TokenUsage | null = null,
    unansweredAttempts = 0,
  ) {
    super(message);
    this.name = 'TranslationProviderError';
    this.code = code;
    this.providerId = providerId;
    this.status = status;
    this.cause = cause;
    this.usage = usage;
    this.unansweredAttempts = unansweredAttempts;
  }
}

/**
 * Thrown by a detection provider that cannot do the detection it is asked for. The
 * `WhisperDetectionProvider` throws it from `detect(text)`: Whisper is a speech model and
 * detects nothing from text, and the provider makes no call, so it answers no guess.
 */
export class LanguageDetectionUnsupportedError extends Error {
  /** Always `LANGUAGE_DETECTION_UNSUPPORTED`. */
  public readonly code = 'LANGUAGE_DETECTION_UNSUPPORTED' as const;
  /** The id of the provider that refused. */
  public readonly providerId: string;

  constructor(message: string, providerId: string) {
    super(message);
    this.name = 'LanguageDetectionUnsupportedError';
    this.providerId = providerId;
  }
}
