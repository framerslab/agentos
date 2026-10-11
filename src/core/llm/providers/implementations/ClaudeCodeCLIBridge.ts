/**
 * @fileoverview Claude Code CLI bridge — extends the generalized
 * {@link CLISubprocessBridge} with Claude-specific flag assembly,
 * error classification, and stream event parsing.
 *
 * This class only contains what's specific to the `claude` binary.
 * All subprocess lifecycle (spawn, pipe, NDJSON parse, timeout) is
 * handled by the base class.
 *
 * @module agentos/core/llm/providers/implementations/ClaudeCodeCLIBridge
 * @see CLISubprocessBridge
 * @see ClaudeCodeProvider
 */

import { CLISubprocessBridge } from '../../../../safety/sandbox/subprocess/CLISubprocessBridge';
import { ClaudeCodeProviderError } from '../errors/ClaudeCodeProviderError';
import type { BridgeOptions, StreamEvent, OutputFormat } from '../../../../safety/sandbox/subprocess/types';

/* Re-export shared types for backwards compatibility with ClaudeCodeProvider imports */
export type { BridgeOptions as CLIBridgeOptions, BridgeResult as CLIBridgeResult, StreamEvent } from '../../../../safety/sandbox/subprocess/types';
export type { InstallCheckResult } from '../../../../safety/sandbox/subprocess/types';

/**
 * Claude Code CLI subprocess bridge.
 *
 * Extends {@link CLISubprocessBridge} to implement:
 * - Flag assembly: `--bare`, `-p`, `--system-prompt`, `--json-schema`, `--max-turns`
 * - Error classification: caller abort, timeout, auth, rate-limit, context length, ENOENT, EACCES
 * - Stream event parsing: `content_block_delta`, `result`, `error`, `system` events
 * - Auth check: uses `--bare --max-turns 1` for lightweight health ping
 */
export class ClaudeCodeCLIBridge extends CLISubprocessBridge {
  protected readonly binaryName = 'claude';

  /* ---- Flag assembly -------------------------------------------- */

  protected buildArgs(options: BridgeOptions, format: OutputFormat): string[] {
    const args: string[] = [
      '--bare',
      '-p',
      '--output-format', format,
      '--max-turns', String(options.maxTurns ?? 1),
    ];

    if (format === 'stream-json') {
      args.push('--verbose', '--include-partial-messages');
    }

    if (options.systemPrompt) {
      args.push('--system-prompt', options.systemPrompt);
    }

    if (options.model) {
      args.push('--model', options.model);
    }

    if (options.jsonSchema) {
      args.push('--json-schema', JSON.stringify(options.jsonSchema));
    }

    if (options.extraArgs) {
      args.push(...options.extraArgs);
    }

    return args;
  }

  /* ---- Auth check override -------------------------------------- */

  protected buildAuthCheckArgs(): { args: string[]; stdin: string } {
    return {
      args: ['--bare', '-p', '--output-format', 'json', '--max-turns', '1'],
      stdin: 'Reply with exactly: pong',
    };
  }

  /* ---- Stream event parsing ------------------------------------- */

  protected parseStreamEvent(raw: any): StreamEvent | null {
    if (!raw || typeof raw !== 'object') return null;

    /* Text delta from content block */
    if (raw.type === 'content_block_delta' && raw.delta?.type === 'text_delta') {
      return { type: 'text_delta', text: raw.delta.text };
    }

    /* Assistant message with text content */
    if (raw.type === 'assistant' && typeof raw.message?.content === 'string') {
      return { type: 'text_delta', text: raw.message.content };
    }

    /* Final result. Claude Code flags a failed turn (an API error, the turn
     * limit) with is_error; its result text, or its subtype when it has no
     * text, is then the failure's message. */
    if (raw.type === 'result') {
      const isError = raw.is_error === true;
      return {
        type: 'result',
        result: isError ? raw.result || raw.subtype || 'Unknown error' : raw.result ?? '',
        sessionId: raw.session_id,
        usage: raw.usage
          ? { input_tokens: raw.usage.input_tokens ?? 0, output_tokens: raw.usage.output_tokens ?? 0 }
          : undefined,
        ...(isError ? { isError: true } : {}),
      };
    }

    /* Error event */
    if (raw.type === 'error') {
      return { type: 'error', error: raw.error?.message ?? raw.message ?? 'Unknown error' };
    }

    /* System events (api_retry, progress, etc.) */
    if (raw.type === 'system' || raw.type === 'system/api_retry') {
      return { type: 'system', message: raw.message ?? JSON.stringify(raw) };
    }

    return null;
  }

