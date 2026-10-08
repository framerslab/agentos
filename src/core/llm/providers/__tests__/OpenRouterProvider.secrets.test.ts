/**
 * @file OpenRouterProvider.secrets.test.ts
 * @description Every OpenRouter request carries the API key in its
 *              Authorization header, and an AxiosError keeps that header in
 *              its config. These tests fail requests through a real axios
 *              instance (only the transport adapter is replaced) and check
 *              that no thrown error, error detail, health report or log line
 *              carries a key, including when the error body is JSON that
 *              quotes the key or a stream whose `req` holds the request head.
 */
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import axios, { AxiosError, type AxiosAdapter, type CreateAxiosDefaults } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider } from '../implementations/OpenRouterProvider';
import type { ChatMessage } from '../IProvider';

const KEY_A = 'sk-or-v1-secret-key-aaaaaaaaaaaa';
const KEY_B = 'sk-or-v1-secret-key-bbbbbbbbbbbb';
const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

/** Everything a logger or a serializer could print for a value. */
function renderings(value: unknown): string {
  let json = '';
  try {
    json = JSON.stringify(value) ?? '';
  } catch {
    // A circular value cannot be serialized; inspect still renders it.
  }
  return `${inspect(value, { depth: null })}\n${json}`;
}

function expectNoKeys(value: unknown): void {
  const text = renderings(value);
  expect(text).not.toContain(KEY_A);
  expect(text).not.toContain(KEY_B);
}

/** Silences console.error and console.warn and returns their spies. */
function quietConsole() {
  return {
    errorLog: vi.spyOn(console, 'error').mockImplementation(() => {}),
    warnLog: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  };
}

/** The Authorization header of the most recent request. */
function lastAuthorization(sent: string[]): string | undefined {
  return sent[sent.length - 1];
}

/** Routes every request the provider makes through `adapter`, keeping the rest of axios real. */
function useAdapter(adapter: AxiosAdapter): void {
  const create = axios.create.bind(axios);
  vi.spyOn(axios, 'create').mockImplementation((config?: CreateAxiosDefaults) => create({ ...config, adapter }));
}

