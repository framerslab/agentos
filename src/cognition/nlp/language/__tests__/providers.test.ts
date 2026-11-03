/**
 * @fileoverview The translation and detection providers on their real paths, with only the
 * network stubbed: the OpenAI provider through generateText and the OpenAI provider layer
 * (priced usage, a typed error on failure), the DeepL provider's request (the key in the
 * Authorization header, never `auth_key`) and the Whisper detection provider's refusal.
 *
 * axios is stubbed to reject, so a provider that still posts through it fails here instead of
 * reaching a vendor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';

vi.mock('axios', () => {
  const refuse = vi.fn(async () => {
    throw new Error('axios is not stubbed for this test');
  });
  return { default: { post: refuse, get: refuse }, post: refuse, get: refuse };
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { setLogger, resetLoggerFactory } from '../../../../core/logging/loggerFactory.js';
import { globalLLMProviderHealth } from '../../../../core/safety/LLMProviderHealthRegistry';
import { LanguageService } from '../LanguageService';
import { LanguageDetectionUnsupportedError, TranslationProviderError } from '../interfaces';
import { OpenAITranslationProvider } from '../providers/OpenAITranslationProvider';
import { DeepLTranslationProvider } from '../providers/DeepLTranslationProvider';
import { WhisperDetectionProvider } from '../providers/WhisperDetectionProvider';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A Chat Completions body whose message is `content` and whose usage reports the given counts. */
function chatCompletion(content: string | null, promptTokens = 1_000, completionTokens = 500): Record<string, unknown> {
  return {
    id: 'chatcmpl-translate',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

/**
 * Answers every GET with a model listing and each POST from the handler whose endpoint the URL
 * ends with; any other POST gets a 404, which the OpenAI provider does not retry.
 */
function serve(posts: Record<string, () => Response>): void {
  fetchMock.mockImplementation(async (url: unknown, init?: { method?: string }) => {
    const target = String(url);
    if ((init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ object: 'list', data: [{ id: 'gpt-4o-mini', object: 'model', created: 1, owned_by: 'openai' }] });
    }
    const handler = Object.entries(posts).find(([endpoint]) => target.endsWith(endpoint))?.[1];
    return handler ? handler() : jsonResponse({ error: { message: `unexpected POST ${target}`, type: 'invalid_request_error' } }, 404);
  });
}

/** Every POST the providers sent: its URL, its headers and its parsed body. */
function posts(): Array<{ url: string; headers: Headers; body: any }> {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')
    .map(([url, init]) => {
      const raw = (init as { body?: unknown }).body;
      return {
        url: String(url),
        headers: new Headers((init as { headers?: ConstructorParameters<typeof Headers>[0] }).headers),
        body: typeof raw === 'string' ? JSON.parse(raw) : raw,
      };
    });
}

const logged: Record<string, unknown>[] = [];

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
  logged.length = 0;
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('DEEPL_API_KEY', '');
});

afterEach(() => {
  resetLoggerFactory();
  vi.unstubAllEnvs();
});

const events = (name: string) => logged.filter((line) => line.event === name);

describe('OpenAITranslationProvider', () => {
  it('throws a TranslationProviderError carrying the status when the call fails, and never returns the input', async () => {
    serve({ '/chat/completions': () => jsonResponse({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401) });
    const provider = new OpenAITranslationProvider('openai_chat', { apiKey: 'test-openai-key' });
    await provider.initialize();

    const call = provider.translate('Hello, world.', 'en', 'es');

    await expect(call).rejects.toBeInstanceOf(TranslationProviderError);
    await expect(call).rejects.toMatchObject({ code: 'TRANSLATION_REQUEST_FAILED', providerId: 'openai_chat', status: 401 });
    expect(events('language.translation_failed')).toEqual([
      expect.objectContaining({ provider: 'openai', reason: 'request_failed', status: 401 }),
    ]);
  });

  it('throws TRANSLATION_EMPTY_OUTPUT when the model answers with no text', async () => {
    serve({ '/chat/completions': () => jsonResponse(chatCompletion(null)) });
    const provider = new OpenAITranslationProvider('openai_chat', { apiKey: 'test-openai-key' });
    await provider.initialize();

    await expect(provider.translate('Hello, world.', 'en', 'es')).rejects.toMatchObject({
      name: 'TranslationProviderError',
      code: 'TRANSLATION_EMPTY_OUTPUT',
    });
    expect(events('language.translation_failed')).toEqual([
      expect.objectContaining({ provider: 'openai', reason: 'empty_output' }),
    ]);
  });

  it('translates through the provider layer and reports priced usage', async () => {
    serve({ '/chat/completions': () => jsonResponse(chatCompletion('Hola, mundo.')) });
    const provider = new OpenAITranslationProvider('openai_chat', { apiKey: 'test-openai-key' });
    await provider.initialize();

    const res = await provider.translate('Hello, world.', 'en', 'es');

    expect(res.output).toBe('Hola, mundo.');
    expect(res.providerId).toBe('openai_chat');
    const sent = posts();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.model).toBe('gpt-4o-mini');
    expect(JSON.stringify(sent[0].body.messages)).toContain('from en to es');
    // gpt-4o-mini: 1,000 x $0.15 + 500 x $0.60 per 1M tokens.
    const usage = (res.providerMetadata as { usage?: { costUSD?: number } }).usage;
    expect(usage?.costUSD).toBeCloseTo(0.00045, 9);
  });
});

