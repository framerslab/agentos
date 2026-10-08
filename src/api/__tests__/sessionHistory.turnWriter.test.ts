/**
 * The session store's turn writer (GMI path): a turn's model steps accumulate
 * and land as one block, so eviction never separates a tool call from its
 * result, and a turn that fails after some steps keeps them, marked partial.
 */
import { describe, expect, it } from 'vitest';
import { SessionHistoryBuffer, SESSION_HISTORY_DEFAULTS } from '../sessionHistory.js';
import type { SessionTranscriptMessage } from '../sessionTranscript.js';

const user = (t: string): SessionTranscriptMessage => ({ role: 'user', content: t });
const say = (t: string): SessionTranscriptMessage => ({ role: 'assistant', content: t });
const call = (id: string): SessionTranscriptMessage => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'lookup', arguments: '{}' } }] });
const result = (id: string): SessionTranscriptMessage => ({ role: 'tool', tool_call_id: id, content: '{"ok":true}' });

describe('SessionHistoryBuffer turn writer', () => {
  it('stores a committed turn as one block, steps in order', () => {
    const b = new SessionHistoryBuffer(SESSION_HISTORY_DEFAULTS);
    const turn = b.beginTurn();
    expect(turn.appendStep([user('Look it up.'), call('c1'), result('c1')])).toBe(true);
    expect(turn.appendStep([say('Found it.')])).toBe(true);
    expect(turn.commit()).toBe(true);
    expect(b.blockCount()).toBe(1);
    expect(b.messages().map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('refuses a step whose tool calls are not all answered, and keeps what it had', () => {
    const b = new SessionHistoryBuffer(SESSION_HISTORY_DEFAULTS);
    const turn = b.beginTurn();
    expect(turn.appendStep([user('Go.'), call('c1')])).toBe(false);
    expect(turn.appendStep([user('Go.'), say('Done.')])).toBe(true);
    turn.commit();
    expect(b.messages().length).toBe(2);
  });

  it('abort with partial stores the finished steps marked partial; plain abort stores nothing', () => {
    const b = new SessionHistoryBuffer(SESSION_HISTORY_DEFAULTS);
    const failed = b.beginTurn();
    failed.appendStep([user('Look it up.'), call('c1'), result('c1')]);
    expect(failed.abort({ partial: true })).toBe(true);
    const last = b.messages().at(-1) as SessionTranscriptMessage & { partial?: boolean };
    expect(last).toMatchObject({ role: 'tool', partial: true });
    const dropped = b.beginTurn();
    dropped.appendStep([user('Again.'), say('No.')]);
    expect(dropped.abort()).toBe(false);
    expect(b.blockCount()).toBe(1);
  });

  it('discards a turn that began before a reseed', () => {
    const b = new SessionHistoryBuffer(SESSION_HISTORY_DEFAULTS);
    const turn = b.beginTurn('label');
    turn.appendStep([user('Hi.'), say('Hello.')]);
    b.reseed([]);
    expect(turn.commit()).toBe(false);
    expect(b.messages()).toEqual([]);
    expect(b.drainHistoryEvents()).toContainEqual({ type: 'stale-append-discarded', label: 'label' });
  });

  it('evicts only at commit, whole turns, and keeps the newest minKeepSends turns', () => {
    const b = new SessionHistoryBuffer({ maxTokens: 30, evictChunkRatio: 0.5, minKeepSends: 1 });
    for (const t of ['one two three four five six seven eight', 'nine ten eleven twelve thirteen fourteen', 'fifteen sixteen seventeen eighteen nineteen']) {
      const turn = b.beginTurn();
      turn.appendStep([user(t), say(t)]);
      turn.commit();
    }
    expect(b.blockCount()).toBeLessThan(3);
    expect(b.messages().at(-1)).toEqual(say('fifteen sixteen seventeen eighteen nineteen'));
    expect(b.drainHistoryEvents().some((e) => e.type === 'eviction')).toBe(true);
  });

  it('a second commit or an append after commit does nothing', () => {
    const b = new SessionHistoryBuffer(SESSION_HISTORY_DEFAULTS);
    const turn = b.beginTurn();
    turn.appendStep([user('Hi.'), say('Hello.')]);
    expect(turn.commit()).toBe(true);
    expect(turn.commit()).toBe(false);
    expect(turn.appendStep([say('late')])).toBe(false);
    expect(b.messages().length).toBe(2);
  });

  it('the partial marker never reaches a provider replay message', async () => {
    const { toProviderReplayMessage } = await import('../sessionTranscript.js');
    const b = new SessionHistoryBuffer(SESSION_HISTORY_DEFAULTS);
    const turn = b.beginTurn();
    turn.appendStep([user('Go.'), say('Half done.')]);
    turn.abort({ partial: true });
    const replayed = b.messages().map((m) => toProviderReplayMessage(m));
    expect(replayed.at(-1)).toEqual({ role: 'assistant', content: 'Half done.' });
  });
});
