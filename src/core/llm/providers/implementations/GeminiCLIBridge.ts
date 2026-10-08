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
import type { BridgeOptions, BridgeResult, StreamEvent, OutputFormat } from '../../../../safety/sandbox/subprocess/types';

/* Re-export shared types for provider imports */
export type { BridgeOptions, BridgeResult, StreamEvent } from '../../../../safety/sandbox/subprocess/types';
export type { InstallCheckResult } from '../../../../safety/sandbox/subprocess/types';

/**
 * Gemini CLI subprocess bridge.
 *
 * Extends {@link CLISubprocessBridge} to implement:
 * - Flag assembly: `-p`, `--output-format`, `-m`
 * - System prompt via temp file + `GEMINI_SYSTEM_MD` env var
 * - Error classification: auth, rate-limit, timeout, quota errors
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

  protected parseStreamEvent(raw: any): StreamEvent | null {
    if (!raw || typeof raw !== 'object') return null;

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

    /* Final result */
    if (raw.type === 'result') {
      return {
        type: 'result',
        result: raw.result ?? raw.response ?? '',
        sessionId: raw.session_id,
        usage: raw.usage
          ? { input_tokens: raw.usage.input_tokens ?? 0, output_tokens: raw.usage.output_tokens ?? 0 }
          : undefined,
      };
    }

    /* Error event */
    if (raw.type === 'error') {
      return { type: 'error', error: raw.error?.message ?? raw.message ?? 'Unknown error' };
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
    const exitCode = error.exitCode;

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
    if (stderr.includes('not logged in') || stderr.includes('authentication') || stderr.includes('unauthorized') || stderr.includes('sign in')) {
      return new GeminiCLIProviderError(
        'Gemini CLI is installed but not logged in.',
        'NOT_AUTHENTICATED',
        'Run "gemini" in your terminal and complete the Google account login flow, then try again.',
        false,
        { exitCode, stderr },
      );
    }

    /* Rate limit / quota */
    if (stderr.includes('rate limit') || stderr.includes('quota') || stderr.includes('too many requests') || stderr.includes('429') || stderr.includes('RESOURCE_EXHAUSTED')) {
      return new GeminiCLIProviderError(
        'Gemini CLI rate limit or quota reached.',
        'RATE_LIMITED',
        'Wait a few minutes and try again. Free tier: 60 req/min, 1000 req/day. Upgrade at https://one.google.com/explore-plan/gemini-advanced',
        true,
        { exitCode, stderr },
      );
    }

    /* Context too long */
    if (stderr.includes('context') && (stderr.includes('too long') || stderr.includes('token limit') || stderr.includes('exceeds'))) {
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
