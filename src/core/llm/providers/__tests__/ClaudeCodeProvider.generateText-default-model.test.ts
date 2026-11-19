/**
 * @file ClaudeCodeProvider.generateText-default-model.test.ts
 * A provider-only `generateText({ provider: 'claude-code-cli', ... })` runs
 * the CLI on the provider's default model: the real model resolution, the
 * real provider manager, the real ClaudeCodeProvider and the real
 * ClaudeCodeCLIBridge run, and only the subprocess (`execa`) is stubbed, so
 * no CLI runs. The test reads the arguments the bridge launched `claude`
 * with. A run that times out is read from the real bridge too: the advice it
 * gives names the smaller default model and the Claude Code it needs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));

vi.mock('execa', () => ({
  execa: execaMock,
}));

import { generateText } from '../../../../api/generateText.js';
import { ClaudeCodeCLIBridge } from '../implementations/ClaudeCodeCLIBridge.js';
import { ClaudeCodeProviderError } from '../errors/ClaudeCodeProviderError.js';

/** The stdin of the bridge's login check (buildAuthCheckArgs in ClaudeCodeCLIBridge). */
const AUTH_PING = 'Reply with exactly: pong';

type ExecaCall = [file: string, args?: string[], options?: { input?: string }];

/** The runs of `claude` that carry a prompt: every launch but the install and login checks. */
function promptRuns(): Array<{ args: string[]; input?: string }> {
  return (execaMock.mock.calls as ExecaCall[])
    .filter(([file, args, options]) => file === 'claude' && !(args ?? []).includes('--version') && options?.input !== AUTH_PING)
    .map(([, args, options]) => ({ args: args ?? [], input: options?.input }));
}

beforeEach(() => {
  execaMock.mockReset();
  execaMock.mockImplementation(async (file: string, args: string[] = [], options: { input?: string } = {}) => {
    if (file === 'which') return { stdout: '/usr/local/bin/claude\n' };
    if (args.includes('--version')) return { stdout: '2.1.0 (Claude Code)\n' };
    if (options.input === AUTH_PING) {
      return { stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'pong' }) };
    }
    return {
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Hello!',
        session_id: 'session-1',
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
    };
  });
});

afterEach(() => {
  execaMock.mockReset();
});

describe('generateText on claude-code-cli with no model', () => {
  it('launches the bridge with --model claude-sonnet-5-5', async () => {
    const result = await generateText({ provider: 'claude-code-cli', prompt: 'Say hello.' });

    expect(result.text).toBe('Hello!');
    const runs = promptRuns();
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run.args.slice(0, 2)).toEqual(['--bare', '-p']);
    const modelFlag = run.args.indexOf('--model');
    expect(modelFlag).toBeGreaterThan(-1);
    expect(run.args[modelFlag + 1]).toBe('claude-sonnet-5-5');
    expect(run.input).toContain('Say hello.');
  });
});

describe('a Claude Code run that times out', () => {
  it('advises claude-haiku-5-5 with the Claude Code version it needs and `claude update`', async () => {
    // Claude Haiku 5.5 needs Claude Code 2.1.293 or later, and Claude Sonnet 5.5 runs from 2.1.284
    // (code.claude.com/docs/en/model-config, read 2026-11-19): a CLI that times out on the default can refuse Haiku 5.5.
    execaMock.mockImplementation(async () => {
      throw Object.assign(new Error('Command timed out after 120000 milliseconds'), { timedOut: true, stderr: '' });
    });

    const error = await new ClaudeCodeCLIBridge()
      .execute({ prompt: 'Say hello.', model: 'claude-sonnet-5-5' })
      .then(() => undefined, (e: unknown) => e);

    expect(error).toBeInstanceOf(ClaudeCodeProviderError);
    const { code, guidance } = error as ClaudeCodeProviderError;
    expect(code).toBe('TIMEOUT');
    expect(guidance).toContain('claude-haiku-5-5');
    expect(guidance).toContain('2.1.293 or later');
    expect(guidance).toContain('`claude update`');
  });
});
