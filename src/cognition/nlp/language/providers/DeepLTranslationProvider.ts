/**
 * @fileoverview Translation through DeepL's `/v2/translate`. The key goes in the
 * `Authorization` header as `DeepL-Auth-Key <key>`, the only form DeepL accepts: it ended
 * `auth_key` authentication in a query parameter or the request body, and answers such a
 * request with 403 (https://developers.deepl.com/docs/getting-started/auth,
 * https://developers.deepl.com/docs/resources/breaking-changes-change-notices/november-2025-deprecation-of-legacy-auth-methods).
 *
 * A failed call throws {@link TranslationProviderError}; the provider never returns its input
 * as a translation.
 *
 * @module agentos/cognition/nlp/language/providers/DeepLTranslationProvider
 */
import { ITranslationProvider, TranslationOptions, TranslationResult, TranslationProviderError } from '../interfaces';
import { logTranslationFailed, statusOf } from '../log';

interface DeepLProviderParams {
  apiKey: string;
  /**
   * The full translate URL. Default `https://api-free.deepl.com/v2/translate` for a Free API key
   * (DeepL marks those with the suffix `:fx`) and `https://api.deepl.com/v2/translate` otherwise.
   */
  endpoint?: string;
}

export class DeepLTranslationProvider implements ITranslationProvider {
  public readonly id: string;
  public isInitialized = false;
  private params: DeepLProviderParams;

  constructor(id: string, params: DeepLProviderParams) {
    this.id = id;
    this.params = params;
  }

  async initialize(): Promise<void> {
    if (!this.params.apiKey) throw new Error('DeepLTranslationProvider: apiKey missing');
    this.isInitialized = true;
  }

  /**
   * Translates `input` from `source` to `target`; DeepL takes the codes upper-cased (`EN`, `DE`).
   *
   * @throws {TranslationProviderError} `TRANSLATION_REQUEST_FAILED` (with the HTTP `status` when
   *   DeepL answered: 403 for a refused key, 456 for a used-up quota) when the call fails,
   *   `TRANSLATION_EMPTY_OUTPUT` when DeepL answers with no translation. A call cancelled through
   *   `options.abortSignal` rejects with the abort's reason.
   */
  async translate(input: string, source: string, target: string, options?: TranslationOptions): Promise<TranslationResult> {
    const endpoint = this.params.endpoint
      || (this.params.apiKey.endsWith(':fx') ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate');
    let data: { translations?: Array<{ text?: unknown }>; character_count?: unknown };
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `DeepL-Auth-Key ${this.params.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: [input], source_lang: source.toUpperCase(), target_lang: target.toUpperCase() }),
        ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
      });
      if (!response.ok) {
        throw Object.assign(new Error(`DeepL answered HTTP ${response.status}`), { name: 'DeepLHttpError', status: response.status });
      }
      data = (await response.json()) as typeof data;
    } catch (err) {
      if (options?.abortSignal?.aborted) throw err;
      const status = statusOf(err);
      logTranslationFailed('deepl', 'request_failed', status, err);
      throw new TranslationProviderError(
        `DeepL translation failed${status ? ` with HTTP ${status}` : ''}`,
        this.id,
        'TRANSLATION_REQUEST_FAILED',
        status,
        err,
      );
    }
    const output = data?.translations?.[0]?.text;
    if (typeof output !== 'string' || output.trim() === '') {
      logTranslationFailed('deepl', 'empty_output', 200);
      throw new TranslationProviderError('DeepL answered with no translation', this.id, 'TRANSLATION_EMPTY_OUTPUT', 200);
    }
    return {
      output,
      providerId: this.id,
      sourceLanguage: source,
      targetLanguage: target,
      providerMetadata: { character_count: data.character_count },
    };
  }

  async shutdown() { /* noop */ }
}
