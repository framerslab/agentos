/**
 * @fileoverview The two CLI providers on their real bridges, with the
 * subprocess stubbed where the bridges spawn it (execa). A failed run is
 * stubbed with the fields execa 10 sets on its error (lib/return/result.js):
 * `failed`, `timedOut`, `isCanceled`, `isTerminated` (a signal ended the
 * process), `exitCode`, `signal` and `stderr`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

import type { IProvider } from '../IProvider';
import { ClaudeCodeProvider } from '../implementations/ClaudeCodeProvider';
import { GeminiCLIProvider } from '../implementations/GeminiCLIProvider';
import { isRetryableError } from '../../../../api/generateText';

/** The fields of an execa 10 failure that the bridges read. */
interface ExecaFailure {
  exitCode?: number;
  signal?: string;
  stderr?: string;
  timedOut?: boolean;
  isCanceled?: boolean;
}

/** An error shaped as execa 10 rejects with when a run fails. */
function execaError({ exitCode, signal, stderr = '', timedOut = false, isCanceled = false }: ExecaFailure): Error {
  const message = isCanceled
    ? 'Command was canceled'
    : signal !== undefined
      ? `Command was killed with ${signal}`
      : `Command failed with exit code ${exitCode}`;
  return Object.assign(new Error(message), {
    failed: true,
    timedOut,
    isCanceled,
    isTerminated: signal !== undefined,
    exitCode,
    signal,
    stderr,
  });
}

/**
 * Answers the checks a provider's `initialize()` runs (`which`, `--version`
 * and the `pong` ping) and hands every other spawn to `run`.
 */
function stubCli(binary: string, run: (args: string[], options: Record<string, any>) => unknown): void {
  execaMock.mockImplementation((command: string, args: string[] = [], options: Record<string, any> = {}) => {
    if (command === 'which') return Promise.resolve({ stdout: `/usr/local/bin/${binary}\n` });
    if (args[0] === '--version') return Promise.resolve({ stdout: `${binary} 2.0.0\n` });
    if (options.input === 'Reply with exactly: pong') return Promise.resolve({ stdout: '{"result":"pong"}' });
    return run(args, options);
  });
}

const PROVIDERS: Array<{ name: string; binary: string; model: string; create: () => IProvider }> = [
  { name: 'ClaudeCodeProvider', binary: 'claude', model: 'claude-sonnet-4-6', create: () => new ClaudeCodeProvider() },
  { name: 'GeminiCLIProvider', binary: 'gemini', model: 'gemini-3.5-flash', create: () => new GeminiCLIProvider() },
];

const HELLO = [{ role: 'user' as const, content: 'Hello' }];

beforeEach(() => {
  execaMock.mockReset();
});

describe.each(PROVIDERS)('$name: a failed run, as the bridge classifies it', ({ binary, model, create }) => {
  it.each([
    ['Authentication failed: run the login again', 'NOT_AUTHENTICATED'],
    ['Error: Rate Limit exceeded, try again later', 'RATE_LIMITED'],
    ['Prompt is too long for the Context window', 'CONTEXT_TOO_LONG'],
  ])('reads stderr without regard to case: %s', async (stderr, code) => {
    stubCli(binary, () => Promise.reject(execaError({ exitCode: 1, stderr })));
    const provider = create();
    await provider.initialize({});

    await expect(provider.generateCompletion(model, HELLO, {})).rejects.toMatchObject({ code });
  });

  it('reports a call cancelled through abortSignal as REQUEST_ABORTED, which no fallback retries', async () => {
    let spawned!: () => void;
    const running = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    // As execa does with `cancelSignal`: the abort kills the process (SIGTERM)
    // and the run rejects with `isCanceled` and `isTerminated` set.
    stubCli(binary, (_args, options) => {
      spawned();
      return new Promise((_resolve, reject) => {
        const signal = options.cancelSignal as AbortSignal;
        signal.addEventListener('abort', () => reject(execaError({ isCanceled: true, signal: 'SIGTERM' })), {
          once: true,
        });
      });
    });
    const provider = create();
    await provider.initialize({});
    const controller = new AbortController();

    const call = provider.generateCompletion(model, HELLO, { abortSignal: controller.signal });
    await running;
    controller.abort();
    const error = await call.then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toMatchObject({ code: 'REQUEST_ABORTED', recoverable: false });
    expect(isRetryableError(error)).toBe(false);
  });
});
