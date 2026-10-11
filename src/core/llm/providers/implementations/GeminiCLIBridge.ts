/**
 * @fileoverview Gemini CLI bridge — extends the generalized
 * {@link CLISubprocessBridge} with Gemini-specific flag assembly,
 * error classification, stream event parsing, and temp-file system prompts.
 *
 * Key differences from Claude Code:
 * - No `--system-prompt` flag → uses temp file + `GEMINI_SYSTEM_MD` env var
 * - No `--json-schema` flag → tool calling handled at provider level via XML prompts
 * - No `--bare` or `--max-turns` flags
 * - Uses `-p` (same as Claude's `-p`) and `--output-format json|stream-json`
 *
 * @module agentos/core/llm/providers/implementations/GeminiCLIBridge
 * @see CLISubprocessBridge
 * @see GeminiCLIProvider
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CLISubprocessBridge } from '../../../../safety/sandbox/subprocess/CLISubprocessBridge';
import { GeminiCLIProviderError } from '../errors/GeminiCLIProviderError';
import type {
  BridgeOptions,
  BridgeResult,
  StreamEvent,
  StreamParseContext,
  OutputFormat,
} from '../../../../safety/sandbox/subprocess/types';

/* Re-export shared types for provider imports */
export type { BridgeOptions, BridgeResult, StreamEvent } from '../../../../safety/sandbox/subprocess/types';
export type { InstallCheckResult } from '../../../../safety/sandbox/subprocess/types';

/**
 * Gemini CLI subprocess bridge.
 *
 * Extends {@link CLISubprocessBridge} to implement:
 * - Flag assembly: `-p`, `--output-format`, `-m`
 * - System prompt via temp file + `GEMINI_SYSTEM_MD` env var
 * - Error classification: caller abort, timeout, auth, rate-limit and quota errors
 * - Stream event parsing: Gemini's stream-json format
 */
export class GeminiCLIBridge extends CLISubprocessBridge {
  protected readonly binaryName = 'gemini';

  /* ---- Flag assembly -------------------------------------------- */

  protected buildArgs(options: BridgeOptions, format: OutputFormat): string[] {
    const args: string[] = [
      '-p',
      '--output-format', format,
    ];

    if (options.model) {
      args.push('-m', options.model);
    }

    if (options.extraArgs) {
      args.push(...options.extraArgs);
    }

    return args;
  }

  /* ---- Auth check ----------------------------------------------- */

  protected buildAuthCheckArgs(): { args: string[]; stdin: string } {
    return {
      args: ['-p', '--output-format', 'json'],
      stdin: 'Reply with exactly: pong',
    };
  }

  /* ---- System prompt via temp file ------------------------------ */

  /**
   * Execute with a system prompt injected via a temporary file.
   * Writes the system prompt to a temp .md file, sets `GEMINI_SYSTEM_MD`
   * in the subprocess env, runs the command, and cleans up.
   *
   * @param options — bridge options (systemPrompt will be written to temp file)
   * @returns bridge result
   */
  async executeWithSystemPrompt(options: BridgeOptions): Promise<BridgeResult> {
    if (!options.systemPrompt) {
      return this.execute(options);
    }

    return this.withSystemPromptFile(options.systemPrompt, async (env) => {
      return this.execute({ ...options, env: { ...options.env, ...env } });
    });
  }

