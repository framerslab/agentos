/**
 * @file ClaudeCodeProvider.generateText-default-model.test.ts
 * A provider-only `generateText({ provider: 'claude-code-cli', ... })` runs
 * the CLI on the provider's default model: the real model resolution, the
 * real provider manager, the real ClaudeCodeProvider and the real
 * ClaudeCodeCLIBridge run, and only the subprocess (`execa`) is stubbed, so
 * no CLI runs. The test reads the arguments the bridge launched `claude`
 * with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));

vi.mock('execa', () => ({
  execa: execaMock,
}));

import { generateText } from '../../../../api/generateText.js';

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
