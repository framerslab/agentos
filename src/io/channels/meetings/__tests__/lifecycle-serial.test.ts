import { expect, it } from 'vitest';
import { LifecycleSerial } from '../LifecycleSerial.js';

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
