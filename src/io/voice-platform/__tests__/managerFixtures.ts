import type { CallActionContext, VoiceCallHooks } from '../VoiceCallManager.js';

/** Idempotent external effects, with explicit controller and worker fencing for fault injection. */
export function managerHooks() {
  const effects: string[] = [];
  const done = new Set<string>();
  let failure: string | null = null;
  let fenced = true;
  const record = async (name: string, c: CallActionContext): Promise<void> => {
    if (failure === name) { failure = null; if (!done.has(c.operationId)) { done.add(c.operationId); effects.push(name); } throw new Error('injected failure'); }
    if (!done.has(c.operationId)) { done.add(c.operationId); effects.push(name); }
  };
  const hooks: VoiceCallHooks = {
    reserveOnce: async (c) => { await record('reserve', c); return 'reservation-a'; },
    prepareOnce: (c) => record('prepare', c), publishDispatchOnce: (c) => record('dispatch', c),
    fenceContent: (c) => record('fence-content', c), abortModelAndTools: (c) => record('abort', c),
    cancelTts: (c) => record('tts', c), clearPlayback: (c) => record('playback', c),
    drainTranscripts: (c) => record('transcripts', c), releaseMedia: (c) => record('media', c),
    confirmStopped: async (c) => {
      await record('fence', c);
      return { workerGeneration: c.state.call.workerGeneration, workerStopped: fenced, mediaClosed: fenced, inferenceStopped: fenced, evidenceRef: 'evidence-a' };
    },
    releaseSlots: (c) => record('slots', c), settleOnce: (c) => record('settle', c),
    fenceAction: async () => fenced,
  };
  return { hooks, effects, fail: (name: string) => { failure = name; }, setFenced: (value: boolean) => { fenced = value; } };
}
