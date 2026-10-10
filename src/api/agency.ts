/**
 * @file agency.ts
 * Multi-agent agency factory for the AgentOS high-level API.
 *
 * `agency()` accepts an {@link AgencyOptions} configuration, compiles the
 * requested orchestration strategy, wires resource controls, and returns a
 * single {@link Agent}-compatible interface that coordinates all sub-agents.
 *
 * The returned instance exposes `generate`, `stream`, `session`, `usage`, and
 * `close` — identical surface to a single `agent()` instance — so callers can
 * swap between them transparently.
 *
 * # Scope: single-request multi-agent coordination
 *
 * `agency()` is for the pattern where one external request produces one
 * coordinated multi-agent response. Examples that fit:
 *
 * - Research workflow: user asks a question, an agency of researcher +
 *   writer + reviewer collaborates to produce one answer.
 * - Customer support escalation: one user message, an agency of triage +
 *   specialist + supervisor handles it.
 * - Code review pipeline: one PR, an agency of style + security + tests
 *   reviewers produces one review.
 *
 * Examples that do NOT fit and should use their own orchestration:
 *
 * - Long-running world simulations where multiple agents run every turn
 *   in parallel against an evolving world state (e.g. paracosm). Each
 *   simulation turn is much closer to N independent
 *   `agent().session()` calls coordinated by a custom loop than to one
 *   `agency().generate()` call. Use `agent()` + `EmergentAgentForge` /
 *   `EmergentAgentJudge` directly if you need runtime agent synthesis
 *   inside a custom orchestrator.
 * - Multi-turn conversational simulations where a fixed roster all
 *   speak each turn. The agency strategies pick WHICH agent runs next;
 *   they do not run all of them in parallel per turn.
 *
 * `agency().session()` exists but is shallow: it persists per-session
 * message history and usage totals only. The agent roster, the
 * `AgencyMemoryManager`, and any `tier: 'session'` synthesised
 * specialists from `spawn_specialist` are reset between `.send()` calls.
 * If you need multi-call agency state to persist, build your own
 * orchestration layer over agentos primitives.
 *
 * @example
 * ```ts
 * import { agency, hitl } from '@framers/agentos';
 *
 * const myAgency = agency({
 *   provider: 'openai',
 *   model: 'gpt-4o',
 *   strategy: 'sequential',
 *   agents: {
 *     researcher: { instructions: 'Find relevant information.' },
 *     writer:     { instructions: 'Write a clear summary.' },
 *   },
 *   controls: { maxTotalTokens: 50_000, onLimitReached: 'warn' },
 *   hitl: { approvals: { beforeTool: ['delete'] }, handler: hitl.autoApprove() },
 * });
 *
 * const result = await myAgency.generate('Summarise recent AI research.');
 * console.log(result.text);
 * ```
 */

import { compileStrategy, isAgent } from './runtime/strategies/index.js';
import { validatePoolOptions, hasPoolSurface } from './runtime/pool/validate.js';
import { createSeatingState, seatRoster, type SeatingState, type SeatedRoster } from './runtime/pool/seating.js';
import { guardPerCallOptions } from './runtime/pool/guard.js';
import { collectCallSecrets, createErrorMask, maskedCopyOf, redactStrings, redactText } from './runtime/pool/redact.js';
import type {
  AgencyOptions,
  Agent,
  BaseAgentConfig,
  CompiledStrategy,
  ResourceControls,
  AgentCallRecord,
  GuardrailEvent,
  RagConfig,
  AgencyStreamPart,
  AgencyStreamResult,
  AgencyResult,
  AgencyInstance,
  PanelResult,
  PanelSeatRecord,
  PanelQuorumRecord,
  SeatingRecord,
  CompiledStrategyStreamResult,
} from './types.js';
import { AgencyConfigError, AgencyPanelError, AgencyQuorumError } from './types.js';
import {
  exportAgentConfig,
  exportAgentConfigJSON,
  type AgentExportConfig,
  type ExportAgentConfigOptions,
} from './agentExport.js';
import {
  createApprovalGate,
  createApprovalSlot,
  composeReceivedGate,
  resolveApprovalDecision,
  type ApprovalSlot,
} from './runtime/approval-gate.js';
import { createBufferedAsyncReplay } from './runtime/streamBuffer';
import {
  createAgencyProvenanceRecorder,
  type AgencyProvenanceRecorder,
  type AgencyProvenanceTrail,
} from './agency-provenance.js';

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Creates a multi-agent agency that coordinates a named roster of sub-agents
 * using the specified orchestration strategy.
 *
 * The agency validates configuration immediately and throws an
 * {@link AgencyConfigError} on any structural problem so issues surface at
 * wiring time rather than the first call.
 *
 * With a `modelPool` or `strategy: 'panel'`, every call is guarded, seated
 * and masked: a per-call option that would move every seat off its seating is
 * refused, the roster is seated from the pool, and no credential the call can
 * send reaches a record, a thrown error or a callback.
 *
 * @param opts - Full agency configuration including the `agents` roster, optional
 *   `strategy`, `controls`, `hitl`, and `observability` settings.
 * @returns An {@link AgencyInstance} whose `generate` / `stream` / `session` methods
 *   invoke the compiled strategy over the configured sub-agents; `generate()`
 *   resolves to a {@link PanelResult} for a `panel` agency.
 * @throws {AgencyConfigError} When the configuration is structurally invalid
 *   (e.g. no agents defined, emergent enabled without hierarchical strategy,
 *   HITL approvals configured without a handler, parallel/debate without a
 *   synthesis model).
 * @throws {AgencyPanelError} For a `panel` whose roster names a seat `'chair'`.
 *
 * @category Core
 */
export function agency(opts: AgencyOptions & { strategy: 'panel' }): AgencyInstance<PanelResult>;
/**
 * Creates a multi-agent agency: the same factory, for any strategy. See the
 * overload above for what it validates and returns.
 *
 * @param opts - Full agency configuration.
 * @returns An {@link AgencyInstance} whose `generate()` resolves to an {@link AgencyResult}.
 * @throws {AgencyConfigError} When the configuration is structurally invalid.
 * @throws {AgencyPanelError} For a `panel` whose roster names a seat `'chair'`.
 */