describe('OpenRouterProvider keeps API keys out of errors and logs', () => {
  const sentAuthorization: string[] = [];

  beforeEach(() => {
    sentAuthorization.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('when initialize() gets a 401, as with a revoked key', async () => {
    const { errorLog } = quietConsole();
    useAdapter(async (config) => {
      sentAuthorization.push(String(config.headers.Authorization));
      throw new AxiosError('Request failed with status code 401', AxiosError.ERR_BAD_REQUEST, config, {}, {
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        config,
        data: { error: { message: 'User not found.', code: 401 } },
      });
    });

    const failure = await new OpenRouterProvider()
      .initialize({ apiKey: `${KEY_A},${KEY_B}` })
      .catch((error: unknown) => error);

    // The request did carry a key, so the checks below are not vacuous.
    expect(sentAuthorization[0]).toMatch(/^Bearer sk-or-v1-secret-key-/);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('[401] User not found.');
    expect(errorLog).toHaveBeenCalled();
    expectNoKeys(failure);
    expectNoKeys(errorLog.mock.calls);
  });

  describe('after initialization', () => {
    let failing = false;
    let jsonBody = false;
    let provider: OpenRouterProvider;

    beforeEach(async () => {
      failing = false;
      jsonBody = false;
      // A proxy in front of OpenRouter that quotes the request's
      // Authorization header back in its error message and body.
      useAdapter(async (config) => {
        const authorization = String(config.headers.Authorization);
        sentAuthorization.push(authorization);
        if (!failing) {
          return { status: 200, statusText: 'OK', headers: {}, config, data: { data: [] } };
        }
        throw new AxiosError(`proxy rejected ${authorization}`, AxiosError.ERR_BAD_REQUEST, config, {}, {
          status: 400,
          statusText: 'Bad Request',
          headers: {},
          config,
          data: jsonBody
            ? { error: { message: `rejected header Authorization: ${authorization}` } }
            : `rejected header Authorization: ${authorization}`,
        });
      });
      provider = new OpenRouterProvider();
      await provider.initialize({ apiKey: `${KEY_A},${KEY_B}` });
      failing = true;
    });

    it('in the error a failed completion throws', async () => {
      const { errorLog, warnLog } = quietConsole();
      const failure = await provider
        .generateCompletion('openai/gpt-4o', messages, {})
        .catch((error: unknown) => error);

      expect(lastAuthorization(sentAuthorization)).toMatch(/^Bearer sk-or-v1-secret-key-/);
      expect((failure as Error).message).toBe('[400] rejected header Authorization: Bearer [redacted]');
      expectNoKeys(failure);
      expectNoKeys(warnLog.mock.calls);
      expectNoKeys(errorLog.mock.calls);
    });

    it('in a failed health check', async () => {
      const health = await provider.checkHealth();

      expect(health.isHealthy).toBe(false);
      expect(lastAuthorization(sentAuthorization)).toMatch(/^Bearer sk-or-v1-secret-key-/);
      expect(renderings(health)).toContain('[redacted]');
      expectNoKeys(health);
    });

    it('in the details when the error body is JSON that quotes the key', async () => {
      jsonBody = true;
      const failure = await provider
        .generateCompletion('openai/gpt-4o', messages, {})
        .catch((error: unknown) => error);
      const health = await provider.checkHealth();

      expect((failure as Error).message).toBe('[400] rejected header Authorization: Bearer [redacted]');
      expect(renderings((failure as { details?: unknown }).details)).toContain('Bearer [redacted]');
      expectNoKeys(failure);
      expectNoKeys(health);
    });
  });

  it('when a streamed completion fails and its body arrives as a stream', async () => {
    const bodies: Readable[] = [];
    // The error body of a `responseType: 'stream'` request is the response
    // stream itself; Node's IncomingMessage keeps the request head in `req`.
    useAdapter(async (config) => {
      const authorization = String(config.headers.Authorization);
      sentAuthorization.push(authorization);
      if (config.url === '/models') {
        return { status: 200, statusText: 'OK', headers: {}, config, data: { data: [] } };
      }
      const body = Object.assign(
        Readable.from([Buffer.from(JSON.stringify({ error: { message: 'Insufficient credits' } }))], {
          objectMode: false,
        }),
        { req: { _header: `POST /api/v1/chat/completions HTTP/1.1\r\nAuthorization: ${authorization}\r\n\r\n` } },
      );
      bodies.push(body);
      throw new AxiosError('Request failed with status code 402', AxiosError.ERR_BAD_REQUEST, config, {}, {
        status: 402,
        statusText: 'Payment Required',
        headers: {},
        config,
        data: body,
      });
    });
    const provider = new OpenRouterProvider();
    await provider.initialize({ apiKey: `${KEY_A},${KEY_B}` });

    const failure = await provider
      .generateCompletionStream('openai/gpt-4o', messages, {})
      .next()
      .catch((error: unknown) => error);

    expect(lastAuthorization(sentAuthorization)).toMatch(/^Bearer sk-or-v1-secret-key-/);
    expect((failure as Error).message).toBe('[402] Insufficient credits');
    expectNoKeys(failure);
    // The stream was read and released, not kept in the error.
    expect(bodies).toHaveLength(1);
    expect(bodies[0].destroyed).toBe(true);
  });

  it('when a streamed error body is cut off in the middle of a key', async () => {
    let cutKey = '';
    useAdapter(async (config) => {
      const authorization = String(config.headers.Authorization);
      sentAuthorization.push(authorization);
      if (config.url === '/models') {
        return { status: 200, statusText: 'OK', headers: {}, config, data: { data: [] } };
      }
      // The key straddles the 8192-byte read limit: all but its last five
      // characters fall inside it.
      cutKey = authorization.slice('Bearer '.length);
      const text = `${'x'.repeat(8192 - cutKey.length + 5)}${cutKey}`;
      throw new AxiosError('Request failed with status code 402', AxiosError.ERR_BAD_REQUEST, config, {}, {
        status: 402,
        statusText: 'Payment Required',
        headers: {},
        config,
        data: Readable.from([Buffer.from(text)], { objectMode: false }),
      });
    });
    const provider = new OpenRouterProvider();
    await provider.initialize({ apiKey: `${KEY_A},${KEY_B}` });

    const failure = await provider
      .generateCompletionStream('openai/gpt-4o', messages, {})
      .next()
      .catch((error: unknown) => error);

    expect(cutKey).toMatch(/^sk-or-v1-secret-key-/);
    expect((failure as Error).message.endsWith('[redacted]')).toBe(true);
    expect(renderings(failure)).not.toContain(cutKey.slice(0, -5));
    expectNoKeys(failure);
  });

  it('when a cut-off streamed error body ends with a whole key that ends with its own first character', async () => {
    // The key ends with "s", which is also its first character. Masked only
    // as a cut-off tail, the final "s" would be taken for the start of a key
    // and the rest of the key would stay readable.
    const key = 'sk-gw-1234s';
    useAdapter(async (config) => {
      if (config.url === '/models') {
        return { status: 200, statusText: 'OK', headers: {}, config, data: { data: [] } };
      }
      const text = `${'x'.repeat(8192 - key.length)}${key}tail`;
      throw new AxiosError('Request failed with status code 402', AxiosError.ERR_BAD_REQUEST, config, {}, {
        status: 402,
        statusText: 'Payment Required',
        headers: {},
        config,
        data: Readable.from([Buffer.from(text)], { objectMode: false }),
      });
    });
    const provider = new OpenRouterProvider();
    await provider.initialize({ apiKey: key });

    const failure = await provider
      .generateCompletionStream('openai/gpt-4o', messages, {})
      .next()
      .catch((error: unknown) => error);

    expect((failure as Error).message.endsWith('[redacted]')).toBe(true);
    expect(renderings(failure)).not.toContain('sk-gw-1234');
  });

  it("keeps the error's own message when a streamed error body is empty", async () => {
    useAdapter(async (config) => {
      if (config.url === '/models') {
        return { status: 200, statusText: 'OK', headers: {}, config, data: { data: [] } };
      }
      throw new AxiosError('Request failed with status code 400', AxiosError.ERR_BAD_REQUEST, config, {}, {
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        config,
        data: Readable.from([], { objectMode: false }),
      });
    });
    const provider = new OpenRouterProvider();
    await provider.initialize({ apiKey: `${KEY_A},${KEY_B}` });

    const failure = await provider
      .generateCompletionStream('openai/gpt-4o', messages, {})
      .next()
      .catch((error: unknown) => error);

    expect((failure as Error).message).toBe('[400] Request failed with status code 400');
    expectNoKeys(failure);
  });
});
