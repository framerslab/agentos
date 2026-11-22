/**
 * @fileoverview One turn's view of a souled agent's memory rules, as the GMI that serves the turn reads it.
 *
 * `souledAgent()` on the GMI runtime hands each session turn one of these in `GMITurnInput.metadata.soulMemory`: the
 * key the person's memory is kept under, and the answer the agent's rules give for the turn (the host's
 * `memoryPolicy`, the tombstone ledger). The GMI asks for that answer once, before it reads anything of the person.
 *
 * @module agentos/cognition/substrate/soulTurnMemory
 * @internal
 */
import type { ICognitiveMemoryManager } from '../memory/CognitiveMemoryManager.js';
import type { MemoryTrace } from '../memory/core/types.js';
import type { MemoryWriteEntry } from '../../api/runtime/memoryWriteRecord.js';

/** What one turn may do with the person it serves, as the souled agent's rules answer for it. */
export interface SoulTurnAnswer {
  /** Whether the turn recalls the person's memory. */
  recall: boolean;
  /** Whether a recall may drift the emotional context of what it reads (reconsolidation). */
  reconsolidation: boolean;
  /** Whether the person's message is scored for sentiment. */
  sentiment: boolean;
}

/** The answer of a turn whose rules gave none: the policy hook failed, the person is forgotten, or the ask threw. */
export const SOUL_TURN_NOTHING: Readonly<SoulTurnAnswer> = Object.freeze({ recall: false, reconsolidation: false, sentiment: false });

/**
 * What the soul's gate hands the mind's writer for one side of a turn: the text to store and embed (the screen's
 * answer, never the turn's own words when the screen rewrote them), the emotional stamp it is stored with, and who
 * filed it, who spoke and whose memory it is.
 */
export interface SoulFiling {
  /** The text to store and embed: the screen's answer. */
  text: string;
  /** `'neutral'`: stored with a neutral emotional state; `'mood'`: with the mind's mood when the turn ended. */
  stamp: 'neutral' | 'mood';
  /** The marker the row keeps (`MemoryTrace.filing`). */
  filing: { filedBy: 'mind'; speaker: 'user' | 'assistant'; subject: { kind: 'user' | 'session'; id: string } };
  /** A user subject's id, written on the trace as the soul's own rows carry it. */
  turnUserId?: string;
}

/** One turn's view of a souled agent's memory rules. */
export interface SoulTurnMemory {
  /**
   * The scope the person's memory is kept under: their conversation key. Absent for a subject whose id no memory key
   * can be built from: such a turn files nothing and recalls nothing of the person, and its answer allows nothing.
   */
  scope?: { scope: 'conversation'; scopeId: string };
  /**
   * Decides the turn's policy, once a turn: the decision the turn's recall opened, else a new one, kept open for the
   * turn's writes. Called before the turn's sentiment analysis.
   *
   * @param manager - The GMI's cognitive memory, or none when it runs without.
   * @param stop - The turn's stop: once it has aborted, nothing more is asked or decided for the turn.
   */
  begin(manager?: ICognitiveMemoryManager, stop?: AbortSignal): Promise<SoulTurnAnswer>;
  /**
   * Files one side of the turn through the soul's gate, on the person's write chain: the tombstone, the turn's policy,
   * the screen, then `write` with what the screen kept, and `undo` for a trace that landed after the person was
   * forgotten. Resolves with what became of it, and never rejects: a throw inside the write is a `failed` entry.
   *
   * @param role - Which side of the turn it is.
   * @param content - The side's text, before the screen.
   * @param write - Stores one filing, and resolves with its trace.
   * @param undo - Deletes a trace `write` stored, for good.
   */
  file(
    role: 'user' | 'assistant',
    content: string,
    write: (filing: SoulFiling) => Promise<MemoryTrace>,
    undo: (trace: MemoryTrace) => Promise<void>,
  ): Promise<MemoryWriteEntry>;
}
