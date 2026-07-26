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
 * Session conversation state: whole-send blocks, chunk-amortized eviction,
 * epoch-guarded mutation (spec §1c/§1d). Pure state machine — no I/O, no
 * provider coupling — so eviction semantics are testable byte-for-byte.
 *
 * Eviction shape: one contiguous OLDEST chunk per event, whole blocks only
 * (a block is one send's complete delta, so tool_use never separates from
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