  /* ---- Error classification ------------------------------------- */

  protected classifyError(error: any): ClaudeCodeProviderError {
    const stderr: string = error.stderr ?? '';
    /* The CLI's wording varies in case ("Authentication failed"), so stderr is matched lowercased. */
    const text = String(stderr).toLowerCase();
    const exitCode = error.exitCode;

    /* Cancelled by the caller. execa sets isCanceled when the abortSignal it
     * was given as cancelSignal fires; the signal that then ends the process
     * sets isTerminated too, so this is checked before the timeout. */
    if (error.isCanceled) {
      return new ClaudeCodeProviderError(
        'Claude Code CLI call aborted by the caller.',
        'REQUEST_ABORTED',
        'The call was cancelled through its abort signal. Send it again if it is still needed.',
        false,
        { exitCode, stderr },
      );
    }

    /* Timeout */
    if (error.timedOut || error.isTerminated) {
      return new ClaudeCodeProviderError(
        `Claude Code CLI timed out.`,
        'TIMEOUT',
        'Claude Code did not respond in time. Try again or use a smaller model (claude-haiku-4-5-20251001).',
        true,
        { exitCode, stderr },
      );
    }

    /* Auth errors */
    if (text.includes('not logged in') || text.includes('authentication') || text.includes('unauthorized')) {
      return new ClaudeCodeProviderError(
        'Claude Code is installed but not logged in.',
        'NOT_AUTHENTICATED',
        'Run "claude" in your terminal and complete the login flow, then try again.',
        false,
        { exitCode, stderr },
      );
    }

    /* Rate limit */
    if (text.includes('rate limit') || text.includes('too many requests') || text.includes('429')) {
      return new ClaudeCodeProviderError(
        'Claude Code subscription rate limit reached.',
        'RATE_LIMITED',
        'Wait a few minutes and try again. Check your Max plan limits at https://claude.ai/pricing',
        true,
        { exitCode, stderr },
      );
    }

    /* Context too long */
    if (text.includes('context') && (text.includes('too long') || text.includes('token limit'))) {
      return new ClaudeCodeProviderError(
        'Conversation exceeds model context window.',
        'CONTEXT_TOO_LONG',
        'Start a new conversation or switch to a model with a larger context window.',
        false,
        { exitCode, stderr },
      );
    }

    /* Spawn failure (ENOENT = binary not found in this context) */
    if (error.code === 'ENOENT') {
      return new ClaudeCodeProviderError(
        'Claude Code CLI not found.',
        'BINARY_NOT_FOUND',
        'Install Claude Code: npm install -g @anthropic-ai/claude-code — or download from https://claude.ai/download',
        false,
        { exitCode, stderr },
      );
    }

    /* Permission error */
    if (error.code === 'EACCES') {
      return new ClaudeCodeProviderError(
        'Failed to start Claude Code process due to permissions.',
        'SPAWN_FAILED',
        `Check file permissions on the claude binary.`,
        false,
        { exitCode, stderr },
      );
    }

    /* Generic crash */
    const stderrSnippet = stderr.length > 500 ? stderr.slice(-500) : stderr;
    return new ClaudeCodeProviderError(
      `Claude Code CLI exited unexpectedly (code ${exitCode ?? 'unknown'}).`,
      'CRASHED',
      `Try running "claude --bare -p test" manually to diagnose. stderr: ${stderrSnippet}`,
      true,
      { exitCode, stderr },
    );
  }
}