  /**
   * Stream with a system prompt injected via a temporary file.
   *
   * @param options — bridge options (systemPrompt will be written to temp file)
   * @yields stream events
   */
  async *streamWithSystemPrompt(options: BridgeOptions): AsyncGenerator<StreamEvent, void, undefined> {
    if (!options.systemPrompt) {
      yield* this.stream(options);
      return;
    }

    const tmpFile = path.join(os.tmpdir(), `agentos-gemini-sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
    try {
      await fs.writeFile(tmpFile, options.systemPrompt, 'utf8');
      const env = { ...options.env, GEMINI_SYSTEM_MD: tmpFile };
      yield* this.stream({ ...options, env });
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  /**
   * Helper: write system prompt to temp file, run callback with env, clean up.
   */
  private async withSystemPromptFile<T>(
    systemPrompt: string,
    fn: (env: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    const tmpFile = path.join(os.tmpdir(), `agentos-gemini-sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
    try {
      await fs.writeFile(tmpFile, systemPrompt, 'utf8');
      return await fn({ GEMINI_SYSTEM_MD: tmpFile });
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  /* ---- Stream event parsing ------------------------------------- */

  protected parseStreamEvent(raw: any, context?: StreamParseContext): StreamEvent | null {
    if (!raw || typeof raw !== 'object') return null;

    /* The init event that opens the stream, { type: 'init', session_id,
     * model } (InitEvent in packages/core/src/output/types.ts in
     * google-gemini/gemini-cli), is the only line with the session's id: the
     * result event has no such field (ResultEvent). The id is kept for the
     * result. */
    if (raw.type === 'init') {
      if (context && typeof raw.session_id === 'string') context.sessionId = raw.session_id;
      return null;
    }

    /* Reply text as the Gemini CLI writes it: a message event for each piece,
     * { type: 'message', role: 'assistant', content, delta: true }
     * (packages/cli/src/nonInteractiveCli.ts in google-gemini/gemini-cli).
     * The CLI also echoes the prompt as a message with role 'user', which is
     * not reply text. */
    if (raw.type === 'message') {
      return raw.role === 'assistant' && typeof raw.content === 'string'
        ? { type: 'text_delta', text: raw.content }
        : null;
    }

    /* Text delta */
    if (raw.type === 'content_block_delta' && raw.delta?.type === 'text_delta') {
      return { type: 'text_delta', text: raw.delta.text };
    }

    /* Text content in message */
    if (raw.type === 'assistant' && typeof raw.message?.content === 'string') {
      return { type: 'text_delta', text: raw.message.content };
    }

    /* Gemini may emit text directly in some stream-json variants */
    if (raw.type === 'text' && typeof raw.text === 'string') {
      return { type: 'text_delta', text: raw.text };
    }

    /* Final result. The CLI's result carries no text of its own (the reply
     * came as message events) and its token counts in `stats`. The CLI
     * reports a failure as a result with status 'error' and an `error` object
     * ({ type, message }), then exits non-zero; an `is_error` flag is read as
     * well. `result` stays the result text, '' when there is none, as the
     * bridge read it before 0.13.41; the failure's message goes in `error`.
     * The session id is the result line's own when it carries one, and
     * otherwise the one the init event wrote. */
    if (raw.type === 'result') {
      const isError = raw.is_error === true || raw.status === 'error';
      const tokens = raw.usage ?? raw.stats;
      return {
        type: 'result',
        result: raw.result ?? raw.response ?? '',
        sessionId: raw.session_id ?? context?.sessionId,
        usage: tokens
          ? { input_tokens: tokens.input_tokens ?? 0, output_tokens: tokens.output_tokens ?? 0 }
          : undefined,
        ...(isError
          ? {
              isError: true,
              error: raw.error?.message || raw.result || raw.response || raw.error?.type || 'Unknown error',
            }
          : {}),
      };
    }

    /* Error event. The CLI gives each a severity; after a warning (a loop it
     * stopped, a blocked agent step) the run goes on to its result, so a
     * warning passes on as a system event and does not end the stream. */
    if (raw.type === 'error') {
      const message = raw.error?.message ?? raw.message ?? 'Unknown error';
      return raw.severity === 'warning' ? { type: 'system', message } : { type: 'error', error: message };
    }

    /* System events */
    if (raw.type === 'system' || raw.type === 'status') {
      return { type: 'system', message: raw.message ?? JSON.stringify(raw) };
    }

    return null;
  }

  /* ---- Error classification ------------------------------------- */

  protected classifyError(error: any): GeminiCLIProviderError {
    const stderr: string = error.stderr ?? '';
    /* The CLI's wording varies in case ("Authentication failed"), so stderr is matched lowercased. */
    const text = String(stderr).toLowerCase();
    const exitCode = error.exitCode;

    /* Cancelled by the caller. execa sets isCanceled when the abortSignal it
     * was given as cancelSignal fires; the signal that then ends the process
     * sets isTerminated too, so this is checked before the timeout. */
    if (error.isCanceled) {
      return GeminiCLIProviderError.requestAborted({ exitCode, stderr });
    }

    /* Timeout */
    if (error.timedOut || error.isTerminated) {
      return new GeminiCLIProviderError(
        'Gemini CLI timed out.',
        'TIMEOUT',
        'Gemini CLI did not respond in time. Try again or use a smaller model (gemini-2.5-flash-lite).',
        true,
        { exitCode, stderr },
      );
    }

    /* Auth errors */
    if (text.includes('not logged in') || text.includes('authentication') || text.includes('unauthorized') || text.includes('sign in')) {
      return new GeminiCLIProviderError(
        'Gemini CLI is installed but not logged in.',
        'NOT_AUTHENTICATED',
        'Run "gemini" in your terminal and complete the Google account login flow, then try again.',
        false,
        { exitCode, stderr },
      );
    }

    /* Rate limit / quota */
    if (text.includes('rate limit') || text.includes('quota') || text.includes('too many requests') || text.includes('429') || text.includes('resource_exhausted')) {
      return new GeminiCLIProviderError(
        'Gemini CLI rate limit or quota reached.',
        'RATE_LIMITED',
        'Wait a few minutes and try again. Free tier: 60 req/min, 1000 req/day. Upgrade at https://one.google.com/explore-plan/gemini-advanced',
        true,
        { exitCode, stderr },
      );
    }

    /* Context too long */
    if (text.includes('context') && (text.includes('too long') || text.includes('token limit') || text.includes('exceeds'))) {
      return new GeminiCLIProviderError(
        'Conversation exceeds model context window.',
        'CONTEXT_TOO_LONG',
        'Start a new conversation or switch to a model with a larger context window.',
        false,
        { exitCode, stderr },
      );
    }

    /* Binary not found */
    if (error.code === 'ENOENT') {
      return new GeminiCLIProviderError(
        'Gemini CLI not found.',
        'BINARY_NOT_FOUND',
        'Install Gemini CLI: npm install -g @google/gemini-cli\n\nThen log in by running "gemini" in your terminal.',
        false,
        { exitCode, stderr },
      );
    }

    /* Permission error */
    if (error.code === 'EACCES') {
      return new GeminiCLIProviderError(
        'Failed to start Gemini CLI process due to permissions.',
        'SPAWN_FAILED',
        'Check file permissions on the gemini binary.',
        false,
        { exitCode, stderr },
      );
    }

    /* Generic crash */
    const stderrSnippet = stderr.length > 500 ? stderr.slice(-500) : stderr;
    return new GeminiCLIProviderError(
      `Gemini CLI exited unexpectedly (code ${exitCode ?? 'unknown'}).`,
      'CRASHED',
      `Try running "gemini -p test" manually to diagnose. stderr: ${stderrSnippet}`,
      true,
      { exitCode, stderr },
    );
  }
}
