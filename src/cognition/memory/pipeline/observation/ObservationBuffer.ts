/**
 * @fileoverview Token-counting buffer for the observation system.
 *
 * Accumulates conversation messages and tracks approximate token count.
 * When the configured threshold is reached, signals that observation
 * extraction should be triggered.
 *
 * @module agentos/memory/observation/ObservationBuffer
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BufferedMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  /** Cached token estimate for this message. */
  tokenEstimate: number;
}

export interface ObservationBufferConfig {
  /** Token threshold before observer should be triggered. @default 30_000 */
  activationThresholdTokens: number;
  /**
   * Message-count threshold before the observer should be triggered.
   *
   * Conversational turns are far too small (~100-300 tokens) to ever reach the
   * token threshold, so without this the observer never fires in chat and
   * durable memory is never extracted. Activation is
   * `pendingTokens >= activationThresholdTokens OR pendingMessages >= activationThresholdMessages`,
   * so batch ingestion of large single messages still fires on tokens while
   * chat fires on message count. @default 20
   */
  activationThresholdMessages: number;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Rough token estimate: ~4 chars per token for English text. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// ObservationBuffer
// ---------------------------------------------------------------------------

export class ObservationBuffer {
  private messages: BufferedMessage[] = [];
  private totalTokens = 0;
  private config: ObservationBufferConfig;
  /** Number of tokens that have been drained (consumed by observer). */
  private drainedTokens = 0;

  constructor(config?: Partial<ObservationBufferConfig>) {
    this.config = {
      activationThresholdTokens: config?.activationThresholdTokens ?? 30_000,
      activationThresholdMessages: config?.activationThresholdMessages ?? 20,
    };
  }

  /**
   * Add a message to the buffer.
   * Returns true if the buffer has reached activation threshold.
   */
  push(role: BufferedMessage['role'], content: string): boolean {
    const tokenEstimate = estimateTokens(content);
    this.messages.push({
      role,
      content,
      timestamp: Date.now(),
      tokenEstimate,
    });
    this.totalTokens += tokenEstimate;
    return this.shouldActivate();
  }

  /**
   * Whether accumulated tokens OR messages since the last drain exceed their
   * thresholds. The message-count path is what makes the observer fire in chat,
   * where turns are far too small to ever reach the token threshold.
   */
  shouldActivate(): boolean {
    const pendingTokens = this.totalTokens - this.drainedTokens;
    const pendingMessages = this.messages.length - this.drainCursor;
    return (
      pendingTokens >= this.config.activationThresholdTokens ||
      pendingMessages >= this.config.activationThresholdMessages
    );
  }

  /**
   * Drain messages since last drain for observation processing.
   * Returns the messages and marks them as consumed.
   */
  drain(): BufferedMessage[] {
    const unprocessed = this.messages.slice(this.drainCursor);
    this.drainedTokens = this.totalTokens;
    this.drainCursor = this.messages.length;
    return unprocessed;
  }

  /** Index of next unprocessed message. */
  private drainCursor = 0;

  /** Total accumulated tokens. */
  getTotalTokens(): number {
    return this.totalTokens;
  }

  /** Unprocessed tokens since last drain. */
  getPendingTokens(): number {
    return this.totalTokens - this.drainedTokens;
  }

  /** Total message count. */
  getMessageCount(): number {
    return this.messages.length;
  }

  /** Clear the buffer entirely. */
  clear(): void {
    this.messages = [];
    this.totalTokens = 0;
    this.drainedTokens = 0;
    this.drainCursor = 0;
  }
}
