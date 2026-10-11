import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execaMock } = vi.hoisted(() => {
  const execaMock = vi.fn();
  return { execaMock };
});

vi.mock('execa', () => ({
  execa: execaMock,
}));

import { CLISubprocessBridge } from '../CLISubprocessBridge';
import { CLISubprocessError } from '../errors';
import type { BridgeOptions, BridgeResult, StreamEvent, OutputFormat } from '../types';

/**
 * Concrete test subclass that implements the abstract methods.
 * Simulates a minimal CLI bridge for testing the base class behavior.
 */
class TestBridge extends CLISubprocessBridge {
  protected readonly binaryName = 'test-cli';

  protected buildArgs(options: BridgeOptions, format: OutputFormat): string[] {
    const args = ['-p', '--format', format];
    if (options.model) args.push('--model', options.model);
    if (options.systemPrompt) args.push('--sys', options.systemPrompt);
    return args;
  }

  protected classifyError(error: any): CLISubprocessError {
    const stderr = error.stderr ?? '';
    if (error.code === 'ENOENT') {
      return new CLISubprocessError('Not found', 'BINARY_NOT_FOUND', 'test-cli', 'Install it', false);
    }
    if (error.timedOut) {
      return new CLISubprocessError('Timed out', 'TIMEOUT', 'test-cli', 'Try again', true);
    }
    return new CLISubprocessError(`Crashed: ${stderr}`, 'CRASHED', 'test-cli', 'Check logs', true);
  }

  protected parseStreamEvent(raw: any): StreamEvent | null {
    if (raw.type === 'delta') return { type: 'text_delta', text: raw.text };
    if (raw.type === 'done') return { type: 'result', result: raw.result };
    return null;
  }
}

/**
 * A bridge for a CLI whose JSON result has a shape of its own, which
 * overrides parseJsonResult() as its JSDoc invites and reads stdout with a
 * plain JSON.parse: stdout that is not JSON makes it throw.
 */
class StrictJsonBridge extends TestBridge {
  protected parseJsonResult(stdout: string, durationMs: number): BridgeResult {
    const parsed = JSON.parse(stdout);
    return { result: parsed.output, isError: parsed.status === 'error', durationMs };
  }
}

/**
 * The error execa 10.0.1 rejects with when a run exits non-zero
 * (getErrorProperties in lib/return/result.js; the message starts with the
 * prefix of getErrorPrefix in lib/return/message.js, then the command, stderr
 * and stdout).
 */
function exitFailure(exitCode: number, stdout: string, stderr: string): Error {
  const shortMessage = `Command failed with exit code ${exitCode}: test-cli -p --format json`;
  return Object.assign(new Error([shortMessage, stderr, stdout].join('\n\n')), {
    shortMessage,
    command: 'test-cli -p --format json',
    escapedCommand: 'test-cli -p --format json',
    failed: true,
    timedOut: false,
    isCanceled: false,
    isGracefullyCanceled: false,
    isTerminated: false,
    isMaxBuffer: false,
    isForcefullyTerminated: false,
    exitCode,
    stdout,
    stderr,
  });
}

