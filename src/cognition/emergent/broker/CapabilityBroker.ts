/**
 * @fileoverview The host-side broker for code-forged tools under a ceiling.
 * It hands each run the functions the run's grant names, scoped by the
 * ceiling. Before every capability call it checks, in this order: the run is
 * live, the capability is in the grant, the target fits the scope. For an
 * effect (a write, a delete, a state-changing request) it then checks the
 * bounds, reserving the effect's share of the run's totals in the same
 * synchronous step, and asks the host's `effectPolicy`. It then writes the
 * intent record, naming the target as checked (the URL it sends, the path it
 * reads or writes), checks the run is still live, performs the call while
 * tracking it under the run's id, and writes the terminal record. When the
 * run ends, `endCall` waits up to {@link CALL_SETTLE_MS} for what is in
 * flight and returns the run's effects. In a forge test's run (a dry run)
 * every check is made as in a real call and nothing is written, deleted or
 * sent (dry-run.ts). On `node:vm` these checks are a guardrail for code that
 * acts through these functions; Node's documentation says `node:vm` is not a
 * security mechanism, and effects are granted only on an isolating executor.
 * @module @framers/agentos/emergent/broker/CapabilityBroker
 */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { CapabilityEffect, ToolEffectRecord } from '../../../core/tools/ITool.js';
import type { ResolvedCeiling } from '../ceiling.js';
import { recordedTarget, type EffectIntent, type EffectsStore, type EffectTerminal } from '../EffectsStore.js';
import type { CallHandle, CapabilityName, EffectPolicy, PendingEffect } from '../types.js';
import { DryRunOverlay } from './dry-run.js';
import { fetchTarget, InFlightCut, prepareFetch, sendFetch, STATE_CHANGING } from './fetch.js';
import { prepareRead, readPrepared, ReadRoots, ReadTooLarge, withinRoots } from './fs-read.js';
import { checkDelete, checkWrite, EffectCut, EffectRoots, removeAt, writeAt, writeBytes } from './fs-write.js';
import { CapabilityRefusal } from './refusal.js';

/** How long a run's end waits for its aborted capability calls to settle. */
export const CALL_SETTLE_MS = 1000;

/** How long `effectPolicy` may take; its silence past this refuses the effect. */
export const POLICY_TIMEOUT_MS = 1000;

/** What one run has done so far. */
interface RunLedger {
  call: CallHandle;
  effects: CapabilityEffect[];
  inFlight: Set<Promise<void>>;
  cryptoUses: number;
  ended: boolean;
  /** The shares of the write bounds reserved by this run's writes. */
  written: { files: number; bytes: number };
  /** The deletes this run has reserved. */
  deleted: number;
  /** A forge test's view of the files it touched; absent for a real call. */
  overlay?: DryRunOverlay;
}

type Operation<T> = (signal: AbortSignal) => Promise<{ value: T; bytes: number; code?: string }>;

/** A capability call whose scope checks passed: the target they checked, and the call. */
interface Prepared<T> {
  /** What the records name: the URL sent (with its method for a state-changing request), or the path read or written. */
  target: string;
  operation: Operation<T>;
  /**
   * An effect: what `effectPolicy` is shown, and the bounds, checked and
   * reserved after the scope and before the policy.
   */
  effect?: {
    pending: Pick<PendingEffect, 'capability' | 'target' | 'method' | 'bytes'>;
    reserve?: () => void;
    release?: () => void;
  };
}

/** The broker's settings beside the ceiling and the store. */
export interface BrokerOptions {
  /** The host's last word on each write, delete and state-changing request. */
  policy?: EffectPolicy;
  /** The real paths no write or delete root may hold or lie inside (protected.ts). */
  protectedReal?: readonly string[];
}

/** A state-changing request that was sent and answered, whose answer passed `maxResponseBytes`. */
class AnsweredTooLarge extends CapabilityRefusal {
  constructor(detail: string) {
    super('response_too_large', detail);
  }
}

