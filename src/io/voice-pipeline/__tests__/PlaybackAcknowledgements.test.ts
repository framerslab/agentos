import { describe, expect, it } from 'vitest';
import { PlaybackAcknowledgements, type PlaybackClear } from '../PlaybackAcknowledgements.js';
const generation = { workerGeneration: 1, inferenceGeneration: 2, transportEpoch: 3 };
const receipt = { generation, sequence: 1, playedSamples: 320, sampleRate: 16000 };
describe('bounded receiver receipts', () => {
  it('does not confuse queued, stale or duplicate acknowledgements with playback', async () => {
    const a = new PlaybackAcknowledgements(1000); a.begin(receipt);
    expect(() => a.begin(receipt)).toThrow('outstanding');
    expect(a.receive({ type: 'playback', ...receipt, generation: { ...generation, transportEpoch: 2 } })).toBe(false);
    expect(a.receive({ type: 'playback', ...receipt })).toBe(true);
    expect(await a.wait(generation, 1, new AbortController().signal)).toEqual(receipt);
    expect(a.receive({ type: 'playback', ...receipt })).toBe(false);
  });
  it('rejects mismatched counts and an absent receiver without growing a queue', async () => {
    const a = new PlaybackAcknowledgements(10); a.begin(receipt);
    expect(() => a.receive({ type: 'playback', ...receipt, playedSamples: 319 })).toThrow('receipt mismatch');
    await expect(a.wait(generation, 1, new AbortController().signal)).rejects.toThrow('receipt timeout');
    a.close();
  });
  it('requires clear acknowledgement and cannot acknowledge cancelled samples', async () => {
    const a = new PlaybackAcknowledgements(1000); a.begin(receipt);
    const waiting = expect(a.wait(generation, 1, new AbortController().signal)).rejects.toThrow('cancelled');
    let clear: unknown; const cleared = a.clear(generation, async (message) => { clear = message; });
    expect(a.receive({ type: 'playback', ...receipt })).toBe(false);
    const message = clear as { generation: typeof generation; clearId: number };
    expect(a.receive({ type: 'cleared', generation: message.generation, clearId: message.clearId })).toBe(true);
    await cleared; await waiting;
    await a.clear(generation, async () => { throw new Error('duplicate clear'); }); a.close();
  });
  it('settles a repeated clear only once the handshake it shares has released', async () => {
    const a = new PlaybackAcknowledgements(1000); a.begin(receipt);
    let sent: unknown;
    const first = a.clear(generation, async (message) => { sent = message; });
    const repeated = a.clear(generation, async () => { throw new Error('a second discard was sent'); });
    const clear = sent as PlaybackClear;
    expect(a.receive({ type: 'cleared', generation: clear.generation, clearId: clear.clearId })).toBe(true);
    await repeated;
    // The handshake is over for every caller: the next generation's chunk is admitted at once.
    expect(() => a.begin({ ...receipt, generation: { ...generation, inferenceGeneration: 3 } })).not.toThrow();
    await first; a.close();
  });
});