export function agency(opts: AgencyOptions): AgencyInstance;
export function agency(opts: AgencyOptions): AgencyInstance {
  // 1. Validate options — throw early on bad configuration.
  validateAgencyOptions(opts);

  /*
   * The cognitive mechanisms run inside a CognitiveMemoryManager, which the
   * lightweight agency() never constructs, and agency-level config is not
   * forwarded to roster members. Say so instead of accepting it silently.
   */
  if (opts.cognitiveMechanisms != null) {
    console.warn(
      '[AgentOS] agency() accepted a cognitiveMechanisms config, but the lightweight helper does not run ' +
      'the cognitive mechanisms. Initialize a CognitiveMemoryManager with `cognitiveMechanisms`, or supply ' +
      'one through gmiManagerConfig.cognitiveMemoryFactory on the full runtime, to use them.',
    );
  }

  // 2. Compile the orchestration strategy into an executable CompiledStrategy.
  //    When `adaptive` is true the strategy dispatcher wraps the chosen strategy
  //    with an implicit hierarchical manager.
  //    Auto-detect 'graph' when any sub-agent declares `dependsOn`.
  //    `hitl.approvals.beforeTool` is not copied into the roster: it is
  //    enforced per call by the approval gate (see buildCallOptions below).
  const hasDependsOn = Object.values(opts.agents).some(
    (a) => !isAgent(a) && Array.isArray((a as BaseAgentConfig).dependsOn) && (a as BaseAgentConfig).dependsOn!.length > 0,
  );
  const chosenStrategy = opts.adaptive
    ? 'hierarchical'
    : (opts.strategy ?? (hasDependsOn ? 'graph' : 'sequential'));
  const isPanel = chosenStrategy === 'panel';
  // A pool, a panel or a pool-only option: checked here, and every call is
  // guarded, seated and masked. After the check, such an agency has a pool or
  // is a panel.
  const pooled = hasPoolSurface(opts, chosenStrategy);
  if (pooled) validatePoolOptions(opts, chosenStrategy);

  // The construction-time compile stays for every agency, over the roster as
  // written: it reports a graph cycle, a one-seat review-loop and a manager
  // without a model now, not at the first call. An agency with a pool or a
  // panel compiles again for every call, over that call's seating.
  const strategy: CompiledStrategy = compileStrategy(
    chosenStrategy,
    opts.agents,
    opts,
  );
  const seatingState: SeatingState | undefined = pooled ? createSeatingState(opts, chosenStrategy) : undefined;

  // 3. Extract resource controls (may be undefined).
  const controls: ResourceControls | undefined = opts.controls;
  const agencyName = opts.name ?? '__agency__';
  const agencyUsage: UsageTotals = emptyUsageTotals();

  // 3a. No credential in any record. In an agency with a pool or a panel, an
  //     error that leaves a seat or this agency, and a string of a result
  //     that a seat's loops could not mask, passes through a mask built from
  //     every credential the agency's calls can send. Each seating adds that
  //     call's list to the lists before it, so overlapping calls never unmask
  //     each other's errors; the mask reads the list when it runs.
  const secretsHolder: { list: readonly string[] } = { list: [] };
  /** An error masked in place where its strings can be written (its class and shape stay), else a masked plain Error. */
  const mask = createErrorMask(secretsHolder);
  /** A masked stand-in that never writes `error`: for an error someone else owns, a HITL handler's. */
  const maskedCopy = (error: unknown): unknown => (pooled ? maskedCopyOf(error, secretsHolder.list) : error);
  const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));
  /** Runs one of this agency's own callbacks: a callback that throws is logged and never fails the call. */
  const fire = (call: () => void): void => {
    try {
      call();
    } catch (err) {
      console.warn('[AgentOS][Agency] callback threw:', err);
    }
  };

  // 3b. Provenance recorder (in-memory event trail with optional hash chain).
  //     Hooks into opts.on so every callback the runtime fires is also written
  //     to the trail without invasive changes to strategy dispatchers. For
  //     stronger cryptographic provenance with anchored signed events, use
  //     `createProvenancePack` at the AgentOS runtime layer instead.
  const provenanceRecorder: AgencyProvenanceRecorder | undefined =
    opts.provenance?.enabled === true
      ? createAgencyProvenanceRecorder(opts.provenance)
      : undefined;
  if (provenanceRecorder) {
    opts = { ...opts, on: provenanceRecorder.wrapCallbacks(opts.on) };
  }
  // 3c. In an agency with a pool or a panel, an error event that a strategy,
  //     a gate or this agency fires carries a masked error before the trail
  //     and the caller's handler see it. The stand-in never writes the error
  //     it is given: a HITL handler's error stays as the handler made it.
  if (pooled && opts.on?.error) {
    const on = opts.on;
    opts = {
      ...opts,
      on: {
        ...on,
        error: (event: { agent: string; error: Error; timestamp: number }) =>
          on.error?.({ ...event, error: toError(maskedCopy(event.error)) }),
      },
    };
  }

  // 4. In-memory session store keyed by session ID.
  const sessions = new Map<string, AgencySession>();
  const sessionUsage = new Map<string, UsageTotals>();

  // 5. Tool-approval gate. It exists only when `beforeTool` is listed (the
  //    handler's presence was checked by validateAgencyOptions); each call
  //    gets its own gate and slot. Under panel each seat and the chair get a
  //    gate and a slot of their own, built by the strategy, and the call
  //    forwards only a gate it received.
  const gateEnabled = (opts.hitl?.approvals?.beforeTool?.length ?? 0) > 0;
  const ownGate = gateEnabled && !isPanel;

  /**
   * The per-call options the strategy receives: the caller's, with
   * `__approvalGate` set after them when a gate exists (this agency's own,
   * composed with one received from a parent agency, or the received one
   * alone), so nothing a caller passes can remove or replace it. With no gate
   * to set, the caller's options pass through unchanged.
   */
  const buildCallOptions = (
    execOpts: Record<string, unknown> | undefined,
    slot: ApprovalSlot,
  ): Record<string, unknown> | undefined => {
    const received = composeReceivedGate(execOpts?.__approvalGate);
    if (!ownGate && received === execOpts?.__approvalGate) return execOpts;
    const callOpts: Record<string, unknown> = { ...execOpts };
    delete callOpts.__approvalGate;
    const gate = ownGate
      ? createApprovalGate({ hitl: opts.hitl!, agentName: agencyName, on: opts.on, slot, received })
      : received;
    if (gate) callOpts.__approvalGate = gate;
    return callOpts;
  };

  /**
   * How one call reports and rejects. Every error is masked once per call, so
   * `on.error`, the stream's members and every rejection carry the same
   * object; in an agency with a pool or a panel, the slot's error leaves as a
   * masked copy, and the handler's own object is left as it is.
   */
  const callErrors = (slot: ApprovalSlot) => {
    const maskedOnce = new WeakMap<object, unknown>();
    let slotCopy: { value: unknown } | undefined;
    /** The slot's error as the call rejects with it. */
    const slotRejection = (): unknown => {
      if (!slotCopy) slotCopy = { value: maskedCopy(slot.error) };
      return slotCopy.value;
    };
    /** An error other than the slot's, masked the first time it is seen. */
    const maskOnce = (error: unknown): unknown => {
      if (!pooled) return error;
      if (error === null || typeof error !== 'object') return mask(error);
      if (!maskedOnce.has(error)) maskedOnce.set(error, mask(error));
      return maskedOnce.get(error);
    };
    return {
      maskOnce,
      slotRejection,
      /** The error a call takes from its slot, raw or as its masked copy: the gate already reported it to `on.error`. */
      isSlotError: (error: unknown): boolean =>
        slot.error !== undefined && (error === slot.error || error === slotRejection()),
      /**
       * The error a failed call rejects with. Once a tool approval has failed,
       * a later failure (a seat's own error, a `beforeAgent` handler that
       * throws) does not replace it: the call rejects with the approval error,
       * which the gate reported, and the later one goes to `on.error` from the
       * catch that receives it.
       */
      rejectionOf: (error: unknown): unknown => (slot.error !== undefined ? slotRejection() : maskOnce(error)),
    };
  };

  /**
   * Seats the roster for one call and compiles the strategy over it. Throws
   * `AgencySeatingError` before any model is called; a failed seating commits
   * nothing. Without a pool or a panel, the construction-time strategy.
   */
  const seatForCall = (
    callOpts: Record<string, unknown> | undefined,
  ): { strategy: CompiledStrategy; seated?: SeatedRoster } => {
    if (!seatingState) return { strategy };
    const seated = seatRoster(opts, seatingState, chosenStrategy, callOpts, mask);
    secretsHolder.list = [...new Set([...secretsHolder.list, ...collectCallSecrets(opts, seated.secrets)])]
      .sort((a, b) => b.length - a.length);
    seated.commit();
    return { strategy: compileStrategy(chosenStrategy, seated.roster, opts, seated), seated };
  };

  /** Adds usage to the agency's and the session's totals. */
  const billUsage = (usage: unknown, sessionId?: string): void => {
    const totals = normalizeUsage(usage);
    addUsageTotals(agencyUsage, totals);
    if (sessionId) {
      addUsageTotals(getSessionUsage(sessionUsage, sessionId), totals);
    }
  };

  /** A panel's ledger error carries the usage of every call that returned before the failure: it is billed before the call rejects. */
  const billLedger = (error: unknown, sessionId?: string): void => {
    if ((error instanceof AgencyQuorumError || error instanceof AgencyPanelError) && error.usage) {
      billUsage(error.usage, sessionId);
    }
  };

  type FinalizedExecutionResult = Record<string, unknown> & {
    text?: string;
    usage?: unknown;
    parsed?: unknown;
  };

  const prepareExecutionPrompt = async (prompt: string): Promise<string> => {
    const guardConfig = normalizeGuardrails(opts.guardrails);
    const inputGuards = guardConfig?.input ?? [];

    let preparedPrompt = prompt;
    if (inputGuards.length) {
      preparedPrompt = await runGuardrails(preparedPrompt, inputGuards, 'input', opts.on);
    }

    if (opts.rag) {
      preparedPrompt = await injectRagContext(preparedPrompt, opts.rag);
    }

    if (opts.output) {
      preparedPrompt = appendSchemaHint(preparedPrompt, opts.output);
    }

    if (controls) {
      checkLimits(controls, { usage: agencyUsage }, 0, opts.on);
    }

    return preparedPrompt;
  };

  const finalizeExecutionResult = async (
    result: Record<string, unknown>,
    start: number,
    sessionId?: string,
    streamPartBuffer?: AgencyStreamPart[],
    seated?: SeatedRoster,
  ): Promise<FinalizedExecutionResult> => {
    const guardConfig = normalizeGuardrails(opts.guardrails);
    const outputGuards = guardConfig?.output ?? [];
    const finalized: FinalizedExecutionResult = { ...result };
    const elapsedMs = Date.now() - start;

    // A result always carries a text: sequential and graph return none when
    // every seat was rejected.
    if (typeof finalized.text !== 'string') finalized.text = '';
    // The ledger describes the agency that returns it. sequential and graph
    // spread their last seat's result into their own, so a nested panel's
    // seats, chair, quorum and seating are removed from any result that is
    // not this agency's own panel run, and this agency's seating is attached.
    // A nested agency's provenance trail is that agency's own record, which
    // accumulates across its calls with raw strings: it is dropped, never
    // rewritten, and this agency attaches its own trail below.
    if (!isPanel) {
      delete finalized.seats;
      delete finalized.chair;
      delete finalized.quorum;
      delete finalized.seating;
    }
    delete finalized.provenanceTrail;
    if (seated) finalized.seating = seated.record;
    if (pooled) {
      // What the seats' own loops cannot mask: a pre-built seat's or a nested
      // agency's tool errors, conversation delta and tool calls come back raw.
      const secrets = secretsHolder.list;
      if (Array.isArray(finalized.agentCalls)) {
        finalized.agentCalls = (finalized.agentCalls as AgentCallRecord[]).map((call) =>
          call && Array.isArray(call.toolCalls) && call.toolCalls.some((t) => typeof t?.error === 'string')
            ? {
                ...call,
                toolCalls: call.toolCalls.map((t) => {
                  const error = t?.error;
                  return typeof error === 'string' ? { ...t, error: redactText(error, secrets) } : t;
                }),
              }
            : call,
        );
      }
      if (finalized.transcriptDelta !== undefined) {
        finalized.transcriptDelta = redactStrings(finalized.transcriptDelta, secrets);
      }
      if (Array.isArray(finalized.toolCalls)) {
        finalized.toolCalls = redactStrings(finalized.toolCalls, secrets);
      }
    }

    if (outputGuards.length) {
      finalized.text = await runGuardrails(finalized.text as string, outputGuards, 'output', opts.on);
    }

    if (opts.output) {
      finalized.parsed = parseStructuredOutput(finalized.text as string, opts.output);
    }

    // A run's usage is counted before the limits are checked, so a run that
    // itself breaches a limit is billed and the next call's pre-check sees it.
    const resultUsage = normalizeUsage(finalized.usage);
    finalized.usage = resultUsage;
    billUsage(resultUsage, sessionId);

    if (controls) {
      checkLimits(controls, finalized, elapsedMs, opts.on);
    }

    const approvedResult = await maybeApproveFinalResult(
      opts,
      agencyName,
      finalized,
      elapsedMs,
      streamPartBuffer
        ? (part) => {
            streamPartBuffer.push(part);
          }
        : undefined,
    );

    streamPartBuffer?.push({
      type: 'final-output',
      text: (approvedResult.text as string) ?? '',
      usage: normalizeUsage(approvedResult.usage),
      agentCalls: ((approvedResult.agentCalls as AgentCallRecord[] | undefined) ?? []),
      parsed: approvedResult.parsed,
      durationMs: elapsedMs,
      ...(approvedResult.seating ? { seating: approvedResult.seating as SeatingRecord } : {}),
      ...(isPanel
        ? {
            seats: approvedResult.seats as PanelSeatRecord[] | undefined,
            chair: approvedResult.chair as PanelSeatRecord | undefined,
            quorum: approvedResult.quorum as PanelQuorumRecord | undefined,
          }
        : {}),
    });

    fire(() => opts.on?.agentEnd?.({
      agent: agencyName,
      output: (approvedResult.text as string) ?? '',
      durationMs: elapsedMs,
      timestamp: Date.now(),
    }));

    // Seal the provenance trail with the final output and attach to result.
    // The recorder has already observed every callback that fired during the
    // run; the final-output event closes the chain.
    if (provenanceRecorder) {
      provenanceRecorder.recordFinalOutput({
        agencyName,
        text: typeof approvedResult.text === 'string' ? approvedResult.text : '',
        durationMs: elapsedMs,
        agentCallCount:
          Array.isArray(approvedResult.agentCalls) ? approvedResult.agentCalls.length : 0,
        usage: approvedResult.usage,
      });
      (approvedResult as Record<string, unknown>).provenanceTrail =
        provenanceRecorder.getTrail();
    }

    return approvedResult;
  };

  // ---------------------------------------------------------------------------
  // Shared execute wrapper — applies resource limit checks and fires callbacks.
  // ---------------------------------------------------------------------------

  /**
   * Execute the compiled strategy for a given prompt, then check resource
   * limits and fire lifecycle callbacks.
   *
   * @param prompt - User-facing prompt text.
   * @param execOpts - Optional per-call overrides forwarded to the strategy.
   * @returns The raw strategy result object (includes `text`, `agentCalls`, `usage`).
   */
  const wrappedExecute = async (
    prompt: string,
    execOpts?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>> => {
    // A pooled or panel agency refuses a per-call option that would move every
    // seat off its seating: generate() rejects before anything runs.
    if (pooled) guardPerCallOptions(execOpts, isPanel ? 'panel' : 'pool');
    const start = Date.now();
    const slot = createApprovalSlot();
    const callOpts = buildCallOptions(execOpts, slot);
    const errors = callErrors(slot);
    fire(() => opts.on?.agentStart?.({
      agent: agencyName,
      input: prompt,
      timestamp: start,
    }));

    try {
      const preparedPrompt = await prepareExecutionPrompt(prompt);
      // Seated once per call: a validation retry runs on the same seating.
      const { strategy: strategyForCall, seated } = seatForCall(callOpts);

      // Validation retry loop — when `opts.output` is a Zod schema and the
      // LLM returns unparseable/invalid text, retry with the previous error
      // appended to the prompt so the model can self-correct.
      const maxValidationRetries = controls?.maxValidationRetries ?? 1;
      const hasValidation = !!opts.output;

      let currentPrompt = preparedPrompt;
      let lastFinalized: FinalizedExecutionResult | null = null;

      const maxAttempts = hasValidation ? maxValidationRetries + 1 : 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = (await strategyForCall.execute(currentPrompt, callOpts)) as Record<string, unknown>;
        if (slot.error !== undefined) {
          // A handler error or an 'error' timeout inside a tool loop: the run
          // is billed and the call rejects with the handler's own error (in
          // an agency with a pool, a masked copy of it), before any
          // finalization step and before a validation retry.
          slot.settled = true;
          billUsage(result.usage, sessionId);
          throw slot.error;
        }
        const finalized = await finalizeExecutionResult(result, start, sessionId, undefined, seated);
        lastFinalized = finalized;

        // Success path: no validation required, OR validation produced a `parsed` value
        if (!hasValidation || finalized.parsed !== undefined) {
          slot.settled = true;
          return finalized;
        }

        // Validation failed. If more attempts remain, retry with error feedback.
        if (attempt < maxAttempts) {
          const textPreview = typeof finalized.text === 'string'
            ? finalized.text.slice(0, 200)
            : '(no text)';
          currentPrompt = `${preparedPrompt}\n\nPrevious attempt failed to return valid JSON matching the schema. Response was: ${textPreview}\n\nReturn ONLY a single valid JSON object matching the schema. No markdown code fences. No commentary before or after. Start with { and end with }.`;
          continue;
        }
      }

      // All attempts exhausted — return the last result (parsed will be undefined).
      slot.settled = true;
      return lastFinalized!;
    } catch (error) {
      slot.settled = true;
      billLedger(error, sessionId);
      // The slot's error was reported by the gate that stored it; any other
      // error is reported here, masked, as the call rejects with it.
      if (!errors.isSlotError(error)) {
        fire(() => opts.on?.error?.({
          agent: agencyName,
          error: toError(errors.maskOnce(error)),
          timestamp: Date.now(),
        }));
      }
      throw errors.rejectionOf(error);
    }
  };

  const createStreamResult = (
    prompt: string,
    streamOpts?: Record<string, unknown>,
    sessionId?: string,
  ): AgencyStreamResult & { result: Promise<AgencyResult> } => {
    const start = Date.now();
    const slot = createApprovalSlot();
    const callOpts = buildCallOptions(streamOpts, slot);
    const errors = callErrors(slot);
    let errorReported = false;
    const postStreamParts: AgencyStreamPart[] = [];
    // The call's seating, once the deferred stream has seated the roster.
    const seatedRef: { seated?: SeatedRoster } = {};

    /**
     * Reports a failure to `on.error` once per call, masked, and returns what
     * the caller rethrows. The slot's error was reported by the gate that
     * stored it, and leaves as its masked copy.
     */
    const reportError = (error: unknown): unknown => {
      if (errors.isSlotError(error)) return errors.slotRejection();
      const masked = errors.maskOnce(error);
      if (!errorReported) {
        errorReported = true;
        fire(() => opts.on?.error?.({
          agent: agencyName,
          error: toError(masked),
          timestamp: Date.now(),
        }));
      }
      return masked;
    };

    fire(() => opts.on?.agentStart?.({
      agent: agencyName,
      input: prompt,
      timestamp: start,
    }));

    const deferredStream = (async () => {
      const preparedPrompt = await prepareExecutionPrompt(prompt);
      // Under stream() a seating error rejects the stream's promises, as a strategy error does.
      const { strategy: strategyForCall, seated } = seatForCall(callOpts);
      seatedRef.seated = seated;
      const streamResult = strategyForCall.stream(preparedPrompt, callOpts) as CompiledStrategyStreamResult;
      // The text is read from the strategy's parts, and its own text promise
      // only when it streams none. That promise rejects when the strategy
      // fails (a beforeAgent handler that throws ends the sequential stream),
      // so it is marked handled here, and the failure is reported once,
      // through the parts. A strategy's whole result is read only by the
      // finalized result, after the parts.
      void Promise.resolve(streamResult.text).catch(() => undefined);
      void Promise.resolve(streamResult.result).catch(() => undefined);
      return streamResult;
    })();

    const rawPartReplay = createBufferedAsyncReplay<AgencyStreamPart>((async function* () {
      const streamResult = await deferredStream;

      if (streamResult.fullStream) {
        // A strategy's error parts (a pre-built seat's, a sequential seat's)
        // leave masked in an agency with a pool or a panel.
        for await (const part of streamResult.fullStream) {
          yield part.type === 'error' && pooled ? { ...part, error: toError(errors.maskOnce(part.error)) } : part;
        }
        return;
      }

      if (streamResult.textStream) {
        for await (const chunk of streamResult.textStream) {
          yield { type: 'text', text: chunk };
        }
        return;
      }

      if (streamResult.text) {
        const fullText = await streamResult.text;
        if (fullText) {
          yield { type: 'text', text: fullText };
        }
      }
    })());

    const ensureDraining = async (): Promise<void> => {
      try {
        await rawPartReplay.ensureDraining();
      } catch (error) {
        throw reportError(error);
      }
    };

    const resolvedTextPromise: Promise<string> = (async () => {
      await ensureDraining();
      const bufferedText = rawPartReplay
        .getBuffered()
        .filter((part): part is { type: 'text'; text: string; agent?: string } => part.type === 'text')
        .map((part) => part.text)
        .join('');
      if (bufferedText) return bufferedText;

      const streamResult = await deferredStream;
      return streamResult.text ? await streamResult.text : '';
    })();

    const resolvedUsagePromise: Promise<unknown> = (async () => {
      const streamResult = await deferredStream;
      if (streamResult.usage) {
        return await streamResult.usage;
      }

      await ensureDraining();
      return emptyUsageTotals();
    })();

    const resolvedAgentCallsPromise: Promise<unknown> = (async () => {
      const streamResult = await deferredStream;
      if (streamResult.agentCalls) {
        return await streamResult.agentCalls;
      }
      return [];
    })();

    const finalizedResultPromise: Promise<FinalizedExecutionResult> = (async () => {
      try {
        const [text, usage, agentCalls] = await Promise.all([
          resolvedTextPromise,
          resolvedUsagePromise,
          resolvedAgentCallsPromise,
        ]);

        // A strategy with more than text, usage and agent calls (a panel's
        // ledger) resolves its whole result, which finalization reads.
        const streamResult = await deferredStream;
        const result: Record<string, unknown> = streamResult.result
          ? { ...(await streamResult.result) }
          : {
              text,
              usage,
              agentCalls: Array.isArray(agentCalls) ? agentCalls : [],
            };

        if (slot.error !== undefined) {
          // As on the generate path: billed, then rejected with the
          // handler's own error, before any finalization step.
          slot.settled = true;
          billUsage(result.usage, sessionId);
          throw slot.error;
        }
        const finalized = await finalizeExecutionResult(result, start, sessionId, postStreamParts, seatedRef.seated);
        slot.settled = true;
        return finalized;
      } catch (error) {
        slot.settled = true;
        billLedger(error, sessionId);
        reportError(error);
        throw errors.rejectionOf(error);
      }
    })();

    /**
     * A promise built from the finalized result. It still rejects for whoever
     * awaits it, but it is marked handled when created, so a caller that
     * reads only the streams never leaves a rejection unhandled.
     */
    const derived = <T>(promise: Promise<T>): Promise<T> => {
      promise.catch(() => undefined);
      return promise;
    };

    return {
      textStream: (async function* () {
        try {
          for await (const part of rawPartReplay.iterable) {
            if (part.type === 'text') {
              yield part.text;
            }
          }
        } catch (error) {
          reportError(error);
          // After a tool approval error the stream ends as below: with that
          // error, once the run has settled.
          if (slot.error !== undefined) await finalizedResultPromise.catch(() => undefined);
          throw errors.rejectionOf(error);
        }
        // A handler error or an 'error' timeout ends the call: a consumer
        // that reads only this stream gets that error here, once the run is
        // billed. fullStream ends the same way, through the finalized result.
        if (slot.error !== undefined) {
          await finalizedResultPromise.catch(() => undefined);
          throw errors.slotRejection();
        }
      })(),
      fullStream: (async function* () {
        try {
          for await (const part of rawPartReplay.iterable) {
            yield part;
          }
          const finalResult = await finalizedResultPromise;
          for (const part of postStreamParts) {
            yield part;
          }
          const allBufferedParts = [...rawPartReplay.getBuffered(), ...postStreamParts];
          const hasMatchingAgencyEnd = allBufferedParts.some(
            (part) =>
              part.type === 'agent-end' &&
              part.agent === agencyName &&
              part.output === ((finalResult.text as string) ?? ''),
          );
          if (!hasMatchingAgencyEnd) {
            yield {
              type: 'agent-end',
              agent: agencyName,
              output: (finalResult.text as string) ?? '',
              durationMs: Date.now() - start,
            };
          }
        } catch (error) {
          reportError(error);
          if (slot.error !== undefined) await finalizedResultPromise.catch(() => undefined);
          throw errors.rejectionOf(error);
        }
      })(),
      text: derived(finalizedResultPromise.then((result) => (result.text as string) ?? '')),
      usage: derived(finalizedResultPromise.then((result) => result.usage as {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        costUSD?: number;
      })),
      agentCalls: derived(finalizedResultPromise.then((result) => (result.agentCalls ?? []) as AgentCallRecord[])),
      parsed: derived(finalizedResultPromise.then((result) => result.parsed)),
      finalTextStream: (async function* () {
        const finalResult = await finalizedResultPromise;
        const finalText = (finalResult.text as string) ?? '';
        if (finalText) {
          yield finalText;
        }
      })(),
      result: finalizedResultPromise as unknown as Promise<AgencyResult>,
    };
  };

  // ---------------------------------------------------------------------------
  // Returned Agent interface
  // ---------------------------------------------------------------------------

  /**
   * Build the core agent object.  `listen` and `connect` are conditionally
   * attached below based on the presence of `opts.voice` and `opts.channels`.
   */
  const agentObj: Agent = {
    /**
     * Runs the agency's strategy for the given prompt and returns the final
     * aggregated result (non-streaming).
     *
     * @param prompt - User prompt text.
     * @param opts - Optional per-call overrides. In an agency with a pool or a
     *   panel, an option that would move every seat off its seating makes the
     *   returned promise reject with {@link AgencyConfigError}.
     * @returns The aggregated result including `text`, `agentCalls`, and `usage`.
     */
    async generate(prompt: string, generateOpts?: Record<string, unknown>): Promise<unknown> {
      return wrappedExecute(prompt, generateOpts);
    },

    /**
     * Streams the strategy execution.  For strategies that do not natively
     * support token-by-token streaming, the full result is buffered and emitted
     * as a single text chunk.
     *
     * @param prompt - User prompt text.
     * @param streamOpts - Optional per-call overrides. In an agency with a pool
     *   or a panel, an option that would move every seat off its seating throws
     *   {@link AgencyConfigError} here, before a stream object exists.
     * @returns An object with raw `textStream`, `fullStream`, awaitable `text`/`usage`
     *   promises, an awaitable `agentCalls` ledger, an awaitable `parsed` value
     *   when structured output is configured, `finalTextStream` for the
     *   finalized post-processing text, and `result`, the finalized result
     *   with its ledger.
     */
    stream(prompt: string, streamOpts?: Record<string, unknown>): AgencyStreamResult {
      if (pooled) guardPerCallOptions(streamOpts, isPanel ? 'panel' : 'pool');
      return createStreamResult(prompt, streamOpts);
    },

    /**
     * Returns (or creates) a named conversation session backed by the agency's
     * strategy.  Each session maintains its own ordered message history.
     *
     * @param id - Optional stable session ID; auto-generated via `crypto.randomUUID()`
     *   when omitted.
     * @returns The session object for the given ID.
     */
    session(id?: string): unknown {
      const sessionId = id ?? crypto.randomUUID();
      if (!sessions.has(sessionId)) {
        /** Per-session message history as simple role/content pairs. */
        const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

        const sessionObj: AgencySession = {
          id: sessionId,

          /**
           * Sends a user message through the agency strategy and appends both
           * turns to session history.
           *
           * @param text - User message text.
           * @returns The aggregated strategy result.
           */
          async send(text: string): Promise<unknown> {
            history.push({ role: 'user', content: text });
            const result = await wrappedExecute(
              buildSessionPrompt(history.slice(0, -1), text),
              undefined,
              sessionId,
            );
            history.push({ role: 'assistant', content: (result.text as string) ?? '' });
            return result;
          },

          /**
           * Streams a user message through the agency strategy, feeding prior
           * conversation history into the prompt — matching the behaviour of
           * `session.send()`.  The assistant turn is appended to history once
           * the full streamed text is resolved.
           *
           * @param text - User message text.
           * @returns A streaming result compatible with `StreamTextResult`.
           */
          stream(text: string): unknown {
            // Push the user turn before building the prompt so the prior
            // history (everything before the new turn) is included.
            history.push({ role: 'user', content: text });
            const fullPrompt = buildSessionPrompt(history.slice(0, -1), text);
            const streamResult = createStreamResult(fullPrompt, undefined, sessionId) as {
              text: Promise<string>;
              textStream: AsyncIterable<string>;
              fullStream: AsyncIterable<AgencyStreamPart>;
              usage: Promise<unknown>;
            };

            // Append the assistant reply to history once streaming resolves.
            streamResult.text.then((assistantText) => {
              history.push({ role: 'assistant', content: assistantText });
            }).catch(() => {
              // Ignore resolution failures — history will just lack this turn.
            });

            return streamResult;
          },

          /** Returns a snapshot of the session's conversation history. */
          messages(): Array<{ role: 'user' | 'assistant'; content: string }> {
            return [...history];
          },

          /**
           * Returns stub usage totals for this session.
           * Real per-session accounting requires a usage ledger — see `AgentOptions.usageLedger`.
           */
          async usage(): Promise<{ promptTokens: number; completionTokens: number; totalTokens: number; costUSD?: number }> {
            return { ...getSessionUsage(sessionUsage, sessionId) };
          },

          /** Clears all messages from this session's history. */
          clear(): void {
            history.length = 0;
          },
        };

        sessions.set(sessionId, sessionObj);
      }

      return sessions.get(sessionId);
    },

    /**
     * Returns stub cumulative usage totals for the agency.
     * Real accounting requires a usage ledger — see `AgentOptions.usageLedger`.
     */
    async usage(sessionId?: string): Promise<{ promptTokens: number; completionTokens: number; totalTokens: number; costUSD?: number }> {
      return sessionId
        ? { ...getSessionUsage(sessionUsage, sessionId) }
        : { ...agencyUsage };
    },

    /**
     * Tears down all sessions and closes any pre-built `Agent` instances passed
     * in `opts.agents`.
     */
    async close(): Promise<void> {
      sessions.clear();
      // Gracefully close any pre-built Agent instances in the roster.
      for (const agentOrConfig of Object.values(opts.agents)) {
        if (isAgent(agentOrConfig)) {
          await agentOrConfig.close?.();
        }
      }
    },

    /**
     * Exports this agency's configuration as a portable object.
     * @param metadata - Optional human-readable metadata to attach.
     * @param options - Redaction options; secrets are redacted unless `redactSecrets` is `false`.
     * @returns A portable {@link AgentExportConfig} object.
     */
    export(metadata?: AgentExportConfig['metadata'], options?: ExportAgentConfigOptions): AgentExportConfig {
      return exportAgentConfig(agentObj, metadata, options);
    },

    /**
     * Exports this agency's configuration as a pretty-printed JSON string.
     * @param metadata - Optional human-readable metadata to attach.
     * @param options - Redaction options; secrets are redacted unless `redactSecrets` is `false`.
     * @returns JSON string with 2-space indentation.
     */
    exportJSON(metadata?: AgentExportConfig['metadata'], options?: ExportAgentConfigOptions): string {
      return exportAgentConfigJSON(agentObj, metadata, options);
    },
  };

  // Stash the original config as non-enumerable properties so that
  // exportAgentConfig() can retrieve them without polluting the public API.
  Object.defineProperty(agentObj, '__config', {
    value: opts,
    enumerable: false,
    configurable: true,
  });

  // Separate stash for agency-specific fields (sub-agent roster, strategy).
  // Needed by the export system to distinguish agency from single agent.
  const agencySubAgentConfigs: Record<string, BaseAgentConfig | { prebuilt: true }> = {};
  for (const [name, agentOrConfig] of Object.entries(opts.agents)) {
    if (isAgent(agentOrConfig)) {
      // A pre-built agent carries no exportable config; import refuses the marker.
      agencySubAgentConfigs[name] = { prebuilt: true };
    } else {
      agencySubAgentConfigs[name] = agentOrConfig as BaseAgentConfig;
    }
  }
  Object.defineProperty(agentObj, '__agencyConfig', {
    value: {
      agents: agencySubAgentConfigs,
      strategy: opts.strategy,
      adaptive: opts.adaptive,
      maxRounds: opts.maxRounds,
    },
    enumerable: false,
    configurable: true,
  });

  // ---------------------------------------------------------------------------
  // listen() — voice WebSocket transport
  // ---------------------------------------------------------------------------

  /**
   * When `opts.voice.enabled` is set, attach a `listen()` method that starts a
   * local WebSocket server and exposes a port for real-time audio I/O.
   *
   * The WebSocket server acts as the transport layer; on each incoming connection
   * the audio bytes are bridged to the agency via `generate()` / `session()` once
   * a full-pipeline STT+TTS integration is in place.  For v1 the connection
   * handler is a no-op stub, establishing the port and URL surface so callers
   * can integrate their own audio transport.
   *
   * Dynamic import of `ws` keeps voice entirely optional — if the package is
   * not installed the error message tells the caller exactly what to install.
   * The `@vite-ignore` keeps bundlers/vitest from trying to statically resolve
   * the optional, possibly-uninstalled `ws` package at transform time (which
   * otherwise surfaces as a "Failed to load url ws" load error in test runs).
   */
  if (opts.voice?.enabled) {
    agentObj.listen = async (listenOpts?: { port?: number }): Promise<{ port: number; url: string; close: () => Promise<void> }> => {
      try {
        const ws = await import(/* @vite-ignore */ 'ws');
        const WebSocketServer = (ws as any).WebSocketServer ?? ws.default?.Server ?? ws.Server;
        const port = listenOpts?.port ?? 0;

        const wss = new WebSocketServer({ port, host: '127.0.0.1' });
        await new Promise<void>((resolve) => wss.on('listening', resolve));
        const address = wss.address() as { port: number } | null;
        const actualPort = address?.port ?? port;

        /**
         * Connection handler: each WebSocket client is a voice session.
         * Bridges audio frames through the voice pipeline (STT → LLM → TTS)
         * when the voice-pipeline module is available, otherwise logs a warning.
         */
        wss.on('connection', async (ws: any) => {
          // Voice pipeline stub — STT/TTS bridging requires a full AudioProcessor
          // + speech provider setup. For now, accept text frames via JSON and
          // route them through the agent's generate() method.
          ws.on('message', async (data: Buffer) => {
            try {
              const msg = JSON.parse(data.toString());
              if (msg.text) {
                const result = await agentObj.generate(msg.text);
                const text = typeof result === 'string' ? result : (result as any)?.text ?? '';
                ws.send(JSON.stringify({ text }));
              }
            } catch {
              ws.send(JSON.stringify({ error: 'Invalid message format. Send JSON: { "text": "..." }' }));
            }
          });
        });

        return {
          port: actualPort,
          url: `ws://127.0.0.1:${actualPort}`,
          close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
        };
      } catch {
        throw new Error(
          'Voice transport requires the ws package. Install with: npm install ws',
        );
      }
    };
  }

  // ---------------------------------------------------------------------------
  // connect() — channel adapter wiring
  // ---------------------------------------------------------------------------

  /**
   * When `opts.channels` names at least one channel, attach a `connect()`
   * method so the surface matches the full runtime. The lightweight
   * `agency()` constructs no channel adapters: `connect()` rejects with the
   * configured channel names instead of logging as if it had connected.
   * Channel wiring is done with `ChannelRouter` and the adapters in
   * `src/io/channels/`, standalone or inside the full runtime; this method
   * never does it.
   */
  const channelNames = Object.keys(opts.channels ?? {});
  if (channelNames.length > 0) {
    agentObj.connect = async (): Promise<void> => {
      throw new Error(
        `agency().connect() cannot connect ${channelNames.map((name) => `"${name}"`).join(', ')}: ` +
          'the lightweight agency() helper constructs no channel adapters, and this method always rejects. ' +
          'Wire channels with ChannelRouter and the adapters in src/io/channels (the Channels guide shows the ' +
          'standalone form), or run the full AgentOS runtime with its messaging-channel extension packs.',
      );
    };
  }

  // generate() resolves the finalized result and stream() carries `result`:
  // the types.ts Agent surface, with the result types AgencyInstance names.
  return agentObj as unknown as AgencyInstance;
}

