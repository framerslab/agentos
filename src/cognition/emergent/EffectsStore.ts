/**
 * @fileoverview Effect records for code-forged tools under a ceiling: an
 * intent row written before each capability call, and a terminal update after
 * it, in `agentos_emergent_effects`. A row without an outcome reads as
 * unknown: its run's process ended, or its terminal write failed.
 * @module @framers/agentos/emergent/EffectsStore
 */

import { createHash, randomUUID } from 'node:crypto';
import type { IStorageAdapter } from './EmergentToolRegistry.js';

/** How a capability call ended. A row with no outcome is unknown. */
export type EffectOutcome = 'ok' | 'error' | 'aborted' | 'timed_out' | 'refused';

/** The half of a record written before the call. */
export interface EffectIntent {
  toolId: string;
  callId: string;
  agentId: string;
  capability: string;
  /**
   * The URL the broker sent (the first request's, as parsed) or the path it
   * read (resolved); for a call refused before its checks passed, the value
   * the tool passed. Stored as a SHA-256 digest unless `content` is `'full'`.
   */
  target: string;
  decision: 'allowed' | 'refused';
  /** What decided it: `'ceiling'` for an allowed call, the refusal's code otherwise. */
  decidedBy: string;
}

/** The half written after the call. */
export interface EffectTerminal {
  outcome: EffectOutcome;
  /** The code a refusal or an end carried (`host_not_allowed`, `response_too_large`, `call_ended`...). */
  code?: string;
  bytes?: number;
  /** For `crypto`: the number of calls in the run (one record per run). */
  uses?: number;
}

/** The target as a record keeps it. */
export function recordedTarget(target: string, content: 'digest' | 'full'): string {
  return content === 'full' ? target : createHash('sha256').update(target).digest('hex');
}

const DAY_MS = 86_400_000;

export class EffectsStore {
  private ready: Promise<void> | undefined;

  constructor(
    private readonly db: IStorageAdapter,
    private readonly options: {
      content: 'digest' | 'full';
      retainDays?: number;
      /** Makes the registry's schema ready; called before the first write. */
      ensureSchema: () => Promise<void>;
    },
  ) {}

  /** Writes the intent row and resolves to its id. Rejects when the write fails; the caller refuses the call. */
  async intent(row: EffectIntent): Promise<string> {
    await this.prepare();
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO agentos_emergent_effects
         (id, tool_id, call_id, agent_id, capability, target, target_form, decision, decided_by, intent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        row.toolId,
        row.callId,
        row.agentId,
        row.capability,
        recordedTarget(row.target, this.options.content),
        this.options.content,
        row.decision,
        row.decidedBy,
        Date.now(),
      ],
    );
    return id;
  }

  /** Writes the terminal half of an intent row. Rejects when the write fails; the row then reads unknown. */
  async terminal(id: string, end: EffectTerminal): Promise<void> {
    await this.db.run(
      `UPDATE agentos_emergent_effects
          SET outcome = ?, code = ?, bytes = ?, uses = ?, terminal_at = ?
        WHERE id = ?`,
      [end.outcome, end.code ?? null, end.bytes ?? null, end.uses ?? null, Date.now(), id],
    );
  }

  /** One row holding both halves: a refused call, or a run's crypto count. */
  async whole(row: EffectIntent, end: EffectTerminal): Promise<void> {
    await this.prepare();
    const at = Date.now();
    await this.db.run(
      `INSERT INTO agentos_emergent_effects
         (id, tool_id, call_id, agent_id, capability, target, target_form, decision, decided_by, intent_at,
          outcome, code, bytes, uses, terminal_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        row.toolId,
        row.callId,
        row.agentId,
        row.capability,
        recordedTarget(row.target, this.options.content),
        this.options.content,
        row.decision,
        row.decidedBy,
        at,
        end.outcome,
        end.code ?? null,
        end.bytes ?? null,
        end.uses ?? null,
        at,
      ],
    );
  }

  /**
   * The schema made ready, then, once per store, the rows older than
   * `retainDays` deleted from this table (never tool rows or state), through
   * the `intent_at` index the schema creates, so the delete the first record
   * of each engine waits on costs what it deletes, not the table's size. A
   * failed preparation is tried again by the next write; a failed prune is
   * logged and not tried again.
   */
  private prepare(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await this.options.ensureSchema();
        if (this.options.retainDays !== undefined) {
          const cutoff = Date.now() - this.options.retainDays * DAY_MS;
          await this.db
            .run('DELETE FROM agentos_emergent_effects WHERE intent_at < ?', [cutoff])
            .catch((error: unknown) => {
              console.warn(
                '[agentos:emergent] could not prune effect records:',
                error instanceof Error ? error.message : error,
              );
            });
        }
      })().catch((error: unknown) => {
        this.ready = undefined;
        throw error;
      });
    }
    return this.ready;
  }
}