/** The terminal half for a call that threw. */
function endOf(error: unknown): EffectTerminal {
  if (error instanceof ReadTooLarge) {
    return { outcome: 'refused', code: error.code, bytes: error.bytesRead };
  }
  if (error instanceof InFlightCut) {
    // The request was sent: whether the server acted on it is unknown.
    return { outcome: null, code: error.code };
  }
  if (error instanceof AnsweredTooLarge) {
    // The request was made and answered; only the answer was refused.
    return { outcome: 'ok', code: error.code };
  }
  if (error instanceof EffectCut) {
    return { outcome: error.outcome, code: error.code };
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
  private readonly writeRoots: EffectRoots | undefined;
  private readonly deleteRoots: EffectRoots | undefined;
  private readonly policy: EffectPolicy | undefined;
  private readonly runs = new Map<string, RunLedger>();

  /**
   * @param ceiling - The resolved ceiling the functions are scoped by.
   * @param store - Where effect records go; absent with `audit.store: 'none'`.
   * @param options - The host's `effectPolicy`, and the protected paths for
   *   write and delete roots that did not exist when the ceiling was built.
   */
  constructor(
    readonly ceiling: ResolvedCeiling,
    private readonly store?: EffectsStore,
    options: BrokerOptions = {},
  ) {
    const protectedReal = options.protectedReal ?? [];
    this.readRoots = ceiling['fs.read'] ? new ReadRoots(ceiling['fs.read'].roots) : undefined;
    this.writeRoots = ceiling['fs.write'] ? new EffectRoots(ceiling['fs.write'].roots, protectedReal) : undefined;
    this.deleteRoots = ceiling['fs.delete'] ? new EffectRoots(ceiling['fs.delete'].roots, protectedReal) : undefined;
    this.policy = options.policy;
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
          if (!STATE_CHANGING.has(prepared.method)) {
            return {
              // The first request's URL, as parsed: what was checked and sent.
              target: prepared.url.href,
              operation: async (signal) => {
                const sent = await sendFetch(prepared, fetchScope, signal);
                return { value: sent.response, bytes: sent.bytes };
              },
            };
          }
          const bodyBytes = prepared.bodyBytes ?? 0;
          return {
            target: `${prepared.method} ${prepared.url.href}`,
            effect: { pending: { capability: 'fetch' as const, target: prepared.url.href, method: prepared.method, bytes: bodyBytes } },
            operation: async (signal) => {
              if (run.overlay) {
                // A dry run sends nothing: the test case's answer, or a 204 saying so.
                return { value: run.overlay.answer(prepared.method, prepared.url), bytes: bodyBytes, code: 'dry_run' };
              }
              try {
                const sent = await sendFetch(prepared, fetchScope, signal);
                return { value: sent.response, bytes: sent.bytes };
              } catch (error: unknown) {
                if (error instanceof CapabilityRefusal && error.code === 'response_too_large') {
                  throw new AnsweredTooLarge(error.message);
                }
                throw error;
              }
            },
          };
        });
      };
    }

    const fsFunctions: Record<string, unknown> = {};
    const readScope = this.ceiling['fs.read'];
    const readRoots = this.readRoots;
    if (grant.includes('fs.read') && readScope && readRoots) {
      fsFunctions.readFile = (filePath: unknown): Promise<string> =>
        this.perform(run, grant, 'fs.read', String(filePath), () => {
          const resolved = prepareRead(filePath, readRoots);
          return {
            // The path as resolved and checked against the roots (the read
            // follows its links, and checks the real path again).
            target: resolved,
            operation: async (signal) => {
              const fromOverlay = run.overlay ? await this.readOverlay(run.overlay, resolved, readRoots, readScope) : undefined;
              if (fromOverlay) {
                return fromOverlay;
              }
              const read = await readPrepared(resolved, readRoots, readScope, signal);
              return { value: read.text, bytes: read.bytes };
            },
          };
        });
    }

    const writeScope = this.ceiling['fs.write'];
    const writeRoots = this.writeRoots;
    if (grant.includes('fs.write') && writeScope && writeRoots) {
      fsFunctions.writeFile = (filePath: unknown, data: unknown): Promise<void> =>
        this.perform(run, grant, 'fs.write', String(filePath), async () => {
          // The effect's time bound starts when it is admitted, checks included.
          const timer = AbortSignal.timeout(writeScope.timeoutMs);
          const bytes = writeBytes(data);
          const target = await checkWrite(filePath, writeRoots, writeScope.mode, run.overlay);
          const size = bytes.byteLength;
          return {
            target,
            effect: {
              pending: { capability: 'fs.write' as const, target, bytes: size },
              reserve: () => {
                if (size > writeScope.maxBytesPerFile) {
                  throw new CapabilityRefusal('file_too_large', `${size} bytes, more than ${writeScope.maxBytesPerFile}`);
                }
                if (run.written.files + 1 > writeScope.maxFilesPerCall) {
                  throw new CapabilityRefusal('call_quota_exceeded', `more than ${writeScope.maxFilesPerCall} files written in one call`);
                }
                if (run.written.bytes + size > writeScope.maxBytesPerCall) {
                  throw new CapabilityRefusal('call_quota_exceeded', `more than ${writeScope.maxBytesPerCall} bytes written in one call`);
                }
                run.written.files += 1;
                run.written.bytes += size;
              },
              release: () => {
                run.written.files -= 1;
                run.written.bytes -= size;
              },
            },
            operation: async (signal) => {
              if (run.overlay) {
                await run.overlay.write(target, bytes);
                return { value: undefined, bytes: size, code: 'dry_run' };
              }
              const done = await writeAt(target, bytes, writeScope.mode, run.call.id, signal, timer);
              return { value: undefined, bytes: done.bytes };
            },
          };
        });
    }

    const deleteScope = this.ceiling['fs.delete'];
    const deleteRoots = this.deleteRoots;
    if (grant.includes('fs.delete') && deleteScope && deleteRoots) {
      fsFunctions.unlink = (filePath: unknown): Promise<void> =>
        this.perform(run, grant, 'fs.delete', String(filePath), async () => {
          const timer = AbortSignal.timeout(deleteScope.timeoutMs);
          const target = await checkDelete(filePath, deleteRoots, run.overlay);
          return {
            target,
            effect: {
              pending: { capability: 'fs.delete' as const, target },
              reserve: () => {
                if (run.deleted + 1 > deleteScope.maxFilesPerCall) {
                  throw new CapabilityRefusal('call_quota_exceeded', `more than ${deleteScope.maxFilesPerCall} files deleted in one call`);
                }
                run.deleted += 1;
              },
              release: () => {
                run.deleted -= 1;
              },
            },
            operation: async (signal) => {
              if (run.overlay) {
                run.overlay.remove(target);
                return { value: undefined, bytes: 0, code: 'dry_run' };
              }
              const done = await removeAt(target, signal, timer);
              return { value: undefined, bytes: done.bytes };
            },
          };
        });
    }
    if (Object.keys(fsFunctions).length > 0) {
      functions.fs = fsFunctions;
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
   * writes the crypto count, removes a dry run's files, and returns the
   * run's effects. A call that has not settled is listed `pending`, and its
   * record completes when it settles.
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
    if (run.overlay) {
      const overlay = run.overlay;
      // A write still in flight lands in the directory first; remove it after that.
      void Promise.allSettled([...run.inFlight]).then(() => overlay.dispose());
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
      run = {
        call,
        effects: [],
        inFlight: new Set(),
        cryptoUses: 0,
        ended: false,
        written: { files: 0, bytes: 0 },
        deleted: 0,
        ...(call.dryRun ? { overlay: new DryRunOverlay(call.dryRun.responses) } : {}),
      };
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

  /** What a record or an effect list shows of a target: in full in a forge test's run, for the judge; otherwise as `audit.content` says. */
  private shownTarget(run: RunLedger, target: string): string {
    return run.call.dryRun ? target : recordedTarget(target, this.ceiling.audit.content);
  }

  /**
   * A dry run's read of a path the run wrote or deleted: what the run left
   * there, after the same checks as a real read. Undefined when the run did
   * neither, and the read goes to the real tree.
   */
  private async readOverlay(
    overlay: DryRunOverlay,
    resolved: string,
    roots: ReadRoots,
    scope: { maxBytesPerRead: number },
  ): Promise<{ value: string; bytes: number } | undefined> {
    let parent: string;
    try {
      parent = await realpath(path.dirname(resolved));
    } catch {
      return undefined;
    }
    const target = path.join(parent, path.basename(resolved));
    const entry = overlay.look(target);
    if (entry === undefined) {
      return undefined;
    }
    if (!withinRoots(parent, await roots.real())) {
      throw new CapabilityRefusal('path_not_allowed', `${resolved} resolves outside the roots`);
    }
    if (entry === 'absent') {
      throw new CapabilityRefusal('no_such_file', resolved);
    }
    const data = (await overlay.read(target)) ?? Buffer.alloc(0);
    if (data.byteLength > scope.maxBytesPerRead) {
      throw new ReadTooLarge(data.byteLength, scope.maxBytesPerRead);
    }
    return { value: data.toString('utf-8'), bytes: data.byteLength };
  }

  /**
   * The host's verdict on an effect: undefined to go on, or the reason it is
   * refused. A throw, or no answer within {@link POLICY_TIMEOUT_MS}, refuses.
   */
  private async askPolicy(run: RunLedger, effect: NonNullable<Prepared<unknown>['effect']>): Promise<string | undefined> {
    const policy = this.policy;
    if (!policy) {
      return undefined;
    }
    const pending: PendingEffect = {
      ...effect.pending,
      toolId: run.call.toolId,
      agentId: run.call.agentId,
      callId: run.call.id,
      dryRun: run.call.dryRun !== undefined,
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      const verdict = await Promise.race([
        Promise.resolve().then(() => policy(pending)),
        new Promise<'silent'>((resolve) => {
          timer = setTimeout(() => resolve('silent'), POLICY_TIMEOUT_MS);
        }),
      ]);
      if (verdict === 'silent') {
        return `effectPolicy did not answer within ${POLICY_TIMEOUT_MS} ms`;
      }
      if (verdict !== null && typeof verdict === 'object' && 'deny' in verdict) {
        return String((verdict as { deny: unknown }).deny);
      }
      return undefined;
    } catch (error: unknown) {
      return `effectPolicy threw: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One capability call: the scope checks, then for an effect the bounds and
   * the policy, then the recorded call, tracked in flight from its intent
   * write to its terminal write, so ending the run waits for both. The
   * records name the target the checks passed; a call refused before they
   * passed is recorded as one row naming `given`, the value the tool passed,
   * read once.
   */
  private async perform<T>(
    run: RunLedger,
    grant: readonly CapabilityName[],
    capability: CapabilityName,
    given: string,
    prepare: () => Prepared<T> | Promise<Prepared<T>>,
  ): Promise<T> {
    let prepared: Prepared<T>;
    try {
      this.admit(run, grant, capability);
      prepared = await prepare();
    } catch (error: unknown) {
      if (error instanceof CapabilityRefusal) {
        await this.recordRefusal(run, capability, given, error.code);
      }
      throw error;
    }
    const { target, operation, effect: effectCheck } = prepared;
    if (effectCheck) {
      // The run is checked again after the scope's awaits, and the bounds
      // are reserved in this synchronous step, so calls in flight together
      // cannot pass a bound between them.
      try {
        this.admit(run, grant, capability);
        effectCheck.reserve?.();
      } catch (error: unknown) {
        if (error instanceof CapabilityRefusal) {
          await this.recordRefusal(run, capability, target, error.code);
        }
        throw error;
      }
      const denied = await this.askPolicy(run, effectCheck);
      const ended = run.ended || run.call.signal.aborted;
      if (denied !== undefined || ended) {
        effectCheck.release?.();
        const refusal =
          denied !== undefined
            ? new CapabilityRefusal('policy_denied', denied)
            : new CapabilityRefusal('call_ended', capability);
        await this.recordRefusal(run, capability, target, refusal.code);
        throw refusal;
      }
    }
    const effect: CapabilityEffect = {
      kind: 'capability',
      toolId: run.call.toolId,
      callId: run.call.id,
      capability,
      target: this.shownTarget(run, target),
      decision: 'allowed',
      decidedBy: 'ceiling',
      outcome: 'pending',
      record: this.store ? 'written' : 'none',
      ...(effectCheck && run.overlay ? { dryRun: true as const } : {}),
    };
    run.effects.push(effect);
    const recorded = this.carryOut(run, effect, capability, target, operation, effectCheck?.release);
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

  /**
   * The intent record, the run checked again, the call, and its terminal
   * record. An effect that never started returns its reserved share
   * (`release`); one that ran, or was cut, keeps it.
   */
  private async carryOut<T>(
    run: RunLedger,
    effect: CapabilityEffect,
    capability: CapabilityName,
    target: string,
    operation: Operation<T>,
    release?: () => void,
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
        release?.();
        throw new CapabilityRefusal('audit_unavailable', `${capability}: its effect record could not be written`);
      }
    }
    // The run may have ended while its intent was written.
    if (run.ended || run.call.signal.aborted) {
      release?.();
      await this.finish(effect, rowId, { outcome: 'aborted', code: 'call_ended' });
      throw new CapabilityRefusal('call_ended', capability);
    }
    let result: { value: T; bytes: number; code?: string };
    try {
      result = await operation(run.call.signal);
    } catch (error: unknown) {
      await this.finish(effect, rowId, endOf(error));
      throw error;
    }
    await this.finish(effect, rowId, {
      outcome: 'ok',
      bytes: result.bytes,
      ...(result.code !== undefined ? { code: result.code } : {}),
    });
    return result.value;
  }

  private async finish(effect: CapabilityEffect, rowId: string | undefined, end: EffectTerminal): Promise<void> {
    // A stored outcome left empty is the store's unknown.
    effect.outcome = end.outcome ?? 'unknown';
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
      target: this.shownTarget(run, target),
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
