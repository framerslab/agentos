import { CONTEXT_WINDOW_EXCEEDED_CODE } from './errorCodes.js';

/**
 * Thrown in place of a call whose request does not fit the model's context
 * window: the size check refused to send it, so it carries no HTTP status.
 * Its code is retryable, so a fallback walk starts at once, and the provider
 * health registry never records it.
 */
export class ContextWindowExceededError extends Error {
  readonly code = CONTEXT_WINDOW_EXCEEDED_CODE;
  readonly provider: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly estimatedInputTokens: number;
  readonly outputTokens: number;

  constructor(args: {
    provider: string;
    model: string;
    contextWindow: number;
    estimatedInputTokens: number;
    outputTokens: number;
  }) {
    super(
      `${args.model} on ${args.provider} was not sent this request: about ${args.estimatedInputTokens} input ` +
        `tokens plus ${args.outputTokens} output tokens exceed its ${args.contextWindow}-token context window.`,
    );
    this.name = 'ContextWindowExceededError';
    this.provider = args.provider;
    this.model = args.model;
    this.contextWindow = args.contextWindow;
    this.estimatedInputTokens = args.estimatedInputTokens;
    this.outputTokens = args.outputTokens;
  }
}
