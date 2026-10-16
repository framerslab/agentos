/**
 * @module voice-pipeline/providers/AgentSessionVoiceAdapter
 *
 * Adapts an AgentOS {@link AgentSession} to the {@link IVoicePipelineAgentSession}
 * interface required by {@link VoicePipelineOrchestrator}.
 *
 * Each request streams through `AgentSession.stream(text, { abortSignal })`
 * and yields the result's `textStream` deltas as the return value of
 * `sendText()`.
 *
 * ## Abort Handling
 *
 * `abort()` aborts the request's signal, so the session cancels the model
 * request itself instead of only discarding its output, and tokens that arrive
 * after the abort are not yielded. A request `sendText()` returned before an
 * `abort()` and not yet pulled is cancelled too: it never reaches the session
 * and yields nothing. `whenIdle()` resolves once the request's iterator has
 * unwound; that alone does not prove a remote supplier stopped work. One
 * request is active at a time.
 */

import type { AgentSession } from '../../../api/agent.js';
import type { IVoicePipelineAgentSession, VoiceTurnMetadata } from '../types.js';

/**
 * Adapts AgentSession streaming with a request AbortSignal; aborted output never enters a new turn.
 *
 * @example
 * ```typescript
 * import { agent } from '@framers/agentos';
 * import { AgentSessionVoiceAdapter } from '@framers/agentos/io/voice-pipeline';
 *
 * const a = agent({ model: 'gpt-4o' });
 * const session = a.session('voice-session-1');
 * const voiceAdapter = new AgentSessionVoiceAdapter(session);
 *
 * // Use with VoicePipelineOrchestrator
 * orchestrator.startSession(transport, voiceAdapter, overrides);
 * ```
 */
export class AgentSessionVoiceAdapter implements IVoicePipelineAgentSession {
  private controller?: AbortController;
  private idle: Promise<void> = Promise.resolve();
  /** `abort()` calls so far; a request made before the latest one never starts. */
  private aborts = 0;

  /**
   * @param session - The agent session each request streams through.
   */
  constructor(private readonly session: AgentSession) {}

  /**
   * One active request. The underlying model and tool machinery receive the same abort signal. The request belongs
   * to the moment of this call: an `abort()` before its first pull cancels it, so it never reaches the session and
   * yields nothing.
   *
   * @param text - Transcribed user speech to send to the agent.
   * @param _metadata - Voice turn metadata; the session takes none, so it is not forwarded.
   * @returns The response's text deltas.
   * @throws {Error} When iterated while another request of this adapter is active.
   */
  sendText(text: string, _metadata: VoiceTurnMetadata): AsyncIterable<string> {
    // Read at the call, not at the first pull: a generator's body does not run until it is iterated.
    return this.request(text, this.aborts);
  }

  /** Streams one request, made when `abort()` had been called `issued` times; it starts nothing after a later abort. */
  private async *request(text: string, issued: number): AsyncIterable<string> {
    if (issued !== this.aborts) return;
    if (this.controller) throw new Error('voice request already active');
    const controller = new AbortController();
    this.controller = controller;
    let finish!: () => void;
    this.idle = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      const result = this.session.stream(text, { abortSignal: controller.signal });
      for await (const token of result.textStream) {
        if (controller.signal.aborted) break;
        yield token;
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      controller.abort();
      if (this.controller === controller) this.controller = undefined;
      finish();
    }
  }

  /** Cancels actual generation, not just iteration of the returned text, and every request not yet pulled. */
  abort(): void {
    this.aborts++;
    this.controller?.abort();
  }

  /** Completes when the iterator unwinds; native providers additionally owe their own abort acknowledgement. */
  whenIdle(): Promise<void> {
    return this.idle;
  }
}
