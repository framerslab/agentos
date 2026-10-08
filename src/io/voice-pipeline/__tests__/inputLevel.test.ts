import { describe, expect, it } from 'vitest';
import { InputSilenceWatch, inputLevelDb } from '../inputLevel.js';

describe('inputLevelDb', () => {
  it('is the root mean square in decibels of full scale, and minus infinity for silence or no samples', () => {
    expect(inputLevelDb(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(0, 6);
    expect(inputLevelDb(new Float32Array([0.5, -0.5]))).toBeCloseTo(-6.0206, 3);
    expect(inputLevelDb(new Float32Array(4))).toBe(-Infinity);
    expect(inputLevelDb(new Float32Array(0))).toBe(-Infinity);
  });
});

describe('InputSilenceWatch', () => {
  it('is silent after five seconds with nothing above the floor since the input was chosen', () => {
    const watch = new InputSilenceWatch();
    watch.reset(0);
    expect(watch.push(-70, 4_999)).toBe(false);
    expect(watch.push(-70, 5_000)).toBe(true);
    // A level above the floor clears it. Another input, chosen at 6 s, is not heard yet
    // and gets its own five seconds.
    expect(watch.push(-30, 5_100)).toBe(false);
    watch.reset(6_000);
    expect(watch.push(-70, 10_999)).toBe(false);
    expect(watch.push(-70, 11_000)).toBe(true);
  });

  it('is not silent in a quiet pause once the input was heard, but is after five seconds of a dead signal', () => {
    const watch = new InputSilenceWatch();
    watch.reset(0);
    watch.push(-30, 100);
    expect(watch.push(-80, 20_000)).toBe(false);
    expect(watch.push(-Infinity, 20_100)).toBe(false);
    expect(watch.push(-Infinity, 25_100)).toBe(true);
    expect(watch.push(-40, 25_200)).toBe(false);
  });

  it('counts afresh on a restart and keeps whether the input was heard', () => {
    const watch = new InputSilenceWatch({ afterMs: 1_000 });
    watch.reset(0);
    watch.push(-20, 10);
    watch.restart(5_000);
    expect(watch.push(-80, 7_000)).toBe(false);
    // After a restart a dead signal counts from the restart, not from the last block
    // that carried a signal.
    watch.restart(9_000);
    expect(watch.push(-Infinity, 9_999)).toBe(false);
    expect(watch.push(-Infinity, 10_000)).toBe(true);
    // An input not heard yet counts its time below the floor from the restart, and is still not heard.
    const unheard = new InputSilenceWatch({ afterMs: 1_000 });
    unheard.reset(0);
    unheard.restart(5_000);
    expect(unheard.push(-70, 5_999)).toBe(false);
    expect(unheard.push(-70, 6_000)).toBe(true);
  });
});
