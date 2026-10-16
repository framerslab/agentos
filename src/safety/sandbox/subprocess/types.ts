/**
 * @fileoverview Shared types for the CLI subprocess bridge system.
 * These types are CLI-agnostic — they work for any binary managed
 * by {@link CLISubprocessBridge} (LLM CLIs, dev tools, media tools, etc.).
 *
 * @module agentos/sandbox/subprocess/types
 */

/* ------------------------------------------------------------------ */
/*  Bridge execution types                                             */
/* ------------------------------------------------------------------ */

/** Output format supported by CLI subprocess bridges. */
export type OutputFormat = 'json' | 'stream-json' | 'text';

/** Options for {@link CLISubprocessBridge.execute} and {@link CLISubprocessBridge.stream}. */
export interface BridgeOptions {
  /** The prompt or input text to pipe via stdin. */
  prompt: string;
  /** System prompt — how it's passed depends on the CLI (flag, file, env var). */
  systemPrompt?: string;
  /** Model ID for LLM CLIs. */
  model?: string;
  /** JSON schema for structured output (if the CLI supports it). */
  jsonSchema?: object;
  /** Maximum agentic turns (if the CLI supports it). */
  maxTurns?: number;
  /** Subprocess timeout in milliseconds (default 120 000). */
  timeout?: number;
  /** AbortSignal to cancel the subprocess. */
  abortSignal?: AbortSignal;
  /** Extra CLI flags specific to a particular bridge. */
  extraArgs?: string[];
  /** Extra environment variables merged into the subprocess env. */
  env?: Record<string, string>;
}

/** Result from a non-streaming {@link CLISubprocessBridge.execute} call. */
export interface BridgeResult {
  /** The text result returned by the CLI. */
  result: string;
  /** Session ID for potential future use. */
  sessionId?: string;
  /** Token usage stats if available. */
  usage?: { input_tokens: number; output_tokens: number };
  /** Whether the CLI reported an error. */
  isError: boolean;
  /**
   * The failure's message, set beside `isError` by a bridge that reads one
   * from its CLI's result (ClaudeCodeCLIBridge). `result` keeps the CLI's own
   * result text.
   */
  error?: string;
  /**
   * The reply that matches the call's `jsonSchema`, when the CLI returns it
   * apart from its result text (Claude Code's `structured_output`).
   */
  structuredOutput?: unknown;
  /** Wall-clock duration of the subprocess in ms. */
  durationMs: number;
}

/** Typed events yielded by {@link CLISubprocessBridge.stream}. */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | {
      type: 'result';
      /** The result text the CLI wrote, or '' when it wrote none (as on most failures). */
      result: string;
      sessionId?: string;
      usage?: { input_tokens: number; output_tokens: number };
      /** Set when the CLI flags its result as a failure. */
      isError?: boolean;
      /** The failure's message, set beside `isError`. */
      error?: string;
      /**
       * The reply that matches the call's `jsonSchema`, when the CLI returns
       * it apart from its result text (Claude Code's `structured_output`).
       */
      structuredOutput?: unknown;
    }
  | { type: 'error'; error: string }
  | { type: 'system'; message: string };

/**
 * What a bridge keeps across the lines of one {@link CLISubprocessBridge.stream}
 * call, for a CLI that writes on one line a value a later event needs. Each
 * stream starts with an empty object and hands the same one to every
 * `parseStreamEvent()` call of that stream; a bridge serves concurrent
 * streams, so state kept on the bridge itself would mix them.
 */
export interface StreamParseContext {
  /** The session id the CLI wrote on an earlier line, for an event whose own line carries none. */
  sessionId?: string;
}

/** Result from {@link CLISubprocessBridge.checkBinaryInstalled}. */
export type InstallCheckResult =
  | { installed: true; binaryPath: string; version: string }
  | { installed: false };

/* ------------------------------------------------------------------ */
/*  CLI discovery types                                                */
/* ------------------------------------------------------------------ */

/** Descriptor for a known CLI binary. Used by {@link CLIRegistry}. */
export interface CLIDescriptor {
  /** Binary name on PATH (e.g. 'claude', 'gemini', 'docker', 'ffmpeg'). */
  binaryName: string;
  /** Human-readable display name. */
  displayName: string;
  /** What this CLI does. */
  description: string;
  /** Category for grouping (e.g. 'llm', 'media', 'devtools', 'cloud', 'runtime'). */
  category: string;
  /** How to install if missing. */
  installGuidance: string;
  /** Version flag override if not --version. */
  versionFlag?: string;
  /** Regex to parse version from output (default: /(\d+\.\d+\.\d+)/). */
  versionPattern?: RegExp;
}

/** Result from {@link CLIRegistry.scan} or {@link CLIRegistry.check}. */
export interface CLIScanResult extends CLIDescriptor {
  /** Whether the binary was found on PATH. */
  installed: boolean;
  /** Resolved absolute path to the binary. */
  binaryPath?: string;
  /** Parsed version string. */
  version?: string;
}