// ---------------------------------------------------------------------------
// Internal session shape (not exported — callers receive `unknown`)
// ---------------------------------------------------------------------------

/** Internal shape for per-agency session state. */
interface AgencySession {
  readonly id: string;
  send(text: string): Promise<unknown>;
  stream(text: string): unknown;
  messages(): Array<{ role: 'user' | 'assistant'; content: string }>;
  usage(): Promise<{ promptTokens: number; completionTokens: number; totalTokens: number; costUSD?: number }>;
  clear(): void;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates {@link AgencyOptions} and throws {@link AgencyConfigError} when a
 * structural problem is detected.
 *
 * Checks performed:
 * - At least one agent must be defined in `opts.agents`.
 * - `emergent.enabled` requires `strategy === "hierarchical"` or `adaptive: true`.
 * - HITL approvals require a `handler` to be configured.
 * - `strategy: 'panel'` cannot be combined with `adaptive: true`.
 * - `parallel` and `debate` strategies require an agency-level `model` or `provider`
 *   for their synthesis step.
 *
 * An agency with a pool or a panel is checked further by `validatePoolOptions`.
 *
 * @param opts - The agency options to validate.
 * @throws {AgencyConfigError} On the first validation failure encountered.
 */
function validateAgencyOptions(opts: AgencyOptions): void {
  if (!opts.agents || Object.keys(opts.agents).length === 0) {
    throw new AgencyConfigError('agency() requires at least one agent in the agents roster');
  }

  if (opts.emergent?.enabled && opts.strategy !== 'hierarchical' && !opts.adaptive) {
    throw new AgencyConfigError(
      'emergent.enabled requires strategy "hierarchical" or adaptive: true',
    );
  }

  // If any HITL approval trigger is set, a handler must be provided.
  const approvals = opts.hitl?.approvals;
  const hasApprovalTrigger =
    approvals &&
    (
      (Array.isArray(approvals.beforeTool) && approvals.beforeTool.length > 0) ||
      (Array.isArray(approvals.beforeAgent) && approvals.beforeAgent.length > 0) ||
      approvals.beforeEmergent === true ||
      approvals.beforeReturn === true ||
      approvals.beforeStrategyOverride === true
    );

  if (hasApprovalTrigger && !opts.hitl?.handler) {
    throw new AgencyConfigError('HITL approvals configured but no handler provided');
  }

  // adaptive replaces the strategy with hierarchical, which has no health,
  // quorum, chair or deadline. The raw option is read, for every agency, so a
  // panel without a pool surface is rejected too.
  if (opts.strategy === 'panel' && opts.adaptive) {
    throw new AgencyConfigError('strategy "panel" cannot be combined with adaptive: true');
  }

  if (opts.strategy === 'parallel' && !opts.model && !opts.provider) {
    throw new AgencyConfigError(
      'Parallel strategy requires an agency-level model or provider for synthesis',
    );
  }

  if (opts.strategy === 'debate' && !opts.model && !opts.provider) {
    throw new AgencyConfigError(
      'Debate strategy requires an agency-level model or provider for synthesis',
    );
  }
}

// ---------------------------------------------------------------------------
// Resource limit enforcement
// ---------------------------------------------------------------------------

/**
 * Checks whether the strategy result has breached any configured
 * {@link ResourceControls} limits.  Fires `callbacks.limitReached` when a
 * breach is detected, or throws {@link AgencyConfigError} when
 * `controls.onLimitReached` is `"error"`.
 *
 * @param controls - Active resource limit configuration.
 * @param result - Raw result object returned by the compiled strategy.
 * @param elapsedMs - Wall-clock milliseconds elapsed during execution.
 * @param callbacks - Optional callback map to fire `limitReached` events on.
 */
function checkLimits(
  controls: ResourceControls,
  result: Record<string, unknown>,
  elapsedMs: number,
  callbacks?: AgencyOptions['on'],
): void {
  const usage = result.usage as { totalTokens?: number; costUSD?: number } | undefined;
  const totalTokens = usage?.totalTokens ?? 0;
  const totalCostUSD = usage?.costUSD ?? 0;
  const agentCalls = result.agentCalls as unknown[] | undefined;
  const callCount = agentCalls?.length ?? 0;

  // Token limit check.
  if (controls.maxTotalTokens !== undefined && totalTokens > controls.maxTotalTokens) {
    if (controls.onLimitReached === 'error') {
      throw new AgencyConfigError(
        `Token limit exceeded: ${totalTokens} > ${controls.maxTotalTokens}`,
      );
    }
    callbacks?.limitReached?.({
      metric: 'maxTotalTokens',
      value: totalTokens,
      limit: controls.maxTotalTokens,
      timestamp: Date.now(),
    });
  }

  // Duration limit check.
  if (controls.maxDurationMs !== undefined && elapsedMs > controls.maxDurationMs) {
    if (controls.onLimitReached === 'error') {
      throw new AgencyConfigError(
        `Duration limit exceeded: ${elapsedMs}ms > ${controls.maxDurationMs}ms`,
      );
    }
    callbacks?.limitReached?.({
      metric: 'maxDurationMs',
      value: elapsedMs,
      limit: controls.maxDurationMs,
      timestamp: Date.now(),
    });
  }

  // Agent call count limit check.
  if (controls.maxAgentCalls !== undefined && callCount > controls.maxAgentCalls) {
    if (controls.onLimitReached === 'error') {
      throw new AgencyConfigError(
        `Agent call limit exceeded: ${callCount} > ${controls.maxAgentCalls}`,
      );
    }
    callbacks?.limitReached?.({
      metric: 'maxAgentCalls',
      value: callCount,
      limit: controls.maxAgentCalls,
      timestamp: Date.now(),
    });
  }

  // Cost limit check.
  if (controls.maxCostUSD !== undefined && totalCostUSD > controls.maxCostUSD) {
    if (controls.onLimitReached === 'error') {
      throw new AgencyConfigError(
        `Cost limit exceeded: ${totalCostUSD} > ${controls.maxCostUSD}`,
      );
    }
    callbacks?.limitReached?.({
      metric: 'maxCostUSD',
      value: totalCostUSD,
      limit: controls.maxCostUSD,
      timestamp: Date.now(),
    });
  }
}

type UsageTotals = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUSD?: number;
  /** Anthropic `cache_read_input_tokens`. Undefined when no source reported. */
  cacheReadTokens?: number;
  /** Anthropic `cache_creation_input_tokens`. Same undefined convention. */
  cacheCreationTokens?: number;
};

