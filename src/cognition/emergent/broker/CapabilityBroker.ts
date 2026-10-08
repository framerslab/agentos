/**
 * @fileoverview The host-side broker for code-forged tools under a ceiling.
 * It hands each run the functions the run's grant names, scoped by the
 * ceiling. Before every capability call it checks, in this order: the run is
 * live, the capability is in the grant, the target fits the scope. It then
 * writes the intent record, naming the target as checked (the URL it sends,
 * the path it reads), checks the run is still live, performs the call while
 * tracking it under the run's id, and writes the terminal record. When
 * the run ends, `endCall` waits up to {@link CALL_SETTLE_MS} for what is in
 * flight and returns the run's effects. On `node:vm` these checks are a
 * guardrail for code that acts through these functions; Node's documentation
 * says `node:vm` is not a security mechanism.
 * @module @framers/agentos/emergent/broker/CapabilityBroker
 */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { CapabilityEffect, ToolEffectRecord } from '../../../core/tools/ITool.js';
import type { ResolvedCeiling } from '../ceiling.js';
import { recordedTarget, type EffectIntent, type EffectsStore, type EffectTerminal } from '../EffectsStore.js';
import type { CallHandle, CapabilityName } from '../types.js';
import { fetchTarget, prepareFetch, sendFetch } from './fetch.js';
import { prepareRead, readPrepared, ReadRoots, ReadTooLarge } from './fs-read.js';
import { CapabilityRefusal } from './refusal.js';

/** How long a run's end waits for its aborted capability calls to settle. */
export const CALL_SETTLE_MS = 1000;

/** What one run has done so far. */
interface RunLedger {
  call: CallHandle;
  effects: CapabilityEffect[];
  inFlight: Set<Promise<void>>;
  cryptoUses: number;
  ended: boolean;
}

type Operation<T> = (signal: AbortSignal) => Promise<{ value: T; bytes: number }>;

/** A capability call whose checks passed: the target they checked, and the call. */
interface Prepared<T> {
  /** What the records name: the URL sent (the first request's, as parsed) or the path read, resolved. */
  target: string;
  operation: Operation<T>;
}

/** The terminal half for a call that threw. */
function endOf(error: unknown): EffectTerminal {
  if (error instanceof ReadTooLarge) {
    return { outcome: 'refused', code: error.code, bytes: error.bytesRead };
  }
  if (error instanceof CapabilityRefusal) {
    if (error.code === 'aborted' || error.code === 'timed_out') {
      return { outcome: error.code, code: error.code };
    }
    return { outcome: 'refused', code: error.code };
  }
  return { outcome: 'error', code: error instanceof Error ? error.name : 'error' };
}

export class CapabilityBroker {
  private readonly readRoots: ReadRoots | undefined;
  private readonly runs = new Map<string, RunLedger>();

  /**
   * @param ceiling - The resolved ceiling the functions are scoped by.
   * @param store - Where effect records go; absent with `audit.store: 'none'`.
   */
  constructor(
    readonly ceiling: ResolvedCeiling,
    private readonly store?: EffectsStore,
  ) {
    this.readRoots = ceiling['fs.read'] ? new ReadRoots(ceiling['fs.read'].roots) : undefined;
  }

