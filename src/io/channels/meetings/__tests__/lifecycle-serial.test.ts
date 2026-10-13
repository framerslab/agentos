import { expect, it } from 'vitest';
import { LifecycleSerial } from '../LifecycleSerial.js';

/** Lets every pending callback run, so a work function that is free to start has started by the time it resolves. */
const nextTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

it('invalidates a pending start before suspension runs and never reopens an ending lifecycle', async () => {
  const serial = new LifecycleSerial();
  const seen: string[] = [];
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const stamp = serial.stamp();
  const start = serial.run(async () => { await gate; if (serial.allows(stamp)) seen.push('published'); });
  serial.invalidate();
  const suspend = serial.run(async () => { seen.push('suspended'); });
  serial.invalidate(true);
  const leave = serial.run(async () => { seen.push('left'); });
  resume();
  await Promise.all([start, suspend, leave]);
  expect(seen).toEqual(['suspended', 'left']);
  expect(serial.allows(serial.stamp())).toBe(false);
  expect(serial.ended).toBe(true);
});

it("starts a call's work only once the work queued before it has settled, and answers each call its own result", async () => {
  const serial = new LifecycleSerial();
  const seen: string[] = [];
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const first = serial.run(async () => { seen.push('first started'); await gate; seen.push('first settled'); return 'first'; });
  const second = serial.run(async () => { seen.push('second started'); return 'second'; });
  await nextTurn();
  // the first call's work is still pending, so the second's has not started
  expect(seen).toEqual(['first started']);
  finish();
  expect(await Promise.all([first, second])).toEqual(['first', 'second']);
  expect(seen).toEqual(['first started', 'first settled', 'second started']);
});

it('throws a rejection to its own caller and runs the next call once the rejected work has settled', async () => {
  const serial = new LifecycleSerial();
  const seen: string[] = [];
  let fail!: (err: Error) => void;
  const gate = new Promise<void>((_resolve, reject) => { fail = reject; });
  const first = serial.run(async () => { seen.push('first started'); await gate; seen.push('first finished'); });
  const second = serial.run(async () => { seen.push('second started'); return 'second'; });
  await nextTurn();
  expect(seen).toEqual(['first started']);
  fail(new Error('the first call failed'));
  await expect(first).rejects.toThrow('the first call failed');
  // the rejection reaches the first caller alone: the second call still runs and answers its own result
  await expect(second).resolves.toBe('second');
  expect(seen).toEqual(['first started', 'second started']);
});

it('keeps the fence a failed suspension or end put up, and lets a start stamped after a failed suspension publish', async () => {
  const serial = new LifecycleSerial();
  const seen: string[] = [];
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const stale = serial.stamp();
  const start = serial.run(async () => { await gate; seen.push(serial.allows(stale) ? 'stale start published' : 'stale start fenced'); });
  serial.invalidate();
  const suspend = serial.run(async () => { seen.push('suspension ran'); throw new Error('the suspension failed'); });
  const fresh = serial.stamp();
  const restart = serial.run(async () => { seen.push(serial.allows(fresh) ? 'restart published' : 'restart fenced'); });
  resume();
  await start;
  await expect(suspend).rejects.toThrow('the suspension failed');
  await restart;
  // the suspension invalidated the stale start when it was called, so its failure lowers nothing; a rejection invalidates no stamp
  expect(seen).toEqual(['stale start fenced', 'suspension ran', 'restart published']);
  serial.invalidate(true);
  await expect(serial.run(async () => { throw new Error('the leave failed'); })).rejects.toThrow('the leave failed');
  // an end whose own work failed is still an end, for every stamp taken before it or after
  expect(serial.ended).toBe(true);
  expect(serial.allows(fresh)).toBe(false);
  expect(serial.allows(serial.stamp())).toBe(false);
});