function emptyUsageTotals(): UsageTotals {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function normalizeUsage(raw: unknown): UsageTotals {
  const usage = (raw as Partial<UsageTotals> | undefined) ?? {};
  return {
    promptTokens: usage.promptTokens ?? 0,
    completionTokens: usage.completionTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    costUSD: usage.costUSD,
    // Preserve cache-token fields from the source. Undefined stays
    // undefined so consumers distinguish "not reported" from "zero".
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
  };
}

function addUsageTotals(target: UsageTotals, usage: UsageTotals): void {
  target.promptTokens += usage.promptTokens;
  target.completionTokens += usage.completionTokens;
  target.totalTokens += usage.totalTokens;
  if (typeof usage.costUSD === 'number') {
    target.costUSD = (target.costUSD ?? 0) + usage.costUSD;
  }
  if (typeof usage.cacheReadTokens === 'number') {
    target.cacheReadTokens = (target.cacheReadTokens ?? 0) + usage.cacheReadTokens;
  }
  if (typeof usage.cacheCreationTokens === 'number') {
    target.cacheCreationTokens = (target.cacheCreationTokens ?? 0) + usage.cacheCreationTokens;
  }
}

function getSessionUsage(
  usageMap: Map<string, UsageTotals>,
  sessionId: string,
): UsageTotals {
  if (!usageMap.has(sessionId)) {
    usageMap.set(sessionId, emptyUsageTotals());
  }
  return usageMap.get(sessionId)!;
}

// ---------------------------------------------------------------------------
// Guardrail helpers
// ---------------------------------------------------------------------------

/**
 * Normalizes the `guardrails` config into its structured form.
 *
 * When a plain `string[]` is supplied (backward-compat shorthand), it is
 * treated as output-only guardrails. An explicit {@link GuardrailsConfig}
 * is returned as-is.
 *
 * @param raw - The raw guardrails config value from {@link AgencyOptions}.
 * @returns A structured guardrails config, or `undefined` when not configured.
 */
function normalizeGuardrails(
  raw: AgencyOptions['guardrails'],
): { input?: string[]; output?: string[] } | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) return { output: raw };
  return raw;
}

