/**
 * @fileoverview Translation through an OpenAI text model, sent through `generateText` and so
 * through AgentOS's provider layer: the call is retried, timed and priced like any other text
 * call, and `providerMetadata.usage` carries its token counts and `costUSD`.
 *
 * A failed call throws {@link TranslationProviderError}; the provider never returns its input
 * as a translation.
 *
 * @module agentos/cognition/nlp/language/providers/OpenAITranslationProvider
 */
import { generateText } from '../../../../api/generateText';
import { ITranslationProvider, TranslationOptions, TranslationResult, TranslationProviderError } from '../interfaces';
import { logTranslationFailed, statusOf } from '../log';

interface OpenAIProviderParams {
  apiKey: string;
  /** OpenAI model id. Default `gpt-4o-mini`. */
  model?: string;
  /** OpenAI-compatible base URL (`https://api.openai.com/v1` by default), as `generateText` takes it. */
  baseUrl?: string;
}

export class OpenAITranslationProvider implements ITranslationProvider {
  public readonly id: string;
  public isInitialized = false;
  private params: OpenAIProviderParams;

  constructor(id: string, params: OpenAIProviderParams) {
    this.id = id;
    this.params = params;
  }

  async initialize(): Promise<void> {
    if (!this.params.apiKey) throw new Error('OpenAITranslationProvider: apiKey missing');
    this.isInitialized = true;
  }

  /**
   * Translates `input` from `source` to `target`.
   *
   * @throws {TranslationProviderError} `TRANSLATION_REQUEST_FAILED` (with the HTTP `status` when
   *   OpenAI answered) when the call fails, `TRANSLATION_EMPTY_OUTPUT` when the model answers
   *   with no text. A call cancelled through `options.abortSignal` rejects with the abort's reason.
   */
  async translate(input: string, source: string, target: string, options?: TranslationOptions): Promise<TranslationResult> {
    const system = `You are a translation engine. Translate the user's text from ${source} to ${target}. Preserve meaning and formatting. Reply with the translation only.`
      + (options?.domain ? ` Domain: ${options.domain}.` : '');
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        provider: 'openai',
        model: this.params.model || 'gpt-4o-mini',
        apiKey: this.params.apiKey,
        ...(this.params.baseUrl ? { baseUrl: this.params.baseUrl } : {}),
        system,
        prompt: input,
        // A translation goes to the provider the host configured, never to another vendor's key.
        fallbackProviders: [],
        source: 'language_translation',
        ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
      });
    } catch (err) {
      if (options?.abortSignal?.aborted) throw err;
      const status = statusOf(err);
      logTranslationFailed('openai', 'request_failed', status, err);
      throw new TranslationProviderError(
        `OpenAI translation failed${status ? ` with HTTP ${status}` : ''}`,
        this.id,
        'TRANSLATION_REQUEST_FAILED',
        status,
        err,
      );
    }
    if (typeof result.text !== 'string' || result.text.trim() === '') {
      logTranslationFailed('openai', 'empty_output', 200);
      throw new TranslationProviderError('OpenAI translation answered with no text', this.id, 'TRANSLATION_EMPTY_OUTPUT', 200);
    }
    return {
      output: result.text,
      providerId: this.id,
      sourceLanguage: source,
      targetLanguage: target,
      providerMetadata: { usage: result.usage, model: result.model },
    };
  }

  async shutdown() { /* noop */ }
}
