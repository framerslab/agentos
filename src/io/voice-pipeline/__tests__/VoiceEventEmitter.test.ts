/**
 * Unit tests for VoiceEventEmitter.
 *
 * One behaviour suite runs against Node's EventEmitter and against the
 * library's emitter, so the voice pipeline keeps Node's semantics where it
 * moves off `node:events`. The two assignments below are the type check's
 * half: each emitter fits the other's type.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { VoiceEventEmitter, type EventEmitterLike } from '../VoiceEventEmitter.js';

// Checked by the type check: Node's emitter fits the contracts' emitter type,
// and a value of that type still fits where Node's type is expected.
const nodeFitsLike: EventEmitterLike = new EventEmitter();
const likeFitsNode: NodeJS.EventEmitter = new VoiceEventEmitter();
const conformance = [nodeFitsLike, likeFitsNode];

/** The two emitters the behaviour suite runs on. */
const EMITTERS: Array<{ name: string; make: () => EventEmitterLike }> = [
  { name: 'EventEmitter from node:events', make: () => new EventEmitter() },
  { name: 'VoiceEventEmitter', make: () => new VoiceEventEmitter() },
];

for (const { name, make } of EMITTERS) describe(name, () => {
  it('calls listeners in the order they were added, with the arguments and the emitter as this', () => {
    const emitter = make();
    const calls: string[] = [];
    let self: unknown;
    emitter.on('ping', function (this: unknown, a: number, b: string) {
      self = this;
      calls.push(`first ${a} ${b}`);
    });
    emitter.addListener('ping', (a: number) => calls.push(`second ${a}`));
    emitter.prependListener('ping', () => calls.push('prepended'));
    expect(emitter.emit('ping', 1, 'x')).toBe(true);
    expect(calls).toEqual(['prepended', 'first 1 x', 'second 1']);
    expect(self).toBe(emitter);
    expect(emitter.emit('nobody')).toBe(false);
  });

  it('removes a once listener before calling it, so an emit inside it does not call it again', () => {
    const emitter = make();
    let count = 0;
    emitter.once('ping', () => {
      count += 1;
      emitter.emit('ping');
    });
    emitter.emit('ping');
    emitter.emit('ping');
    expect(count).toBe(1);
    expect(emitter.listenerCount('ping')).toBe(0);
  });

  it('removes the most recently added instance of a listener, and a once listener by the function added', () => {
    const emitter = make();
    const calls: string[] = [];
    const a = () => calls.push('a');
    const b = () => calls.push('b');
    emitter.on('ping', a);
    emitter.on('ping', b);
    emitter.on('ping', a);
    emitter.off('ping', a);
    emitter.emit('ping');
    expect(calls).toEqual(['a', 'b']);
    const c = () => calls.push('c');
    emitter.once('ping', c);
    emitter.removeListener('ping', c);
    calls.length = 0;
    emitter.emit('ping');
    expect(calls).toEqual(['a', 'b']);
  });

  it('calls every listener present when the emit began, even one that a listener removes', () => {
    const emitter = make();
    const calls: string[] = [];
    const second = () => calls.push('second');
    emitter.on('ping', () => {
      calls.push('first');
      emitter.off('ping', second);
    });
    emitter.on('ping', second);
    emitter.emit('ping');
    emitter.emit('ping');
    expect(calls).toEqual(['first', 'second', 'first']);
  });

  it('lists, counts and names its listeners, a once listener as the function added', () => {
    const emitter = make();
    const a = () => undefined;
    const b = () => undefined;
    const tag = Symbol('tag');
    emitter.on('ping', a);
    emitter.once('ping', b);
    emitter.on(tag, a);
    expect(emitter.listeners('ping')).toEqual([a, b]);
    expect(emitter.rawListeners('ping')[0]).toBe(a);
    expect(emitter.rawListeners('ping')[1]).not.toBe(b);
    expect(emitter.listenerCount('ping')).toBe(2);
    expect(emitter.listenerCount('ping', b)).toBe(1);
    expect(emitter.eventNames()).toEqual(['ping', tag]);
    emitter.removeAllListeners('ping');
    expect(emitter.eventNames()).toEqual([tag]);
    emitter.removeAllListeners();
    expect(emitter.eventNames()).toEqual([]);
  });

  it('throws an error emitted with no error listener, and hands it to one that exists', () => {
    const emitter = make();
    const boom = new Error('boom');
    expect(() => emitter.emit('error', boom)).toThrow(boom);
    const seen = vi.fn();
    emitter.on('error', seen);
    expect(emitter.emit('error', boom)).toBe(true);
    expect(seen).toHaveBeenCalledWith(boom);
  });

  it('keeps a listener limit, 10 by default', () => {
    const emitter = make();
    expect(emitter.getMaxListeners()).toBe(10);
    expect(emitter.setMaxListeners(20)).toBe(emitter);
    expect(emitter.getMaxListeners()).toBe(20);
  });
});

describe('VoiceEventEmitter alone', () => {
  it('throws an Error naming a value that is not an Error, emitted as error with no listener', () => {
    expect(() => new VoiceEventEmitter().emit('error', 'disk full')).toThrow('Unhandled error. (disk full)');
  });
});