/**
 * Runs a list of guardrail IDs against the provided text.
 *
 * Uses a dynamic import to load the guardrail infrastructure. When the
 * infrastructure is not available (the guardrail modules are not installed),
 * a warning is logged and the text is returned unmodified (fail-open).
 *
 * For v1, guardrails are evaluated synchronously in order. Each guardrail
 * ID is passed through the ParallelGuardrailDispatcher. If a guardrail
 * blocks, an error is thrown. Sanitized text is returned when applicable.
 *
 * @param text - The input or output text to evaluate.
 * @param guardIds - Guardrail identifier strings.
 * @param direction - Whether this is an `"input"` or `"output"` evaluation.
 * @param callbacks - Optional callback map for firing guardrail events.
 * @returns The (possibly sanitized) text after guardrail evaluation.
 * @throws {AgencyConfigError} When a guardrail blocks the content.
 */
async function runGuardrails(
  text: string,
  guardIds: string[],
  direction: 'input' | 'output',
  callbacks?: AgencyOptions['on'],
): Promise<string> {
  if (!guardIds.length) return text;

  try {
    const { ParallelGuardrailDispatcher: _ParallelGuardrailDispatcher, GuardrailAction: _GuardrailAction } = await import(
      '../safety/guardrails/index.js'
    );

    /*
     * Build lightweight guardrail service stubs from IDs.
     * Each stub checks the text against a simple pattern matching strategy.
     * In a full runtime, these IDs would be resolved against a guardrail
     * registry — for v1 we pass the IDs through as metadata and invoke
     * the dispatcher with any registered guardrail instances.
     */
    const sanitizedText = text;

    for (const guardId of guardIds) {
      /* Fire a guardrailResult event indicating the guard was not evaluated.
       * The guardrail registry is loaded but individual guards are not yet
       * wired — `enforced: false` signals that no actual evaluation occurred. */
      callbacks?.guardrailResult?.({
        agent: '__agency__',
        guardrailId: guardId,
        passed: true,
        enforced: false,
        action: 'allow',
        timestamp: Date.now(),
      });
    }

    return sanitizedText;
  } catch {
    /*
     * Guardrail infrastructure not available — fail open with a warning.
     * This is expected when the guardrail extension packs are not installed.
     */
    console.warn(
      `[AgentOS][Agency] Guardrail infrastructure not available; ` +
      `skipping ${direction} guardrails: [${guardIds.join(', ')}]`,
    );
    return text;
  }
}

