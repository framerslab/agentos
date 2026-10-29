/**
 * What a launch's seat reports of its calls (`record()`), over a member whose session answers as each case says. Pure
 * seat logic: the surfaces' own tests run real members.
 */
import { describe, expect, it } from 'vitest';
import type { Agent } from '../../../types.js';
import { buildSessionSeat } from '../sessionSeat.js';

/**
 * A member whose session answers its sends in turn, each with its text; an Error is a send that rejects with it, and
 * `null` is a reply that never comes.
 */
function memberAnswering(answers: Array<string | Error | null>): Agent {
  const session = {
    id: 'seat:test',
    send: async () => {
      const answer = answers.shift() ?? null;
      if (answer === null) return new Promise<never>(() => undefined);
      if (answer instanceof Error) throw answer;
      return { text: answer, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, toolCalls: [] };
    },
    close: async () => undefined,
  };
  return { session: () => session, close: async () => undefined } as unknown as Agent;
}

describe('a seat record', () => {
  it('a call still running once its launch has stopped is cut, whatever the earlier calls came to', async () => {
    let stopped = false;
    const cutWhen = (): boolean => stopped;
    const first = buildSessionSeat(memberAnswering([null]), { form: 'temporary', role: 'first', cutWhen });
    const second = buildSessionSeat(memberAnswering(['First round.', null]), { form: 'temporary', role: 'second', cutWhen });
    void first.generate('Round 1.');
    await second.generate('Round 1.');
    void second.generate('Round 2.');
    // While the launch runs, a record is what its settled calls came to.
    expect(first.record()).toMatchObject({ status: 'not_run', calls: 1 });
    expect(second.record()).toMatchObject({ status: 'completed', calls: 2, summary: 'First round.' });
    stopped = true;
    // The launch has stopped: it reports without the answers still to come.
    expect(first.record()).toMatchObject({ status: 'cut', calls: 1 });
    expect(second.record()).toMatchObject({ status: 'cut', calls: 2, summary: 'First round.' });
  });

  it("a call cut while it runs carries no error of the seat's earlier call", async () => {
    let stopped = false;
    const failure = Object.assign(new Error('upstream failed'), { name: 'ProviderError', code: 'E_UPSTREAM' });
    const seat = buildSessionSeat(memberAnswering([failure, null]), { form: 'temporary', role: 'writer', cutWhen: () => stopped });
    await expect(seat.generate('Draft.')).rejects.toBe(failure);
    void seat.generate('Draft again.');
    // While the launch runs, the record is the failed call's, its error included (the precondition).
    expect(seat.record()).toMatchObject({ status: 'failed', calls: 2, error: { name: 'ProviderError', code: 'E_UPSTREAM' } });
    stopped = true;
    // The launch has stopped with the second call running: that call is cut, and no error ended it.
    const record = seat.record();
    expect(record).toMatchObject({ status: 'cut', calls: 2 });
    expect(record.error).toBeUndefined();
  });
});