  /**
   * The globals injected into one run's sandbox: a function for each
   * capability that both the grant and the ceiling hold, and nothing else.
   * The owner of the run's handle calls {@link endCall} when the run ends.
   */
  functionsFor(grant: readonly CapabilityName[], call: CallHandle): Record<string, unknown> {
    const run = this.ledgerFor(call);
    const functions: Record<string, unknown> = {};

    const fetchScope = this.ceiling.fetch;
    if (grant.includes('fetch') && fetchScope) {
      functions.fetch = (input: unknown, init?: unknown): Promise<Response> => {
        // The forged code's argument is read once: the URL checked and sent
        // is parsed from this read, and a call refused before its checks
        // passed is recorded with it.
        const given = fetchTarget(input);
        return this.perform(run, grant, 'fetch', given ?? String(input), () => {
          const prepared = prepareFetch(given, init, fetchScope);
          return {
            // The first request's URL, as parsed: what was checked and sent.
            target: prepared.url.href,
            operation: async (signal) => {
              const sent = await sendFetch(prepared, fetchScope, signal);
              return { value: sent.response, bytes: sent.bytes };
            },
          };
        });
      };
    }

    const readScope = this.ceiling['fs.read'];
    const roots = this.readRoots;
    if (grant.includes('fs.read') && readScope && roots) {
      functions.fs = {
        readFile: (filePath: unknown): Promise<string> =>
          this.perform(run, grant, 'fs.read', String(filePath), () => {
            const resolved = prepareRead(filePath, roots);
            return {
              // The path as resolved and checked against the roots (the read
              // follows its links, and checks the real path again).
              target: resolved,
              operation: async (signal) => {
                const read = await readPrepared(resolved, roots, readScope, signal);
                return { value: read.text, bytes: read.bytes };
              },
            };
          }),
      };
    }

    if (grant.includes('crypto') && this.ceiling.crypto) {
      // Synchronous and reaching nothing outside the process: counted per
      // run, with one record when the run ends, not one per call.
      const use = (): void => {
        this.admit(run, grant, 'crypto');
        run.cryptoUses += 1;
      };
      functions.crypto = {
        randomUUID: () => {
          use();
          return randomUUID();
        },
        createHash: (algorithm: string) => {
          use();
          return createHash(algorithm);
        },
        createHmac: (algorithm: string, key: string) => {
          use();
          return createHmac(algorithm, key);
        },
      };
    }
    return functions;
  }

