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
import type {
  AgencyOptions,
  Agent,
  BaseAgentConfig,
  CompiledStrategy,
  ResourceControls,
  ApprovalRequest,
  ApprovalDecision,
  AgentCallRecord,
  RagConfig,
  AgencyStreamPart,
  AgencyStreamResult,
  CompiledStrategyStreamResult,
} from './types.js';
import { AgencyConfigError } from './types.js';
import {
  exportAgentConfig,
  exportAgentConfigJSON,
  type AgentExportConfig,
} from './agentExport.js';
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
 * @param opts - Full agency configuration including the `agents` roster, optional
 *   `strategy`, `controls`, `hitl`, and `observability` settings.
 * @returns An {@link Agent} instance whose `generate` / `stream` / `session` methods
 *   invoke the compiled strategy over the configured sub-agents.
 * @throws {AgencyConfigError} When the configuration is structurally invalid
 *   (e.g. no agents defined, emergent enabled without hierarchical strategy,
 *   HITL approvals configured without a handler, parallel/debate without a
 *   synthesis model).
 *
 * @category Core
 */
export function agency(opts: AgencyOptions): Agent {
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

  // 1b. Forward agency-level `beforeTool` to sub-agent permissions.
  //     This ensures that tool-level HITL approval is enforced at the
  //     individual agent layer via `permissions.requireApproval`.
  const resolvedAgents = forwardBeforeToolToSubAgents(opts.agents, opts);

  // 2. Compile the orchestration strategy into an executable CompiledStrategy.
  //    When `adaptive` is true the strategy dispatcher wraps the chosen strategy
  //    with an implicit hierarchical manager.
  //    Auto-detect 'graph' when any sub-agent declares `dependsOn`.
  const hasDependsOn = Object.values(resolvedAgents).some(
    (a) => !isAgent(a) && Array.isArray((a as BaseAgentConfig).dependsOn) && (a as BaseAgentConfig).dependsOn!.length > 0,
  );
  const chosenStrategy = opts.adaptive
    ? 'hierarchical'
    : (opts.strategy ?? (hasDependsOn ? 'graph' : 'sequential'));

  const strategy: CompiledStrategy = compileStrategy(
    chosenStrategy,
    resolvedAgents,
    opts,
  );

  // 3. Extract resource controls (may be undefined).
  const controls: ResourceControls | undefined = opts.controls;
  const agencyName = opts.name ?? '__agency__';
  const agencyUsage: UsageTotals = emptyUsageTotals();

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

  // 4. In-memory session store keyed by session ID.
  const sessions = new Map<string, AgencySession>();
  const sessionUsage = new Map<string, UsageTotals>();

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
  ): Promise<FinalizedExecutionResult> => {
    const guardConfig = normalizeGuardrails(opts.guardrails);
    const outputGuards = guardConfig?.output ?? [];
    const finalized: FinalizedExecutionResult = { ...result };
    const elapsedMs = Date.now() - start;

    if (outputGuards.length && typeof finalized.text === 'string') {
      finalized.text = await runGuardrails(finalized.text, outputGuards, 'output', opts.on);
    }

    if (opts.output && typeof finalized.text === 'string') {
      finalized.parsed = parseStructuredOutput(finalized.text, opts.output);
    }

    if (controls) {
      checkLimits(controls, finalized, elapsedMs, opts.on);
    }

    const resultUsage = normalizeUsage(finalized.usage);
    finalized.usage = resultUsage;
    addUsageTotals(agencyUsage, resultUsage);
    if (sessionId) {
      addUsageTotals(getSessionUsage(sessionUsage, sessionId), resultUsage);
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
    });

    opts.on?.agentEnd?.({
      agent: agencyName,
      output: (approvedResult.text as string) ?? '',
      durationMs: elapsedMs,
      timestamp: Date.now(),
    });

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
    const start = Date.now();
    opts.on?.agentStart?.({
      agent: agencyName,
      input: prompt,
      timestamp: start,
    });

    try {
      const preparedPrompt = await prepareExecutionPrompt(prompt);

      // Validation retry loop — when `opts.output` is a Zod schema and the
      // LLM returns unparseable/invalid text, retry with the previous error
      // appended to the prompt so the model can self-correct.
      const maxValidationRetries = controls?.maxValidationRetries ?? 1;
      const hasValidation = !!opts.output;

      let currentPrompt = preparedPrompt;
      let lastFinalized: FinalizedExecutionResult | null = null;

      const maxAttempts = hasValidation ? maxValidationRetries + 1 : 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = (await strategy.execute(currentPrompt, execOpts)) as Record<string, unknown>;
        const finalized = await finalizeExecutionResult(result, start, sessionId);
        lastFinalized = finalized;

        // Success path: no validation required, OR validation produced a `parsed` value
        if (!hasValidation || finalized.parsed !== undefined) {
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
      return lastFinalized!;
    } catch (error) {
      opts.on?.error?.({
        agent: agencyName,
        error: error instanceof Error ? error : new Error(String(error)),
        timestamp: Date.now(),
      });
      throw error;
    }
  };

  const createStreamResult = (
    prompt: string,
    streamOpts?: Record<string, unknown>,
    sessionId?: string,
  ): AgencyStreamResult => {
    const start = Date.now();
    let errorReported = false;
    const postStreamParts: AgencyStreamPart[] = [];

    const reportError = (error: unknown): void => {
      if (errorReported) return;
      errorReported = true;
      opts.on?.error?.({
        agent: agencyName,
        error: error instanceof Error ? error : new Error(String(error)),
        timestamp: Date.now(),
      });
    };

    opts.on?.agentStart?.({
      agent: agencyName,
      input: prompt,
      timestamp: start,
    });

    const deferredStream = (async () => {
      const preparedPrompt = await prepareExecutionPrompt(prompt);
      return strategy.stream(preparedPrompt, streamOpts) as CompiledStrategyStreamResult;
    })();

    const rawPartReplay = createBufferedAsyncReplay<AgencyStreamPart>((async function* () {
      const streamResult = await deferredStream;

      if (streamResult.fullStream) {
        yield* streamResult.fullStream;
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
        reportError(error);
        throw error;
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

        const result: Record<string, unknown> = {
          text,
          usage,
          agentCalls: Array.isArray(agentCalls) ? agentCalls : [],
        };

        return await finalizeExecutionResult(result, start, sessionId, postStreamParts);
      } catch (error) {
        reportError(error);
        throw error;
      }
    })();

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
          throw error;
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
          throw error;
        }
      })(),
      text: finalizedResultPromise.then((result) => (result.text as string) ?? ''),
      usage: finalizedResultPromise.then((result) => result.usage as {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        costUSD?: number;
      }),
      agentCalls: finalizedResultPromise.then((result) => (result.agentCalls ?? []) as AgentCallRecord[]),
      parsed: finalizedResultPromise.then((result) => result.parsed),
      finalTextStream: (async function* () {
        const finalResult = await finalizedResultPromise;
        const finalText = (finalResult.text as string) ?? '';
        if (finalText) {
          yield finalText;
        }
      })(),
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
     * @param opts - Optional per-call overrides.
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
     * @param streamOpts - Optional per-call overrides.
     * @returns An object with raw `textStream`, `fullStream`, awaitable `text`/`usage`
     *   promises, an awaitable `agentCalls` ledger, an awaitable `parsed` value
     *   when structured output is configured, and `finalTextStream` for the
     *   finalized post-processing text.
     */
    stream(prompt: string, streamOpts?: Record<string, unknown>): AgencyStreamResult {
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
     * @returns A portable {@link AgentExportConfig} object.
     */
    export(metadata?: AgentExportConfig['metadata']): AgentExportConfig {
      return exportAgentConfig(agentObj, metadata);
    },

    /**
     * Exports this agency's configuration as a pretty-printed JSON string.
     * @param metadata - Optional human-readable metadata to attach.
     * @returns JSON string with 2-space indentation.
     */
    exportJSON(metadata?: AgentExportConfig['metadata']): string {
      return exportAgentConfigJSON(agentObj, metadata);
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
  const agencySubAgentConfigs: Record<string, BaseAgentConfig> = {};
  for (const [name, agentOrConfig] of Object.entries(opts.agents)) {
    if (isAgent(agentOrConfig)) {
      // Pre-built agents don't carry exportable config — store empty placeholder
      agencySubAgentConfigs[name] = {};
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

  return agentObj;
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
// beforeTool forwarding
// ---------------------------------------------------------------------------

/**
 * Forwards agency-level `hitl.approvals.beforeTool` into each sub-agent's
 * `permissions.requireApproval` list.
 *
 * Pre-built {@link Agent} instances are returned as-is (their config is
 * immutable). For raw `BaseAgentConfig` objects, the tool names are merged
 * into the existing `requireApproval` array, deduplicating entries.
 *
 * @param agents - The original agent roster from the agency options.
 * @param opts - Agency-level options containing the HITL config.
 * @returns A new roster with `beforeTool` names injected into sub-agent permissions.
 */
function forwardBeforeToolToSubAgents(
  agents: Record<string, BaseAgentConfig | Agent>,
  opts: AgencyOptions,
): Record<string, BaseAgentConfig | Agent> {
  const toolsRequiringApproval = opts.hitl?.approvals?.beforeTool;
  if (!toolsRequiringApproval?.length) return agents;

  const result: Record<string, BaseAgentConfig | Agent> = {};

  for (const [name, agentOrConfig] of Object.entries(agents)) {
    /* Pre-built Agent instances are opaque — cannot inject config. */
    if (isAgent(agentOrConfig)) {
      result[name] = agentOrConfig;
      continue;
    }

    const config = agentOrConfig as BaseAgentConfig;
    const existing = config.permissions?.requireApproval ?? [];
    const merged = [...new Set([...existing, ...toolsRequiringApproval])];

    result[name] = {
      ...config,
      permissions: {
        ...config.permissions,
        requireApproval: merged,
      },
    };
  }

  return result;
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
 * - `parallel` and `debate` strategies require an agency-level `model` or `provider`
 *   for their synthesis step.
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

async function resolveApprovalDecision(
  hitlConfig: NonNullable<AgencyOptions['hitl']>,
  request: ApprovalRequest,
): Promise<ApprovalDecision> {
  const timeoutMs = hitlConfig.timeoutMs ?? 30_000;
  const onTimeout = hitlConfig.onTimeout ?? 'reject';

  return await new Promise<ApprovalDecision>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (onTimeout === 'approve') {
        resolve({ approved: true, reason: 'Auto-approved after HITL timeout' });
        return;
      }
      if (onTimeout === 'error') {
        reject(new AgencyConfigError('HITL approval timed out'));
        return;
      }
      resolve({ approved: false, reason: 'Auto-rejected after HITL timeout' });
    }, timeoutMs);

    hitlConfig.handler!(request)
      .then((decision) => {
        clearTimeout(timer);
        resolve(decision);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
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

  for (const guardId of guardrailIds) {
    try {
      /*
       * Guardrail evaluation is intentionally lightweight here. Each
       * guardrail ID is passed to a stub evaluator that pattern-matches
       * the payload text. In a full runtime the IDs would be resolved
       * against a guardrail registry.
       */
      const result = evaluatePostApprovalGuardrail(guardId, payload);

      if (result.action === 'block') {
        const reason = result.reason ?? `Blocked by guardrail ${guardId}`;
        console.warn(
          `[Guardrail] Overrode HITL approval for tool "${toolName}" — ${guardId}: ${reason}`,
        );

        callbacks?.guardrailResult?.({
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

      // Non-blocking result: log and continue to the next guardrail.
      callbacks?.guardrailResult?.({
        agent: '__agency__',
        guardrailId: guardId,
        passed: true,
        enforced: true,
        action: result.action,
        timestamp: Date.now(),
      });
    } catch {
      /*
       * Individual guardrail failure is non-fatal — fail open for that
       * specific guardrail but continue checking the remaining ones.
       */
      console.warn(
        `[Guardrail] Post-approval guardrail "${guardId}" threw for tool "${toolName}" — skipping`,
      );
    }
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
