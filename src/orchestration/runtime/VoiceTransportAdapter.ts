/**
 * @file VoiceTransportAdapter.ts
 * @description Bridges graph I/O to the voice pipeline when a workflow runs in
 * voice transport mode.
 *
 * ## Purpose
 *
 * `VoiceTransportAdapter` wraps a graph's input/output cycle so that:
 * - **Node input** is obtained by waiting for the user's next speech turn
 *   (`waitForUserTurn()` on the underlying `VoicePipelineOrchestrator`).
 * - **Node output** is delivered to the TTS engine (`pushToTTS()` on the
 *   underlying `VoicePipelineOrchestrator`).
 *
 * ## `getNodeInput` / `deliverNodeOutput` contract
 *
 * - `getNodeInput(nodeId)` delegates to `pipeline.waitForUserTurn()` when a
 *   pipeline is available, or falls back to listening for `turn_complete` on
 *   the transport directly.
 * - `deliverNodeOutput(nodeId, output)` delegates to `pipeline.pushToTTS()`
 *   and emits a `voice_audio` outbound GraphEvent.
 * - Both methods throw if called before `init()`.
 *
 * ## A started session
 *
 * The adapter runs on a session the host started: `{ session, orchestrator }`,
 * the `VoicePipelineSession` that `orchestrator.startSession()` returned and the
 * orchestrator itself. `init()` puts the session in `state.scratch.voiceSession`,
 * where `VoiceNodeExecutor` reads its own events, and node input and output go
 * through the orchestrator. Given no orchestrator, the adapter builds one from its
 * config, as before, and starts no session, so node input and output wait on a
 * pipeline that never runs; it logs one warning saying so, through the host's
 * logger, and keeps that behaviour until the next minor. The references are `any`
 * typed to avoid a hard import cycle with the voice subsystem; callers that want
 * stronger types may cast.
 *
 * @example
 * ```typescript
 * const orchestrator = new VoicePipelineOrchestrator({ stt: 'deepgram', tts: 'openai' });
 * const session = await orchestrator.startSession(transport, agentSession, overrides);
 * const adapter = new VoiceTransportAdapter({}, transport, (event) => eventBus.emit(event), { session, orchestrator });
 *
 * await adapter.init(state);
 * const userInput = await adapter.getNodeInput('greet');
 * await adapter.deliverNodeOutput('greet', 'Hello, how can I help you today?');
 * await adapter.dispose();
 * ```
 *
 * See `VoiceNodeExecutor` for the executor that consumes this adapter's events.
 * @see {@link VoiceTransportConfig} -- configuration knobs forwarded to the pipeline.
 */

import type { GraphState } from '../ir/types.js';
import type { GraphEvent } from '../events/GraphEvent.js';
import type { ILogger } from '../../core/logging/ILogger.js';

/** What the adapter logs when it is given no orchestrator; it names no part of a session's content. */
const NO_STARTED_SESSION_WARNING =
  'VoiceTransportAdapter was given no orchestrator, so it builds a VoicePipelineOrchestrator from its config and ' +
  'starts no session: node input and output wait on a pipeline that never runs. Pass { session, orchestrator } of ' +
  'a started session.';

/**
 * Whether a value is a started `VoicePipelineSession`, as `startSession()` returns it: an emitter with its session id,
 * its transport and `close()`. An emitter a host relays a pipeline's events onto has none of these.
 *
 * @param value - The session the host gave.
 * @returns `true` for a started session.
 */
function isStartedVoiceSession(value: unknown): boolean {
  const session = value as { sessionId?: unknown; close?: unknown; on?: unknown } | null | undefined;
  return (
    typeof session === 'object' &&
    session !== null &&
    typeof session.sessionId === 'string' &&
    typeof session.close === 'function' &&
    typeof session.on === 'function' &&
    'transport' in session
  );
}

/**
 * What a host hands a {@link VoiceTransportAdapter} besides its config: the session a graph's voice nodes run on,
 * the orchestrator that runs it, and the logger the adapter writes to.
 */
export interface VoiceTransportAdapterParts {
  /**
   * The started session: the `VoicePipelineSession` that `orchestrator.startSession()` returned. `init()` puts it in
   * `state.scratch.voiceSession`, where `VoiceNodeExecutor` reads its own events. Given without `orchestrator`, a value
   * that is no started session is taken as an emitter that relays the pipeline's events under the names voice nodes
   * read before (`final_transcript`, `turn_complete` and the rest) and set as `transport._voiceSession`, which is
   * deprecated and kept until the next minor.
   */
  session?: any;
  /**
   * The `VoicePipelineOrchestrator` that runs `session`: node input waits on its turns (`waitForUserTurn()`) and node
   * output goes to its TTS (`pushToTTS()`).
   */
  orchestrator?: any;
  /** @deprecated Pass `orchestrator`: the same orchestrator under its earlier name, kept until the next minor. */
  pipeline?: any;
  /**
   * Takes the warning the adapter logs when it is given no orchestrator. When omitted, the warning goes to
   * `createLogger('VoiceTransportAdapter')` from `@framers/agentos/logging`, which is loaded only to write it.
   */
  logger?: ILogger;
}