  /**
   * Ends a run: refuses its capability calls from now on (the owner aborts
   * the run's signal too), waits up to `settleMs` for the calls in flight,
   * writes the crypto count, and returns the run's effects. A call that has
   * not settled is listed `pending`, and its record completes when it settles.
   */
  async endCall(callId: string, settleMs: number = CALL_SETTLE_MS): Promise<ToolEffectRecord[]> {
    const run = this.runs.get(callId);
    if (!run) {
      return [];
    }
    run.ended = true;
    this.runs.delete(callId);
    if (run.inFlight.size > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...run.inFlight]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, settleMs);
        }),
      ]);
      clearTimeout(timer);
    }
    if (run.cryptoUses > 0) {
      const effect: CapabilityEffect = {
        kind: 'capability',
        toolId: run.call.toolId,
        callId: run.call.id,
        capability: 'crypto',
        target: recordedTarget('', this.ceiling.audit.content),
        decision: 'allowed',
        decidedBy: 'ceiling',
        outcome: 'ok',
        uses: run.cryptoUses,
        record: this.store ? 'written' : 'none',
      };
      if (this.store) {
        try {
          await this.store.whole(this.intentOf(run.call, 'crypto', '', 'allowed', 'ceiling'), {
            outcome: 'ok',
            uses: run.cryptoUses,
          });
        } catch {
          effect.record = 'none';
        }
      }
      run.effects.push(effect);
    }
    return run.effects.map((effect) => ({ ...effect }));
  }

  private ledgerFor(call: CallHandle): RunLedger {
    let run = this.runs.get(call.id);
    if (!run) {
      run = { call, effects: [], inFlight: new Set(), cryptoUses: 0, ended: false };
      this.runs.set(call.id, run);
    }
    return run;
  }

  /** The run is live and the capability is in its grant and the ceiling. */
  private admit(run: RunLedger, grant: readonly CapabilityName[], capability: CapabilityName): void {
    if (run.ended || run.call.signal.aborted) {
      throw new CapabilityRefusal('call_ended', capability);
    }
    if (!grant.includes(capability) || this.ceiling[capability] === undefined) {
      throw new CapabilityRefusal('capability_not_granted', capability);
    }
  }

  /**
   * One capability call: the checks, then the recorded call, tracked in
   * flight from its intent write to its terminal write, so ending the run
   * waits for both. The records name the target the checks passed (the URL
   * sent, the path read); a call refused before they passed is recorded as
   * one row naming `given`, the value the tool passed, read once.
   */
  private async perform<T>(
    run: RunLedger,
    grant: readonly CapabilityName[],
    capability: CapabilityName,
    given: string,
    prepare: () => Prepared<T>,
  ): Promise<T> {
    let prepared: Prepared<T>;
    try {
      this.admit(run, grant, capability);
      prepared = prepare();
    } catch (error: unknown) {
      if (error instanceof CapabilityRefusal) {
        await this.recordRefusal(run, capability, given, error.code);
      }
      throw error;
    }
    const { target, operation } = prepared;
    const effect: CapabilityEffect = {
      kind: 'capability',
      toolId: run.call.toolId,
      callId: run.call.id,
      capability,
      target: recordedTarget(target, this.ceiling.audit.content),
      decision: 'allowed',
      decidedBy: 'ceiling',
      outcome: 'pending',
      record: this.store ? 'written' : 'none',
    };
    run.effects.push(effect);
    const recorded = this.carryOut(run, effect, capability, target, operation);
    const settled = recorded.then(
      () => undefined,
      () => undefined,
    );
    run.inFlight.add(settled);
    try {
      return await recorded;
    } finally {
      run.inFlight.delete(settled);
    }
  }

  /** The intent record, the run checked again, the call, and its terminal record. */
  private async carryOut<T>(
    run: RunLedger,
    effect: CapabilityEffect,
    capability: CapabilityName,
    target: string,
    operation: Operation<T>,
  ): Promise<T> {
    let rowId: string | undefined;
    if (this.store) {
      try {
        rowId = await this.store.intent(this.intentOf(run.call, capability, target, 'allowed', 'ceiling'));
      } catch {
        Object.assign(effect, {
          decision: 'refused',
          decidedBy: 'audit_unavailable',
          outcome: 'refused',
          code: 'audit_unavailable',
          record: 'none',
        });
        throw new CapabilityRefusal('audit_unavailable', `${capability}: its effect record could not be written`);
      }
    }
    // The run may have ended while its intent was written.
    if (run.ended || run.call.signal.aborted) {
      await this.finish(effect, rowId, { outcome: 'aborted', code: 'call_ended' });
      throw new CapabilityRefusal('call_ended', capability);
    }
    let result: { value: T; bytes: number };
    try {
      result = await operation(run.call.signal);
    } catch (error: unknown) {
      await this.finish(effect, rowId, endOf(error));
      throw error;
    }
    await this.finish(effect, rowId, { outcome: 'ok', bytes: result.bytes });
    return result.value;
  }

  private async finish(effect: CapabilityEffect, rowId: string | undefined, end: EffectTerminal): Promise<void> {
    effect.outcome = end.outcome;
    if (end.code !== undefined) {
      effect.code = end.code;
    }
    if (end.bytes !== undefined) {
      effect.bytes = end.bytes;
    }
    if (this.store && rowId !== undefined) {
      try {
        await this.store.terminal(rowId, end);
      } catch {
        effect.record = 'intent_only';
      }
    }
  }

  private async recordRefusal(run: RunLedger, capability: CapabilityName, target: string, code: string): Promise<void> {
    const effect: CapabilityEffect = {
      kind: 'capability',
      toolId: run.call.toolId,
      callId: run.call.id,
      capability,
      target: recordedTarget(target, this.ceiling.audit.content),
      decision: 'refused',
      decidedBy: code,
      outcome: 'refused',
      code,
      record: this.store ? 'written' : 'none',
    };
    run.effects.push(effect);
    if (this.store) {
      try {
        await this.store.whole(this.intentOf(run.call, capability, target, 'refused', code), {
          outcome: 'refused',
          code,
        });
      } catch {
        effect.record = 'none';
      }
    }
  }

  private intentOf(
    call: CallHandle,
    capability: string,
    target: string,
    decision: 'allowed' | 'refused',
    decidedBy: string,
  ): EffectIntent {
    return { toolId: call.toolId, callId: call.id, agentId: call.agentId, capability, target, decision, decidedBy };
  }
}