// ---------------------------------------------------------------------------
// RAG context injection
// ---------------------------------------------------------------------------

/**
 * Injects retrieved context into the prompt when RAG is configured.
 *
 * For v1 this is a shell that accepts the {@link RagConfig} and returns the
 * prompt unmodified (no-op) when no live vector store query can be performed.
 * The infrastructure exists in `src/rag/` but initialising
 * `EmbeddingManager` + `VectorStoreManager` is a heavyweight operation best
 * suited to the full `AgentOSOrchestrator` pipeline.
 *
 * When a `ragConfig.vectorStore` is configured, delegates to `retrieveRagContext()`
 * which dynamically imports the embedding manager to embed the query and search
 * the configured vector store.  See `src/rag/IVectorStore.ts` for the query API.
 *
 * When `ragConfig.documents` is set (but a live vector store is not) an info
 * message is logged directing the caller to `AgentOSOrchestrator` for full RAG.
 *
 * @param prompt - The user prompt to augment.
 * @param ragConfig - RAG configuration from `AgencyOptions.rag`.
 * @returns The (possibly augmented) prompt string.
 */
async function injectRagContext(prompt: string, ragConfig: RagConfig): Promise<string> {
  // If a vector store is configured, attempt a live retrieval query.
  if (ragConfig.vectorStore) {
    try {
      const ragContext = await retrieveRagContext(prompt, ragConfig);
      if (ragContext) {
        return `[Retrieved context]\n${ragContext}\n\n[User query]\n${prompt}`;
      }
    } catch {
      // RAG infrastructure not available — fail open and proceed without context.
    }
  }

  // If documents are specified but no vector store query succeeded, guide the caller.
  if (ragConfig.documents && ragConfig.documents.length > 0) {
    console.info(
      '[AgentOS][Agency] RAG document loading configured — use AgentOSOrchestrator ' +
      'for full RAG pipeline with document indexing and retrieval.',
    );
  }

  return prompt;
}

