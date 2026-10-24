/**
 * @file providers.spec.ts
 * @description The OpenAI provider's retry path, driven through its real request loop. A rate-limited attempt reaches
 * the host's logger as one `llm.retry` event with the status, the attempt and the scheduled wait, and the provider's
 * error text reaches neither the logger nor a standard stream. The event carries the wait the provider schedules: a
 * `Retry-After` in seconds before the next attempt. The last attempt schedules none, so its error ends the call at
 * once and it writes no retry event.
 */

import { Console } from 'node:console';
import { afterEach, expect, it, vi } from 'vitest';
import pino from 'pino';
import { OpenAIProvider } from '../../src/core/llm/providers/implementations/OpenAIProvider.js';
import { setLogger, resetLoggerFactory } from '../../src/core/logging/loggerFactory.js';

// The test runner's console forwards to its reporter and writes neither standard stream, so a console line would pass
// the stream spies unseen. The first case puts a Node console over the two streams, as a process outside the runner
// has; this puts the runner's back.
const runnerConsole = globalThis.console;
afterEach(() => { globalThis.console = runnerConsole; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); resetLoggerFactory(); });
it('hands a rate-limit retry to the host without text or standard-stream output', async () => {
  const lines: Record<string, unknown>[] = []; const logger = pino({ level: 'debug' }, { write(line: string) { lines.push(JSON.parse(line)); } });
  setLogger(logger);
  const stdout = vi.spyOn(process.stdout, 'write'); const stderr = vi.spyOn(process.stderr, 'write');
  globalThis.console = new Console({ stdout: process.stdout, stderr: process.stderr, colorMode: false });
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'sentinel-words-7731' } }), { status: 429, headers: { 'retry-after': '0' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'reply', object: 'chat.completion', created: 1, model: 'gpt-4o', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })));
  vi.stubGlobal('fetch', fetcher);
  const provider = new OpenAIProvider(); await provider.initialize({ apiKey: 'test-key', maxRetries: 2 });
  await provider.generateCompletion('gpt-4o', [{ role: 'user', content: 'hello' }], {});
  expect(lines.filter(line => line.event === 'llm.retry')).toEqual([expect.objectContaining({ provider: 'openai', status: 429, attempt: 1, waitMs: 0 })]);
  expect(JSON.stringify(lines)).not.toContain('sentinel-words-7731');
  expect(stdout).not.toHaveBeenCalled(); expect(stderr).not.toHaveBeenCalled();
});
it.each([['61', 61_000], ['1', 1_000]] as const)('waits out Retry-After %s before the next attempt and none after the last', async (header, delay) => {
  vi.useFakeTimers();
  const lines: Record<string, unknown>[] = [];
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { lines.push(JSON.parse(line)); } }));
  const limited = () => new Response(JSON.stringify({ error: { message: 'sentinel-words-7731' } }), { status: 429, headers: { 'retry-after': header } });
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })))
    .mockResolvedValueOnce(limited())
    .mockResolvedValueOnce(limited());
  vi.stubGlobal('fetch', fetcher);
  const provider = new OpenAIProvider(); await provider.initialize({ apiKey: 'test-key', maxRetries: 2 });
  let done = false;
  const result = provider.generateCompletion('gpt-4o', [{ role: 'user', content: 'hello' }], {}).then(
    () => { done = true; return 'resolved'; },
    () => { done = true; return 'rejected'; },
  );
  await vi.advanceTimersByTimeAsync(delay - 1); expect(done).toBe(false); expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); expect(await result).toBe('rejected');
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(lines.filter(line => line.event === 'llm.retry')).toEqual([
    expect.objectContaining({ provider: 'openai', status: 429, attempt: 1, waitMs: delay }),
  ]);
  expect(JSON.stringify(lines)).not.toContain('sentinel-words-7731');
});
