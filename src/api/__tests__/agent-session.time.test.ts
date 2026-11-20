/**
 * A session's start time and the time it has run, on both runtimes: `startedAt` is the epoch milliseconds of the
 * session's opening, `elapsedMs()` the milliseconds since. Handles of one open session id share the time; a session
 * opened after close() starts a new one. No model call is made.
 */
import { describe, expect, it } from 'vitest';
import { agent, type AgentOptions } from '../agent';

let n = 0;
const key = () => `k-session-time-${++n}`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const runtimes: Array<[string, Record<string, unknown>]> = [
  ['the default runtime', {}],
  ["runtime: 'gmi'", { runtime: 'gmi' }],
];

describe.each(runtimes)('a session on %s', (_label, runtime) => {
  it('reports when it started and how long it has run', async () => {
    const a = agent({ provider: 'openai', model: 'stub-model', apiKey: key(), fallbackProviders: [], ...runtime } as unknown as AgentOptions);
    try {
      const before = Date.now();
      const first = a.session('timed');
      const after = Date.now();
      expect(first.startedAt).toBeGreaterThanOrEqual(before);
      expect(first.startedAt).toBeLessThanOrEqual(after);

      const early = first.elapsedMs();
      expect(early).toBeGreaterThanOrEqual(0);
      await sleep(25);
      expect(first.elapsedMs()).toBeGreaterThan(early);
      expect(first.elapsedMs()).toBeGreaterThanOrEqual(20);

      // A second handle of the open id shares the session's start.
      const second = a.session('timed');
      expect(second.startedAt).toBe(first.startedAt);

      // A session opened after close() is a new one, with a later start.
      await first.close();
      const reopened = a.session('timed');
      expect(reopened.startedAt).toBeGreaterThan(first.startedAt);
      expect(reopened.elapsedMs()).toBeGreaterThanOrEqual(0);
    } finally {
      await a.close();
    }
  });
});
