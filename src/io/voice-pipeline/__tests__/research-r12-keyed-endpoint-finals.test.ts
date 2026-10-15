import { expect, it, vi } from 'vitest';
import { HeuristicEndpointDetector } from '../HeuristicEndpointDetector.js';
it('retains keyed clauses received during the same active turn', () => {
  const detector = new HeuristicEndpointDetector(); const done = vi.fn(); detector.on('turn_complete', done);
  detector.pushVadEvent({ type: 'speech_start', source: 'vad', timestamp: 0 });
  detector.pushTranscript({ itemId: 'clause-a', text: 'First clause', confidence: 1, words: [], isFinal: true });
  detector.pushTranscript({ itemId: 'clause-b', text: 'second clause.', confidence: 1, words: [], isFinal: true });
  detector.pushVadEvent({ type: 'speech_end', source: 'vad', timestamp: 1000 });
  expect(done).toHaveBeenCalledOnce();
  expect(done.mock.calls[0]![0].transcript).toBe('First clause second clause.'); detector.reset();
});