describe('CLISubprocessBridge', () => {
  let bridge: TestBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new TestBridge();
  });

  describe('checkBinaryInstalled()', () => {
    it('returns installed with path and version when binary exists', async () => {
      execaMock
        .mockResolvedValueOnce({ stdout: '/usr/bin/test-cli\n' })
        .mockResolvedValueOnce({ stdout: 'test-cli version 2.3.1\n' });

      const result = await bridge.checkBinaryInstalled();
      expect(result).toEqual({
        installed: true,
        binaryPath: '/usr/bin/test-cli',
        version: '2.3.1',
      });

      expect(execaMock).toHaveBeenCalledWith('which', ['test-cli']);
      expect(execaMock).toHaveBeenCalledWith('test-cli', ['--version']);
    });

    it('returns installed: false when binary not on PATH', async () => {
      execaMock.mockRejectedValueOnce(new Error('not found'));
      const result = await bridge.checkBinaryInstalled();
      expect(result).toEqual({ installed: false });
    });
  });

  describe('checkAuthenticated()', () => {
    it('returns true on successful ping', async () => {
      execaMock.mockResolvedValueOnce({ stdout: '{"result":"pong"}', exitCode: 0 });
      expect(await bridge.checkAuthenticated()).toBe(true);
    });

    it('returns false on failed ping', async () => {
      execaMock.mockRejectedValueOnce(new Error('auth failed'));
      expect(await bridge.checkAuthenticated()).toBe(false);
    });
  });

  describe('execute()', () => {
    it('spawns binary with buildArgs and parses JSON result', async () => {
      execaMock.mockResolvedValueOnce({
        stdout: JSON.stringify({ result: 'Hello', session_id: 's1', usage: { input_tokens: 5, output_tokens: 3 } }),
        exitCode: 0,
      });

      const result = await bridge.execute({ prompt: 'Hi', model: 'test-model' });

      expect(execaMock).toHaveBeenCalledOnce();
      const [cmd, args, opts] = execaMock.mock.calls[0];
      expect(cmd).toBe('test-cli');
      expect(args).toContain('-p');
      expect(args).toContain('--format');
      expect(args).toContain('json');
      expect(args).toContain('--model');
      expect(args).toContain('test-model');
      expect(opts.input).toBe('Hi');

      expect(result.result).toBe('Hello');
      expect(result.sessionId).toBe('s1');
      expect(result.usage).toEqual({ input_tokens: 5, output_tokens: 3 });
      expect(result.isError).toBe(false);
    });

    it('falls back to raw text when stdout is not valid JSON', async () => {
      execaMock.mockResolvedValueOnce({ stdout: 'plain text response', exitCode: 0 });

      const result = await bridge.execute({ prompt: 'Hi' });
      expect(result.result).toBe('plain text response');
      expect(result.isError).toBe(false);
    });

    it('throws classified error on subprocess failure', async () => {
      execaMock.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'ENOENT', stderr: '' }));

      try {
        await bridge.execute({ prompt: 'test' });
        expect.fail('should throw');
      } catch (err: any) {
        expect(err).toBeInstanceOf(CLISubprocessError);
        expect(err.code).toBe('BINARY_NOT_FOUND');
        expect(err.binaryName).toBe('test-cli');
        expect(err.recoverable).toBe(false);
      }
    });

    it('throws timeout error on timed-out process', async () => {
      execaMock.mockRejectedValueOnce(Object.assign(new Error('timed out'), { timedOut: true, stderr: '' }));

      try {
        await bridge.execute({ prompt: 'test' });
        expect.fail('should throw');
      } catch (err: any) {
        expect(err.code).toBe('TIMEOUT');
        expect(err.recoverable).toBe(true);
      }
    });

    it('classifies a failed run with classifyError() when a parseJsonResult() override throws on its stdout', async () => {
      // The CLI wrote its failure as text, not as its JSON result, and exited 1.
      execaMock.mockRejectedValueOnce(exitFailure(1, 'Error: could not reach the server', 'connect ECONNREFUSED 127.0.0.1:443'));

      const error = await new StrictJsonBridge().execute({ prompt: 'test' }).then(
        () => undefined,
        (failure: unknown) => failure,
      );

      expect(error).toBeInstanceOf(CLISubprocessError);
      expect(error).toMatchObject({ code: 'CRASHED', message: 'Crashed: connect ECONNREFUSED 127.0.0.1:443' });
    });

    it('respects custom timeout option', async () => {
      execaMock.mockResolvedValueOnce({ stdout: '{"result":"ok"}', exitCode: 0 });

      await bridge.execute({ prompt: 'test', timeout: 5000 });

      const [, , opts] = execaMock.mock.calls[0];
      expect(opts.timeout).toBe(5000);
    });
  });

  describe('stream()', () => {
    it('yields parsed StreamEvents from NDJSON output', async () => {
      const lines = [
        JSON.stringify({ type: 'delta', text: 'Hello' }),
        JSON.stringify({ type: 'delta', text: ' world' }),
        JSON.stringify({ type: 'done', result: 'Hello world' }),
      ];

      const mockStdout = (async function* () {
        for (const line of lines) {
          yield Buffer.from(line + '\n');
        }
      })();

      execaMock.mockReturnValueOnce({
        stdout: mockStdout,
        exitCode: Promise.resolve(0),
        kill: vi.fn(),
      });

      const events: StreamEvent[] = [];
      for await (const event of bridge.stream({ prompt: 'Hello' })) {
        events.push(event);
      }

      expect(events).toHaveLength(3);
      expect(events[0]).toEqual({ type: 'text_delta', text: 'Hello' });
      expect(events[1]).toEqual({ type: 'text_delta', text: ' world' });
      expect(events[2]).toEqual({ type: 'result', result: 'Hello world' });
    });

    it('skips null events from parseStreamEvent', async () => {
      const lines = [
        JSON.stringify({ type: 'delta', text: 'Hi' }),
        JSON.stringify({ type: 'unknown_event', data: 'skip me' }),
        JSON.stringify({ type: 'done', result: 'Hi' }),
      ];

      const mockStdout = (async function* () {
        yield Buffer.from(lines.join('\n') + '\n');
      })();

      execaMock.mockReturnValueOnce({
        stdout: mockStdout,
        exitCode: Promise.resolve(0),
        kill: vi.fn(),
      });

      const events: StreamEvent[] = [];
      for await (const event of bridge.stream({ prompt: 'test' })) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
    });

    it('passes stream-json format flag', async () => {
      const mockStdout = (async function* () {
        yield Buffer.from(JSON.stringify({ type: 'done', result: 'ok' }) + '\n');
      })();

      execaMock.mockReturnValueOnce({
        stdout: mockStdout,
        exitCode: Promise.resolve(0),
        kill: vi.fn(),
      });

      const events: StreamEvent[] = [];
      for await (const event of bridge.stream({ prompt: 'test' })) {
        events.push(event);
      }

      const [, args] = execaMock.mock.calls[0];
      expect(args).toContain('stream-json');
    });

    it('throws when the subprocess exits non-zero after stdout completes', async () => {
      const mockStdout = (async function* () {
        yield Buffer.from(JSON.stringify({ type: 'done', result: 'partial output' }) + '\n');
      })();

      const subprocessError = Object.assign(new Error('crashed'), {
        exitCode: 1,
        stderr: 'boom',
      });
      const subprocessPromise = Promise.reject(subprocessError);
      subprocessPromise.catch(() => {});

      execaMock.mockReturnValueOnce(Object.assign(subprocessPromise, {
        stdout: mockStdout,
        kill: vi.fn(),
      }));

      await expect(async () => {
        for await (const _event of bridge.stream({ prompt: 'test' })) {
          /* drain stream until the classified error is raised */
        }
      }).rejects.toBeInstanceOf(CLISubprocessError);
    });
  });
});