// ---------------------------------------------------------------------------
// VoiceTransportConfig
// ---------------------------------------------------------------------------

/**
 * Configuration knobs forwarded to the voice pipeline when the adapter
 * initialises its internal `VoicePipelineOrchestrator` instance.
 *
 * All fields are optional -- defaults are resolved from agent.config.json or
 * sensible library defaults within the voice pipeline itself.
 */
export interface VoiceTransportConfig {
  /** STT provider identifier (e.g. `'deepgram'`, `'openai'`). */
  stt?: string;

  /** TTS provider identifier (e.g. `'openai'`, `'elevenlabs'`). */
  tts?: string;

  /** TTS voice name or id forwarded to the TTS provider. */
  voice?: string;

  /**
   * Barge-in handling strategy.
   * - `'hard-cut'`  -- interrupt TTS immediately when speech is detected.
   * - `'soft-fade'` -- ramp TTS volume down before cutting.
   * - `'disabled'`  -- ignore user speech while the agent is speaking.
   */
  bargeIn?: string;

  /**
   * Endpoint detection mode used to decide when the user has finished speaking.
   * - `'acoustic'`  -- energy/VAD-based detection.
   * - `'heuristic'` -- punctuation + silence heuristics.
   * - `'semantic'`  -- LLM-assisted turn boundary detection.
   */
  endpointing?: string;

  /** Whether to enable speaker diarization for multi-speaker sessions. */
  diarization?: boolean;

  /** BCP-47 language tag forwarded to STT (e.g. `'en-US'`). */
  language?: string;
}

// ---------------------------------------------------------------------------
// VoiceTransportAdapter
// ---------------------------------------------------------------------------

/**
 * Adapts a compiled graph's I/O cycle to the real-time voice pipeline.
 *
 * ## Lifecycle
 *
 * 1. Construct with {@link VoiceTransportConfig}, an `IStreamTransport`, an
 *    event sink callback, and `{ session, orchestrator }` of a started session.
 * 2. Call `init()` once before the graph starts running. It injects the transport
 *    into `state.scratch.voiceTransport` and the started session into
 *    `state.scratch.voiceSession`. Given no orchestrator, it lazily imports
 *    `VoicePipelineOrchestrator`, creates an instance from the config, which no
 *    session runs, and logs one warning.
 * 3. Use `getNodeInput()` to obtain the user's transcribed speech for a node.
 *    Delegates to `pipeline.waitForUserTurn()` when a pipeline is available.
 * 4. Use `deliverNodeOutput()` to send the node's response to TTS via
 *    `pipeline.pushToTTS()`.
 * 5. Call `dispose()` to clean up resources when the session ends.
 */
export class VoiceTransportAdapter {
  /**
   * Lazily-initialised `VoicePipelineOrchestrator` instance.
   * Typed as `any` to avoid a hard import cycle with the voice subsystem.
   */
  private pipeline: any | null = null;

  /**
   * Tracks whether `init()` has been called successfully.
   * Set to `false` by `dispose()` to prevent use-after-teardown.
   */
  private initialized = false;

  /**
   * Creates a new VoiceTransportAdapter.
   *
   * @param config     - Voice pipeline configuration knobs, read only when no
   *                     orchestrator is given.
   * @param transport  - Bidirectional audio/control stream transport (`IStreamTransport`).
   * @param eventSink  - Callback receiving all `GraphEvent` values emitted by
   *                     this adapter. Must not throw.
   * @param injected   - The started session and its orchestrator, which a host
   *                     builds with the providers, memory and chains it wants,
   *                     and the logger the adapter writes to
   *                     ({@link VoiceTransportAdapterParts}).
   */
  constructor(
    private readonly config: VoiceTransportConfig,
    private readonly transport: any, // IStreamTransport
    private readonly eventSink: (event: GraphEvent) => void,
    private readonly injected: VoiceTransportAdapterParts = {}
  ) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialise the adapter.
   *
   * Injects the transport into `state.scratch.voiceTransport` and the adapter
   * into `state.scratch.voiceAdapter`. A started session goes into
   * `state.scratch.voiceSession`, where `VoiceNodeExecutor` reads its events; an
   * emitter of relayed events given without `orchestrator` goes onto
   * `transport._voiceSession`, as before. With `orchestrator` (or `pipeline`) the
   * adapter uses it; without, it lazily imports `VoicePipelineOrchestrator`,
   * creates an instance from config that no session runs, and logs one warning.
   * Then it emits a `voice_session` started event.
   */
  async init(state: Partial<GraphState>): Promise<void> {
    const scratch = ((state as any).scratch ??= {});
    scratch.voiceTransport = this.transport;
    // Expose the adapter so node executors (e.g. speak-only delivery in
    // VoiceNodeExecutor) can reach `deliverNodeOutput` without re-plumbing.
    scratch.voiceAdapter = this;

    const { session, orchestrator } = this.injected;
    const pipeline = orchestrator ?? this.injected.pipeline;
    if (session) {
      if (orchestrator || isStartedVoiceSession(session)) {
        // A started session: the executor's VoiceTurnCollector reads its own events.
        scratch.voiceSession = session;
      } else {
        // An emitter that relays the pipeline's events under the names voice nodes read before. Deprecated, and kept
        // until the next minor.
        (this.transport as any)._voiceSession = session;
      }
    }

    if (pipeline) {
      // Consumer-provided, already-started pipeline. Use it directly.
      this.pipeline = pipeline;
    } else {
      // A pipeline built here runs no session; the host is told once, and today's behaviour stays until the next minor.
      await this.warn(NO_STARTED_SESSION_WARNING);
      // Lazily import to avoid hard dependency cycle with the voice subsystem
      try {
        const { VoicePipelineOrchestrator } = await import(
          '../../io/voice-pipeline/VoicePipelineOrchestrator.js'
        );
        this.pipeline = new VoicePipelineOrchestrator({
          stt: this.config.stt ?? 'deepgram',
          tts: this.config.tts ?? 'elevenlabs',
          endpointing: this.config.endpointing as any,
          bargeIn: this.config.bargeIn as any,
          voice: this.config.voice,
          language: this.config.language,
        });
      } catch {
        // Pipeline unavailable — fall back to transport-only mode
        this.pipeline = null;
      }
    }

    this.initialized = true;

    this.eventSink({
      type: 'voice_session',
      nodeId: '__transport__',
      action: 'started',
    });
  }