/**
 * Queries the configured vector store for chunks relevant to `query`.
 *
 * Dynamically imports the embedding manager, embeds the query, and searches
 * the configured vector store for relevant chunks.
 *
 * @param query - The text to embed and search for.
 * @param ragConfig - The active RAG configuration.
 * @returns A joined context string, or `null` when retrieval is unavailable.
 */
async function retrieveRagContext(
  _query: string,
  _ragConfig: RagConfig,
): Promise<string | null> {
  // The lightweight agency() API declares vector store intent via
  // ragConfig.vectorStore.provider but does not initialise a live store.
  // Full RAG retrieval (embed → search → rerank) is handled by
  // AgentOSOrchestrator which manages EmbeddingManager + VectorStoreManager
  // lifecycle. Returning null here falls through to the no-op path in
  // injectRagContext() which logs guidance to use the full pipeline.
  return null;
}

// ---------------------------------------------------------------------------
// Structured output (Zod parsing)
// ---------------------------------------------------------------------------

/**
 * Appends a JSON schema hint to the prompt when structured output is configured.
 *
 * If the schema exposes a Zod `.shape` (for object schemas) or `.description`,
 * a human-readable description is appended. Otherwise a generic JSON instruction
 * is added to the prompt.
 *
 * @param prompt - The original prompt text.
 * @param schema - The Zod schema (typed as `unknown` to avoid a hard zod dep).
 * @returns The prompt with the schema hint appended.
 */
function appendSchemaHint(prompt: string, schema: unknown): string {
  const zodSchema = schema as { shape?: Record<string, unknown>; description?: string };
  let schemaDescription = '';

  if (zodSchema?.shape) {
    const keys = Object.keys(zodSchema.shape);
    schemaDescription = `an object with keys: ${keys.join(', ')}`;
  } else if (zodSchema?.description) {
    schemaDescription = zodSchema.description;
  }

  const hint = schemaDescription
    ? `\n\nRespond with valid JSON matching this schema: ${schemaDescription}. Output only the JSON object, no additional text.`
    : '\n\nRespond with valid JSON. Output only the JSON object, no additional text.';

  return prompt + hint;
}

/**
 * Attempts to parse the result text as JSON and validate it against a Zod
 * schema provided via `opts.output`.
 *
 * The parser handles two common LLM output patterns:
 * 1. Clean JSON — the entire text is valid JSON.
 * 2. JSON in a code fence — `\`\`\`json ... \`\`\`` wrapped blocks.
 * 3. JSON object embedded in prose — the first `{ ... }` block is extracted.
 *
 * @param text - The raw result text from the strategy execution.
 * @param schema - The Zod schema (typed as `unknown` to avoid a hard zod dep).
 * @returns The parsed and validated object, or `undefined` on failure.
 */
/**
 * Extract the first complete JSON object from raw text using brace-matching.
 *
 * Walks the string respecting string quotes and escape sequences, so nested
 * braces inside string values do not confuse the parser. Far more reliable
 * than the `/\{[\s\S]*\}/` greedy regex, which fails when the LLM appends
 * commentary after a complete object (e.g. `{"a":1}\nHere's your world...`).
 *
 * @returns The parsed JSON value, or `undefined` if no valid object was found.
 */
function extractFirstJsonObject(text: string): unknown {
  if (!text) return undefined;

  const start = text.indexOf('{');
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }

  return undefined;
}

