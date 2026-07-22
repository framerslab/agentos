import { describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return { generateCompletion, getProvider, createProviderManager };
});

vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4.1-mini' })),
  resolveProvider: vi.fn(() => ({
    providerId: 'openai',
    modelId: 'gpt-4.1-mini',
    apiKey: 'test-key',
  })),
  createProviderManager: hoisted.createProviderManager,
}));

import { SessionHistoryBuffer } from '../../sessionHistory.js';
import { agent } from '../../agent.js';
import type { SessionTranscriptMessage } from '../../sessionTranscript.js';

function sendDelta(i: number, pad = 200): SessionTranscriptMessage[] {
  return [
    { role: 'user', content: `turn ${i} ${'x'.repeat(pad)}` },
    { role: 'assistant', content: `reply ${i} ${'y'.repeat(pad)}` },
  ];
}

describe('SessionHistoryBuffer', () => {
  it('appends send deltas as whole blocks and reports messages in order', () => {
    const buf = new SessionHistoryBuffer({ maxTokens: 100_000, evictChunkRatio: 0.25, minKeepSends: 8 });
    buf.appendSendDelta(sendDelta(1), 'iter-1');
    buf.appendSendDelta(sendDelta(2), 'iter-2');
    expect(buf.messages().map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(buf.blockCount()).toBe(2);
  });

  it('evicts one contiguous oldest chunk when the ceiling is crossed, never splitting a block', () => {
    const buf = new SessionHistoryBuffer({ maxTokens: 700, evictChunkRatio: 0.25, minKeepSends: 2 });
    for (let i = 1; i <= 10; i++) buf.appendSendDelta(sendDelta(i, 160), `iter-${i}`);
    const events = buf.drainHistoryEvents();
    const evictions = events.filter((e) => e.type === 'eviction');
    expect(evictions.length).toBeGreaterThanOrEqual(1);
    const roles = buf.messages().map((m) => m.role);
    expect(roles[0]).toBe('user');
    expect(buf.blockCount()).toBeLessThan(10);
    const text = JSON.stringify(buf.messages());
    expect(text).toContain('turn 10');
    expect(text).toContain('turn 9');
  });

  it('epoch guards: an append stamped with an old epoch is discarded after reseed', () => {
    const buf = new SessionHistoryBuffer({ maxTokens: 100_000, evictChunkRatio: 0.25, minKeepSends: 8 });
    const epochBefore = buf.epoch();
    buf.appendSendDelta(sendDelta(1), 'iter-1');
    buf.reseed([{ role: 'user', content: 'snapshot' }]);
    const applied = buf.appendSendDelta(sendDelta(2), 'iter-2', epochBefore);
    expect(applied).toBe(false);
    expect(JSON.stringify(buf.messages())).not.toContain('turn 2');
    expect(buf.messages()).toHaveLength(1);
  });

  it('reseed rejects a snapshot with broken pairing', () => {
    const buf = new SessionHistoryBuffer({ maxTokens: 100_000, evictChunkRatio: 0.25, minKeepSends: 8 });
    expect(() =>
      buf.reseed([{ role: 'tool', tool_call_id: 'tc_x', content: '{}' } as never]),
    ).toThrow(/orphan tool result/i);
  });

  it('byte-stability: surviving blocks are reference-identical after an eviction', () => {
    const buf = new SessionHistoryBuffer({ maxTokens: 700, evictChunkRatio: 0.25, minKeepSends: 2 });
    const tracked = sendDelta(99, 160);
    for (let i = 1; i <= 6; i++) buf.appendSendDelta(sendDelta(i, 160), `iter-${i}`);
    buf.appendSendDelta(tracked, 'iter-tracked');
    for (let i = 7; i <= 12; i++) buf.appendSendDelta(sendDelta(i, 160), `iter-${i}`);
    const flat = buf.messages();
    // The tracked block either survived intact (same object references —
    // byte-stable serialization) or was dropped whole; never partially.
    const present = flat.filter((m) => tracked.includes(m));
    expect(present.length === 0 || present.length === tracked.length).toBe(true);
  });
});

const OK_COMPLETION = {
  modelId: 'gpt-4.1-mini',
  usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
  choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }],
};

describe('agent session with history machinery', () => {
  it('memory:false sessions maintain history by default (0.10.0 contract)', async () => {
    hoisted.generateCompletion.mockResolvedValue(OK_COMPLETION);
    const a = agent({ provider: 'openai', model: 'gpt-4.1-mini', memory: false });
    const s = a.session('t1');
    await s.send('first');
    await s.send('second');
    const roles = s.messages().map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('history:false restores stateless sessions (escape hatch)', async () => {
    hoisted.generateCompletion.mockResolvedValue(OK_COMPLETION);
    const a = agent({ provider: 'openai', model: 'gpt-4.1-mini', memory: false, history: false });
    const s = a.session('t2');
    await s.send('first');
    await s.send('second');
    expect(s.messages()).toHaveLength(0);
  });

  it('send options forward generation controls with send-level precedence', async () => {
    hoisted.generateCompletion.mockResolvedValue(OK_COMPLETION);
    const a = agent({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      memory: false,
      cache: { ttl: '1h' },
    });
    const s = a.session('t3');
    await s.send('go', {
      toolChoice: 'auto',
      requestTimeout: 5_000,
      cache: false,
      blockLabel: 'iter-1',
    } as never);
    const calls = hoisted.generateCompletion.mock.calls as unknown[][];
    const opts = (calls[calls.length - 1]?.[2] ?? {}) as { cache?: unknown; requestTimeout?: number };
    expect(opts.cache).toBe(false);
    expect(opts.requestTimeout).toBe(5_000);
  });

  it('reseed mid-flight: a send that started pre-reseed does not append post-reseed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    hoisted.generateCompletion.mockImplementation(async () => {
      await gate;
      return {
        modelId: 'gpt-4.1-mini',
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        choices: [{ message: { role: 'assistant', content: 'slow' }, finishReason: 'stop' }],
      };
    });
    const a = agent({ provider: 'openai', model: 'gpt-4.1-mini', memory: false });
    const s = a.session('t4');
    const inflight = s.send('slow question');
    s.reseed([{ role: 'user', content: 'fresh snapshot' }] as never);
    release();
    await inflight;
    expect(JSON.stringify(s.messages())).not.toContain('slow question');
    expect(JSON.stringify(s.messages())).toContain('fresh snapshot');
  });
});