describe('OpenAITranslationProvider endpoint', () => {
  it('sends a call to a legacy full endpoint URL there, never to api.openai.com', async () => {
    serve({ '/chat/completions': () => jsonResponse(chatCompletion('Hola.')) });
    const provider = new OpenAITranslationProvider('openai_chat', { apiKey: 'test-openai-key', endpoint: 'https://proxy.example.test/v1/chat/completions' });
    await provider.initialize();

    await provider.translate('Hello.', 'en', 'es');

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(posts().map((p) => p.url)).toEqual(['https://proxy.example.test/v1/chat/completions']);
    expect(urls.some((url) => url.includes('api.openai.com'))).toBe(false);
  });

  it('refuses at initialize an endpoint that is not a Chat Completions URL', async () => {
    const provider = new OpenAITranslationProvider('openai_chat', { apiKey: 'test-openai-key', endpoint: 'https://proxy.example.test/translate' });

    await expect(provider.initialize()).rejects.toThrow(/endpoint/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a relative endpoint, which would leave no base URL and send the call to api.openai.com', async () => {
    serve({ '/chat/completions': () => jsonResponse(chatCompletion('Hola.')) });
    const provider = new OpenAITranslationProvider('openai_chat', { apiKey: 'test-openai-key', endpoint: '/chat/completions' });

    await expect(provider.initialize()).rejects.toThrow(/endpoint/);
    await expect(provider.translate('Hello.', 'en', 'es')).rejects.toThrow(/endpoint/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('DeepLTranslationProvider', () => {
  it('sends the key in the Authorization header as DeepL-Auth-Key and never as auth_key', async () => {
    serve({ '/v2/translate': () => jsonResponse({ translations: [{ detected_source_language: 'EN', text: 'Hallo, Welt.' }] }) });
    const provider = new DeepLTranslationProvider('deepl', { apiKey: 'test-deepl-key' });
    await provider.initialize();

    const res = await provider.translate('Hello, world.', 'en', 'de');

    expect(res.output).toBe('Hallo, Welt.');
    const sent = posts();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://api.deepl.com/v2/translate');
    expect(sent[0].headers.get('authorization')).toBe('DeepL-Auth-Key test-deepl-key');
    expect(sent[0].url).not.toContain('auth_key');
    expect(JSON.stringify(sent[0].body)).not.toContain('auth_key');
    expect(sent[0].body).toEqual({ text: ['Hello, world.'], source_lang: 'EN', target_lang: 'DE' });
  });

  it('sends a Free API key (suffix :fx) to api-free.deepl.com', async () => {
    serve({ '/v2/translate': () => jsonResponse({ translations: [{ text: 'Hallo.' }] }) });
    const provider = new DeepLTranslationProvider('deepl', { apiKey: 'test-deepl-key:fx' });
    await provider.initialize();

    await provider.translate('Hello.', 'en', 'de');

    expect(posts()[0].url).toBe('https://api-free.deepl.com/v2/translate');
  });

  it('throws a TranslationProviderError carrying the status when DeepL refuses, and never returns the input', async () => {
    serve({ '/v2/translate': () => jsonResponse({ message: 'Forbidden' }, 403) });
    const provider = new DeepLTranslationProvider('deepl', { apiKey: 'test-deepl-key' });
    await provider.initialize();

    const call = provider.translate('Hello, world.', 'en', 'de');

    await expect(call).rejects.toBeInstanceOf(TranslationProviderError);
    await expect(call).rejects.toMatchObject({ code: 'TRANSLATION_REQUEST_FAILED', providerId: 'deepl', status: 403 });
    expect(events('language.translation_failed')).toEqual([
      expect.objectContaining({ provider: 'deepl', reason: 'request_failed', status: 403 }),
    ]);
  });

  it('throws TRANSLATION_EMPTY_OUTPUT when DeepL answers with no translation', async () => {
    serve({ '/v2/translate': () => jsonResponse({ translations: [] }) });
    const provider = new DeepLTranslationProvider('deepl', { apiKey: 'test-deepl-key' });
    await provider.initialize();

    await expect(provider.translate('Hello.', 'en', 'de')).rejects.toMatchObject({ code: 'TRANSLATION_EMPTY_OUTPUT', providerId: 'deepl' });
  });
});

describe('WhisperDetectionProvider', () => {
  it('refuses text detection with LanguageDetectionUnsupportedError and makes no call', async () => {
    const provider = new WhisperDetectionProvider('whisper_stub', { apiKey: 'test-openai-key' });
    await provider.initialize();

    await expect(provider.detect('Hola, ¿cómo estás?')).rejects.toBeInstanceOf(LanguageDetectionUnsupportedError);
    await expect(provider.detect('Hola, ¿cómo estás?')).rejects.toMatchObject({ code: 'LANGUAGE_DETECTION_UNSUPPORTED', providerId: 'whisper_stub' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('LanguageService with the providers', () => {
  const base = { defaultLanguage: 'en', supportedLanguages: ['en', 'es', 'de'] };

  it('rejects with the provider error when the OpenAI call fails, instead of showing the original as a translation', async () => {
    serve({ '/chat/completions': () => jsonResponse({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }, 401) });
    const svc = new LanguageService({ ...base, translationProviderConfigs: [{ id: 'openai_chat', params: { apiKey: 'test-openai-key' } }] });
    await svc.initialize();

    await expect(svc.maybeTranslateForDisplay('Hello, world.', 'en', 'es')).rejects.toMatchObject({
      name: 'TranslationProviderError',
      providerId: 'openai_chat',
      status: 401,
    });
  });

  it('passes the provider metadata, priced usage included, through to the caller', async () => {
    serve({ '/chat/completions': () => jsonResponse(chatCompletion('Hola, mundo.')) });
    const svc = new LanguageService({ ...base, translationProviderConfigs: [{ id: 'openai_chat', params: { apiKey: 'test-openai-key' } }] });
    await svc.initialize();

    const res = await svc.maybeTranslateForDisplay('Hello, world.', 'en', 'es');

    expect(res?.output).toBe('Hola, mundo.');
    expect((res?.providerMetadata as { usage?: { costUSD?: number } } | undefined)?.usage?.costUSD).toBeCloseTo(0.00045, 9);
  });

  it('sends a configured DeepL key in the Authorization header', async () => {
    serve({ '/v2/translate': () => jsonResponse({ translations: [{ text: 'Hallo, Welt.' }] }) });
    const svc = new LanguageService({ ...base, translationProviderConfigs: [{ id: 'deepl', params: { apiKey: 'test-deepl-key' } }] });
    await svc.initialize();

    const res = await svc.maybeTranslateForDisplay('Hello, world.', 'en', 'de');

    expect(res?.output).toBe('Hallo, Welt.');
    expect(posts()[0].headers.get('authorization')).toBe('DeepL-Auth-Key test-deepl-key');
  });

  it('keeps the Whisper detector out of detection and says so in one line', async () => {
    const svc = new LanguageService({ ...base, autoDetect: true, detectionProviderConfigs: [{ id: 'whisper_stub' }] });
    await svc.initialize();

    const detected = await svc.detectLanguages('the cat and the dog');

    expect(detected.map((d) => d.code)).toContain('en');
    expect(events('language.detector_unsupported')).toEqual([expect.objectContaining({ detector: 'whisper_stub' })]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