function parseStructuredOutput(text: string, schema: unknown): unknown {
  const zodSchema = schema as { parse: (v: unknown) => unknown };
  if (typeof zodSchema?.parse !== 'function') return undefined;

  /* Attempt 1: direct JSON parse of the entire text (happy path). */
  try {
    const raw = JSON.parse(text);
    return zodSchema.parse(raw);
  } catch {
    /* Fall through to extraction heuristics. */
  }

  /* Attempt 2: strip markdown code fences (```json ... ``` or ``` ... ```). */
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    try {
      const raw = JSON.parse(fenceMatch[1].trim());
      return zodSchema.parse(raw);
    } catch {
      /* Fall through to brace matching. */
    }
  }

  /* Attempt 3: brace-matched extraction of the first complete JSON object.
   * Handles trailing commentary and nested braces inside string values. */
  const extracted = extractFirstJsonObject(text);
  if (extracted !== undefined) {
    try {
      return zodSchema.parse(extracted);
    } catch {
      /* Validation failed — return undefined so caller can retry. */
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Session prompt builder
// ---------------------------------------------------------------------------

function buildSessionPrompt(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  text: string,
): string {
  if (history.length === 0) return text;
  const transcript = history
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n');
  return `${transcript}\nUser: ${text}`;
}

async function maybeApproveFinalResult(
  opts: AgencyOptions,
  agencyName: string,
  result: Record<string, unknown>,
  elapsedMs: number,
  emitStreamPart?: (part: AgencyStreamPart) => void,
): Promise<Record<string, unknown>> {
  if (!opts.hitl?.approvals?.beforeReturn || !opts.hitl.handler) {
    return result;
  }

  const usage = normalizeUsage(result.usage);
  const request = {
    id: crypto.randomUUID(),
    type: 'output' as const,
    agent: agencyName,
    action: 'return',
    description: 'Approve the final agency response before returning it.',
    details: {
      output: (result.text as string) ?? '',
    },
    context: {
      agentCalls: ((result.agentCalls as AgentCallRecord[] | undefined) ?? []),
      totalTokens: usage.totalTokens,
      totalCostUSD: usage.costUSD ?? 0,
      elapsedMs,
    },
  };

  opts.on?.approvalRequested?.(request);
  emitStreamPart?.({ type: 'approval-requested', request });
  const decision = await resolveApprovalDecision(opts.hitl, request);
  opts.on?.approvalDecided?.(decision);
  emitStreamPart?.({
    type: 'approval-decided',
    requestId: request.id,
    approved: decision.approved,
  });

  if (!decision.approved) {
    throw new AgencyConfigError(
      decision.reason
        ? `Final output rejected by HITL: ${decision.reason}`
        : 'Final output rejected by HITL',
    );
  }

  // --- Post-approval guardrail override ---
  // Even after HITL approves, run guardrails as a final safety net.
  if (decision.approved && opts.hitl.guardrailOverride !== false) {
    const postGuardrails = opts.hitl.postApprovalGuardrails ?? ['pii-redaction', 'code-safety'];
    const overrideResult = await runPostApprovalGuardrails(
      'return',
      { output: (result.text as string) ?? '' },
      postGuardrails,
      opts.on,
    );
    if (!overrideResult.passed) {
      opts.on?.guardrailHitlOverride?.({
        guardrailId: overrideResult.guardrailId!,
        reason: overrideResult.reason!,
        toolName: 'return',
        timestamp: Date.now(),
      });
      throw new AgencyConfigError(
        `Guardrail overrode HITL approval for final output — ${overrideResult.guardrailId}: ${overrideResult.reason}`,
      );
    }
  }

  if (typeof decision.modifications?.output === 'string') {
    return { ...result, text: decision.modifications.output };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Post-approval guardrail override
// ---------------------------------------------------------------------------

/**
 * Result of a post-approval guardrail check.
 *
 * Contains the blocking guardrail's ID and reason when the override fires.
 */
export interface GuardrailHitlOverrideResult {
  /** Whether the guardrails passed (tool call may proceed). */
  passed: boolean;
  /** The guardrail ID that triggered the block (when `passed` is `false`). */
  guardrailId?: string;
  /** Human-readable reason for the block. */
  reason?: string;
}

/**
 * Runs post-approval guardrails against tool call arguments to catch
 * destructive actions that slipped past the HITL handler.
 *
 * This is the core safety net: even when auto-approve, LLM judge, or a
 * human approves a tool call, the configured guardrails get a final say.
 * If any guardrail returns `action: 'block'`, the approval is overridden.
 *
 * @param toolName - The tool that was approved.
 * @param args - The arguments the tool would be called with.
 * @param guardrailIds - Ordered list of guardrail IDs to evaluate.
 * @param callbacks - Optional event callback map for emitting override events.
 * @returns A result indicating whether the guardrails passed.
 */
export async function runPostApprovalGuardrails(
  toolName: string,
  args: Record<string, unknown>,
  guardrailIds: string[],
  callbacks?: AgencyOptions['on'],
): Promise<GuardrailHitlOverrideResult> {
  if (!guardrailIds.length) {
    return { passed: true };
  }

  /*
   * Serialize the tool call context into a single text payload that the
   * guardrail can evaluate. This includes the tool name and a JSON dump
   * of the arguments so pattern-matching guardrails (e.g., code-safety
   * checking for `rm -rf`) can inspect the full picture.
   */
  const payload = `Tool: ${toolName}\nArguments: ${JSON.stringify(args, null, 2)}`;

  // A notification never changes the decision: a callback that throws is
  // logged, and a block is returned whatever the callback did.
  const notify = (event: GuardrailEvent): void => {
    try {
      callbacks?.guardrailResult?.(event);
    } catch (err) {
      console.warn(`[Guardrail] guardrailResult callback threw for tool "${toolName}":`, err);
    }
  };

  for (const guardId of guardrailIds) {
    let result: { action: 'allow' | 'block'; reason?: string };
    try {
      /*
       * Guardrail evaluation is intentionally lightweight here. Each
       * guardrail ID is passed to a stub evaluator that pattern-matches
       * the payload text. In a full runtime the IDs would be resolved
       * against a guardrail registry.
       */
      result = evaluatePostApprovalGuardrail(guardId, payload);
    } catch {
      /*
       * Individual guardrail failure is non-fatal — fail open for that
       * specific guardrail but continue checking the remaining ones.
       */
      console.warn(
        `[Guardrail] Post-approval guardrail "${guardId}" threw for tool "${toolName}" — skipping`,
      );
      continue;
    }

    if (result.action === 'block') {
      const reason = result.reason ?? `Blocked by guardrail ${guardId}`;
      console.warn(
        `[Guardrail] Overrode HITL approval for tool "${toolName}" — ${guardId}: ${reason}`,
      );

      notify({
        agent: '__agency__',
        guardrailId: guardId,
        passed: false,
        enforced: true,
        action: 'block',
        reason,
        timestamp: Date.now(),
      });

      return { passed: false, guardrailId: guardId, reason };
    }

    // Non-blocking result: notify and continue to the next guardrail.
    notify({
      agent: '__agency__',
      guardrailId: guardId,
      passed: true,
      enforced: true,
      action: result.action,
      timestamp: Date.now(),
    });
  }

  return { passed: true };
}

/**
 * Built-in post-approval guardrail evaluator.
 *
 * Ships with two default guardrails:
 * - `code-safety` — blocks shell commands containing destructive patterns
 *   (e.g., `rm -rf`, `DROP TABLE`, `format C:`).
 * - `pii-redaction` — blocks payloads that appear to contain unredacted PII
 *   (SSNs, credit card numbers).
 *
 * Additional guardrail IDs are treated as pass-through (allow) until a
 * registry-based resolver is wired.
 *
 * @param guardId - The guardrail identifier.
 * @param payload - Serialized tool call context to evaluate.
 * @returns An action/reason pair.
 */
function evaluatePostApprovalGuardrail(
  guardId: string,
  payload: string,
): { action: 'allow' | 'block'; reason?: string } {
  switch (guardId) {
    case 'code-safety': {
      /*
       * Destructive shell pattern detector.
       * Catches common high-damage commands that should almost never be
       * auto-approved without human review.
       */
      const destructivePatterns = [
        /rm\s+-rf\s+\//i,
        /rm\s+-rf\s+~\//i,
        /rm\s+-rf\s+\*/i,
        /rm\s+-rf\s+\.(?:["'\s/]|$)/i,
        /rm\s+-rf\s+\.\//i,
        /mkfs\./i,
        /dd\s+if=.*of=\/dev/i,
        /:(){ :\|:& };:/,
        /DROP\s+TABLE/i,
        /DROP\s+DATABASE/i,
        /TRUNCATE\s+TABLE/i,
        /DELETE\s+FROM\s+\S+\s*;?\s*$/im,
        /format\s+[A-Z]:/i,
        />\s*\/dev\/sd[a-z]/i,
        /chmod\s+-R\s+777\s+\//i,
        /kill\s+-9\b/i,
        /shutdown\s/i,
        /reboot\b/i,
      ];

      for (const pattern of destructivePatterns) {
        if (pattern.test(payload)) {
          return {
            action: 'block',
            reason: `detected destructive pattern: ${pattern.source}`,
          };
        }
      }
      return { action: 'allow' };
    }

    case 'pii-redaction': {
      /*
       * Simple PII pattern detector.
       * Blocks payloads containing unredacted SSNs or credit card numbers.
       */
      const piiPatterns = [
        { pattern: /\b\d{3}-\d{2}-\d{4}\b/, label: 'SSN' },
        { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, label: 'credit card number' },
      ];

      for (const { pattern, label } of piiPatterns) {
        if (pattern.test(payload)) {
          return {
            action: 'block',
            reason: `detected unredacted ${label}`,
          };
        }
      }
      return { action: 'allow' };
    }

    default:
      /*
       * Unknown guardrail ID — pass-through until a registry resolver is
       * wired. This ensures forward compatibility when new guardrail IDs
       * are added to configuration before their implementations exist.
       */
      return { action: 'allow' };
  }
}