  /**
   * Writes one warning to the host's logger, or to `createLogger('VoiceTransportAdapter')`, loaded only to write it.
   * A logger that throws, or a logging module that does not load, leaves the adapter as it is: the warning is lost.
   *
   * @param message - The warning, which names no content.
   */
  private async warn(message: string): Promise<void> {
    try {
      const logger = this.injected.logger ?? (await import('../../core/logging/loggerFactory.js')).createLogger('VoiceTransportAdapter');
      logger.warn(message);
    } catch {
      // Logging must not stop the adapter; nothing else can report the warning.
    }
  }

  // -------------------------------------------------------------------------
  // Node I/O
  // -------------------------------------------------------------------------

  /**
   * Wait for the user's next speech turn and return the transcript text.
   *
   * Delegates to `VoicePipelineOrchestrator.waitForUserTurn()` when a pipeline
   * is available. Falls back to listening for `turn_complete` on the transport.
   */
  async getNodeInput(nodeId: string): Promise<string> {
    if (!this.initialized) {
      throw new Error('VoiceTransportAdapter not initialized');
    }

    // Delegate to pipeline if available
    if (this.pipeline?.waitForUserTurn) {
      const turnEvent = await this.pipeline.waitForUserTurn();
      const transcript: string = turnEvent?.transcript ?? '';

      this.eventSink({
        type: 'voice_turn_complete',
        nodeId,
        transcript,
        turnIndex: 0,
        endpointReason: turnEvent?.reason ?? 'unknown',
      });

      return transcript;
    }

    // Fallback: listen on transport directly
    return new Promise<string>((resolve) => {
      this.transport.once('turn_complete', (evt: any) => {
        const transcript: string = evt?.transcript ?? evt?.text ?? '';

        this.eventSink({
          type: 'voice_turn_complete',
          nodeId,
          transcript,
          turnIndex: 0,
          endpointReason: evt?.reason ?? 'unknown',
        });

        resolve(transcript);
      });
    });
  }

  /**
   * Deliver a node's text output to the TTS engine.
   *
   * Delegates to `VoicePipelineOrchestrator.pushToTTS()` when a pipeline is
   * available, then emits a `voice_audio` outbound GraphEvent.
   */
  async deliverNodeOutput(nodeId: string, output: string | AsyncIterable<string>): Promise<void> {
    if (!this.initialized) {
      throw new Error('VoiceTransportAdapter not initialized');
    }

    // Delegate to pipeline TTS if available
    if (this.pipeline?.pushToTTS) {
      await this.pipeline.pushToTTS(output);
    }

    this.eventSink({
      type: 'voice_audio',
      nodeId,
      direction: 'outbound',
      format: 'tts',
      durationMs: 0,
    });
  }

  // -------------------------------------------------------------------------
  // Barge-in
  // -------------------------------------------------------------------------

  /**
   * Handle a user barge-in at the transport level.
   *
   * Emits a `voice_barge_in` event so that graph event consumers can react.
   */
  handleBargeIn(): void {
    this.eventSink({
      type: 'voice_barge_in',
      nodeId: '__transport__',
      interruptedText: '',
      userSpeech: '',
    });
  }

  // -------------------------------------------------------------------------
  // Disposal
  // -------------------------------------------------------------------------

  /**
   * Dispose the adapter and emit a `voice_session` ended event.
   *
   * Stops the pipeline if one was initialised, then marks the adapter as
   * uninitialised so subsequent calls throw.
   */
  async dispose(): Promise<void> {
    if (this.pipeline?.stopSession) {
      await this.pipeline.stopSession('adapter-disposed');
    }

    this.eventSink({
      type: 'voice_session',
      nodeId: '__transport__',
      action: 'ended',
      exitReason: 'transport-disposed',
    });
    this.initialized = false;
    this.pipeline = null;
  }
}
