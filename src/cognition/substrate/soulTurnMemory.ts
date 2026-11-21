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

/** One turn's view of a souled agent's memory rules. */
export interface SoulTurnMemory {
  /** The scope the person's memory is kept under: their conversation key. */
  scope: { scope: 'conversation'; scopeId: string };
  /**
   * Decides the turn's policy, once a turn: the decision the turn's recall opened, else a new one, kept open for the
   * turn's writes. Called before the turn's sentiment analysis.
   *
   * @param manager - The GMI's cognitive memory, or none when it runs without.
   */
  begin(manager?: ICognitiveMemoryManager): Promise<SoulTurnAnswer>;
}
