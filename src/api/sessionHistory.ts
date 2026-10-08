import { estimateTokens } from '../core/utils/text-utils.js';
import {
  transcriptTokenText,
  validateTranscriptPairing,
  type SessionTranscriptMessage,
} from './sessionTranscript.js';

/** Bounded-history config (spec 2026-07-20 §1c). All fields optional at the API edge. */
export interface SessionHistoryConfig {
  /** Evict when the estimated history tokens exceed this. Default 120_000. */
  maxTokens: number;
  /** Fraction of blocks dropped per eviction event. Default 0.25. */
  evictChunkRatio: number;
  /** Newest send-deltas never evicted. Default 8. */
  minKeepSends: number;
}

export const SESSION_HISTORY_DEFAULTS: SessionHistoryConfig = {
  maxTokens: 120_000,
  evictChunkRatio: 0.25,
  minKeepSends: 8,
};

export type HistoryEvent =
  | { type: 'eviction'; blocksDropped: number; tokensBefore: number; tokensAfter: number }
  | { type: 'reseed'; blocksBefore: number }
  | { type: 'stale-append-discarded'; label?: string };

interface Block {
  label?: string;
  messages: SessionTranscriptMessage[];
  tokens: number;
}

/**
 * One in-flight turn on the GMI path (`agent({ runtime: 'gmi' })`). The turn's
 * model steps accumulate and land as ONE block, so eviction keeps or drops the
 * whole turn and never separates a tool call from its result.
 */
export interface SessionTurnWriter {
  /**
   * Adds one model step's messages: the user message first on the turn's first
   * step, then the assistant message and its tool results. Returns false, and
   * adds nothing, when the step leaves a tool call unanswered or the writer is
   * closed.
   */
  appendStep(messages: SessionTranscriptMessage[]): boolean;
  /**
   * Stores the turn as one block and runs eviction. Returns false when no step
   * was appended, the writer is already closed, or the history was reseeded
   * (or cleared) after the turn began.
   */
  commit(): boolean;
  /**
   * Ends a failed turn. With `partial: true` the steps that completed are
   * stored, the block's last message marked `partial`; otherwise nothing is
   * stored. Returns whether a block was stored.
   */
  abort(options?: { partial?: boolean }): boolean;
}

/**
 * Session conversation state: whole-send blocks, chunk-amortized eviction,
 * epoch-guarded mutation (spec §1c/§1d). Pure state machine — no I/O, no
 * provider coupling — so eviction semantics are testable byte-for-byte.
 *
 * Eviction shape: one contiguous OLDEST chunk per event, whole blocks only
 * (a block is one send's complete delta, or one GMI turn written through
 * {@link SessionHistoryBuffer.beginTurn}, so tool_use never separates from
 * its tool_result), amortizing the cache re-pay to one write per event.
 * Byte-stability is an invariant of THIS stored serialization; the final
 * wire request may still diverge under dynamic memory-context injection
 * (spec §1e scopes the guarantee).
 */
export class SessionHistoryBuffer {
  private blocks: Block[] = [];
  private historyEpoch = 0;
  private events: HistoryEvent[] = [];

  constructor(private readonly cfg: SessionHistoryConfig) {}

  epoch(): number {
    return this.historyEpoch;
  }

  /** Flat provider-replayable view. Callers must not mutate entries. */
  messages(): SessionTranscriptMessage[] {
    return this.blocks.flatMap((b) => b.messages);
  }

  blockCount(): number {
    return this.blocks.length;
  }

  totalTokens(): number {
    return this.blocks.reduce((sum, b) => sum + b.tokens, 0);
  }

  /**
   * Appends one send's complete delta as an atomic block, then runs
   * eviction. When `expectEpoch` is supplied and stale (a reseed happened
   * while the send was in flight), the append is DISCARDED and false
   * returned — the caller's result is unaffected; only the history mutation
   * is dropped (spec §1d).
   */
  appendSendDelta(
    delta: SessionTranscriptMessage[],
    label?: string,
    expectEpoch?: number,
  ): boolean {
    if (expectEpoch !== undefined && expectEpoch !== this.historyEpoch) {
      this.events.push({ type: 'stale-append-discarded', label });
      return false;
    }
    this.blocks.push({
      label,
      messages: delta,
      tokens: estimateTokens(transcriptTokenText(delta)),
    });
    this.evictIfNeeded();
    return true;
  }

  /**
   * Starts a turn whose steps land as one block (GMI path). The turn is tied
   * to the current epoch: a reseed or clear while it runs discards it at
   * commit, as {@link appendSendDelta} discards a stale send. Eviction runs
   * at commit only, so a turn's earlier steps can never be evicted while its
   * later steps are still being written.
   *
   * @param label - Telemetry and eviction-boundary label for the turn's block.
   * @param expectEpoch - The epoch the turn started under, when it read the
   *   history before calling this (default: the current epoch). A reseed or
   *   clear between that read and this call makes the turn's commit a no-op.
   */
  beginTurn(label?: string, expectEpoch?: number): SessionTurnWriter {
    const epochAtStart = expectEpoch ?? this.historyEpoch;
    const steps: SessionTranscriptMessage[] = [];
    let open = true;
    const land = (partial: boolean): boolean => {
      if (!open) return false;
      open = false;
      if (steps.length === 0) return false;
      if (epochAtStart !== this.historyEpoch) {
        this.events.push({ type: 'stale-append-discarded', label });
        return false;
      }
      const messages = steps.slice();
      if (partial) {
        const last = messages[messages.length - 1];
        if (last.role !== 'user') messages[messages.length - 1] = { ...last, partial: true as const };
      }
      this.blocks.push({ label, messages, tokens: estimateTokens(transcriptTokenText(messages)) });
      this.evictIfNeeded();
      return true;
    };
    return {
      appendStep: (messages) => {
        if (!open || messages.length === 0) return false;
        if (!validateTranscriptPairing(messages).ok) return false;
        steps.push(...messages);
        return true;
      },
      commit: () => land(false),
      abort: (options) => {
        if (options?.partial) return land(true);
        open = false;
        return false;
      },
    };
  }

  /** Atomic replace + epoch bump. Throws on pairing-invalid snapshots. */
  reseed(snapshot: SessionTranscriptMessage[]): void {
    const verdict = validateTranscriptPairing(snapshot);
    if (!verdict.ok) throw new Error(`reseed rejected: ${verdict.reason}`);
    this.events.push({ type: 'reseed', blocksBefore: this.blocks.length });
    this.blocks = snapshot.length
      ? [{ messages: [...snapshot], tokens: estimateTokens(transcriptTokenText(snapshot)) }]
      : [];
    this.historyEpoch += 1;
  }

  /** Returns accumulated telemetry events and clears the queue. */
  drainHistoryEvents(): HistoryEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  private evictIfNeeded(): void {
    const before = this.totalTokens();
    if (before <= this.cfg.maxTokens) return;
    const evictable = Math.max(0, this.blocks.length - this.cfg.minKeepSends);
    if (evictable === 0) return;
    const target = Math.max(1, Math.ceil(this.blocks.length * this.cfg.evictChunkRatio));
    const drop = Math.min(evictable, target);
    this.blocks.splice(0, drop);
    this.events.push({
      type: 'eviction',
      blocksDropped: drop,
      tokensBefore: before,
      tokensAfter: this.totalTokens(),
    });
  }
}
