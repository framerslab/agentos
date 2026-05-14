/**
 * Unit tests for the agency provenance recorder. Verifies that callback
 * wrapping captures events without dropping the original handlers, the
 * hash chain links events deterministically when enabled, the `record`
 * map opts individual kinds out, and `recordFinalOutput` seals the trail.
 */

import { describe, expect, it, vi } from 'vitest';
import { createAgencyProvenanceRecorder } from './agency-provenance.js';

describe('createAgencyProvenanceRecorder', () => {
  it('records each callback into the trail in order', () => {
    const recorder = createAgencyProvenanceRecorder({ enabled: true });
    const wrapped = recorder.wrapCallbacks();
    wrapped.agentStart?.({ agent: 'researcher', input: 'topic', timestamp: 1 });
    wrapped.toolCall?.({
      agent: 'researcher',
      toolName: 'web_search',
      args: { q: 'x' },
      timestamp: 2,
    } as any);
    wrapped.agentEnd?.({
      agent: 'researcher',
      output: 'done',
      durationMs: 100,
      timestamp: 3,
    } as any);

    const trail = recorder.getTrail();
    expect(trail.events.map((e) => e.kind)).toEqual(['agentStart', 'toolCall', 'agentEnd']);
    expect(trail.events.map((e) => e.sequence)).toEqual([0, 1, 2]);
    expect(trail.hashChain).toBe(false);
    expect(trail.tipHash).toBeUndefined();
  });

  it('delegates to caller-supplied callbacks without dropping events', () => {
    const original = { agentStart: vi.fn(), toolCall: vi.fn() };
    const recorder = createAgencyProvenanceRecorder({ enabled: true });
    const wrapped = recorder.wrapCallbacks(original as any);

    wrapped.agentStart?.({ agent: 'a', input: 'x', timestamp: 1 } as any);
    wrapped.toolCall?.({ agent: 'a', toolName: 't', args: {}, timestamp: 2 } as any);

    expect(original.agentStart).toHaveBeenCalledTimes(1);
    expect(original.toolCall).toHaveBeenCalledTimes(1);
    expect(recorder.getTrail().events).toHaveLength(2);
  });

  it('chains payload hashes when hashChain is enabled', () => {
    const recorder = createAgencyProvenanceRecorder({ enabled: true, hashChain: true });
    const wrapped = recorder.wrapCallbacks();
    wrapped.agentStart?.({ agent: 'a', input: 'x', timestamp: 1 } as any);
    wrapped.agentEnd?.({
      agent: 'a',
      output: 'y',
      durationMs: 5,
      timestamp: 2,
    } as any);

    const trail = recorder.getTrail();
    expect(trail.hashChain).toBe(true);
    for (const event of trail.events) {
      expect(event.chainHash).toMatch(/^[0-9a-f]{64}$/);
      expect(event.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    }
    // Tip equals the last event's chain hash.
    expect(trail.tipHash).toBe(trail.events.at(-1)?.chainHash);
    // Adjacent events have different chain hashes.
    expect(trail.events[0]?.chainHash).not.toBe(trail.events[1]?.chainHash);
  });

  it('honours the record flag map to opt kinds out', () => {
    const recorder = createAgencyProvenanceRecorder({
      enabled: true,
      record: { agentStart: true, toolCall: false },
    });
    const wrapped = recorder.wrapCallbacks();
    wrapped.agentStart?.({ agent: 'a', input: 'x', timestamp: 1 } as any);
    wrapped.toolCall?.({ agent: 'a', toolName: 't', args: {}, timestamp: 2 } as any);
    wrapped.agentEnd?.({
      agent: 'a',
      output: 'y',
      durationMs: 5,
      timestamp: 3,
    } as any);

    const kinds = recorder.getTrail().events.map((e) => e.kind);
    expect(kinds).toContain('agentStart');
    expect(kinds).toContain('agentEnd'); // not in `record`, so defaults to recorded
    expect(kinds).not.toContain('toolCall');
  });

  it('seals the trail with a final-output event', () => {
    const recorder = createAgencyProvenanceRecorder({ enabled: true });
    const before = recorder.getTrail();
    expect(before.finalizedAt).toBeUndefined();

    recorder.recordFinalOutput({ text: 'final answer', usage: { tokens: 100 } });

    const after = recorder.getTrail();
    expect(after.finalizedAt).toBeDefined();
    expect(after.events.at(-1)?.kind).toBe('finalOutput');
    expect((after.events.at(-1)?.payload as any).text).toBe('final answer');
  });

  it('captures error events with the stripped Error shape', () => {
    const recorder = createAgencyProvenanceRecorder({ enabled: true });
    const wrapped = recorder.wrapCallbacks();
    const err = new Error('boom');
    wrapped.error?.({ agent: 'a', error: err, timestamp: 1 });

    const evt = recorder.getTrail().events[0];
    expect(evt.kind).toBe('error');
    expect((evt.payload as any).message).toBe('boom');
    // The full Error instance is not serialised — only the message + stack.
    expect((evt.payload as any).error).toBeUndefined();
  });

  it('produces a stable payloadHash for identical payloads regardless of key order', () => {
    const recorderA = createAgencyProvenanceRecorder({ enabled: true, hashChain: true });
    const recorderB = createAgencyProvenanceRecorder({ enabled: true, hashChain: true });
    recorderA.wrapCallbacks().agentStart?.({
      agent: 'a',
      input: 'x',
      timestamp: 1,
    } as any);
    recorderB.wrapCallbacks().agentStart?.({
      timestamp: 1,
      input: 'x',
      agent: 'a',
    } as any);
    expect(recorderA.getTrail().events[0]?.payloadHash).toBe(
      recorderB.getTrail().events[0]?.payloadHash,
    );
  });
});
