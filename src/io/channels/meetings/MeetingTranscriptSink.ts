/**
 * @module channels/meetings/MeetingTranscriptSink
 *
 * The sink a listen session writes one run's transcript to: each final is
 * stored as the run's next turn and recorded by the manager as a
 * `bot:transcript` event. A turn that reaches a run behind the fence, or a run
 * that is over, is dropped.
 */
import type { ITranscriptInputSink, TranscriptInput, TranscriptTurn } from '../../voice-pipeline/types.js';
import type { MeetingManager } from './MeetingManager.js';
import { FencedError, type ITranscriptStore } from './stores/types.js';

/** Turn ids are assigned by the sink in arrival order, using the store's atomic counter for the run across sink instances. */
export class MeetingTranscriptSink implements ITranscriptInputSink {
  /**
   * @param options - The manager that records each turn's event, the run's transcript store and the run the sink writes.
   * @throws Error when the transcript store does not implement `appendNext`.
   */
  constructor(private readonly options: { manager: MeetingManager; transcript: ITranscriptStore; runId: string }) {
    if (!options.transcript.appendNext) throw new Error('the transcript store must allocate turn ids');
  }

  /** Retains the numbered-turn entry point for existing callers. */
  async append(turn: TranscriptTurn): Promise<void> {
    if (turn.runId !== this.options.runId) throw new Error('a sink writes one run');
    const run = await this.options.manager.getRun(turn.runId);
    if (!run || run.state === 'purging' || run.state === 'done' || run.state === 'failed') return;
    try {
      await this.options.transcript.append(turn);
      await this.options.manager.recordTranscript(turn);
    } catch (err) {
      if (!(err instanceof FencedError)) throw err;
    }
  }

  /** Stores the final as the run's next turn and records its `bot:transcript` event; undefined when a fence or a run that is over drops it. */
  async appendNext(input: TranscriptInput): Promise<TranscriptTurn | undefined> {
    if (input.runId !== this.options.runId) throw new Error('a sink writes one run');
    const run = await this.options.manager.getRun(input.runId);
    if (!run || run.state === 'purging' || run.state === 'done' || run.state === 'failed') return undefined;
    try {
      const turn = await this.options.transcript.appendNext!(input);
      return await this.options.manager.recordTranscript(turn) ? turn : undefined;
    } catch (err) {
      if (err instanceof FencedError) return undefined;
      throw err;
    }
  }
}
