/**
 * Which chat messages stop a run. A bot's notice tells people to type the stop phrase, so it holds the phrase, and in a
 * meeting with two bots each one reads the other's notices in the chat. Only a message that is the phrase is a stop.
 */
import { describe, it, expect } from 'vitest';
import { harness } from './manager-harness.js';

type Harness = ReturnType<typeof harness>;

/** A stop phrase in mixed case, as a product names it after itself. */
const STOP_PHRASE = 'Notetaker stop';

/** A person's bot's notice and its short form, written as a product writes them: both tell people to type the phrase. */
function noticeFor(person: string) {
  const link = `https://notes.example/n/${person.toLowerCase()}`;
  return {
    text: `${person} is using Notetaker to take notes in this call. The bot records nothing: the sound is turned into text and dropped at once. Nothing of the call is kept after it ends. Type ${STOP_PHRASE} and I'll leave and delete everything I took. Open ${link} to stop it.`,
    version: '1',
    lateArrivalText: `${person}'s Notetaker is taking notes in this call; type ${STOP_PHRASE} or open ${link} to make it leave and delete everything it took.`,
  };
}

/** Sends a person's bot and takes its run into the call with its capture open. */
async function joined(h: Harness, person: string): Promise<string> {
  const sent = await h.manager.sendBot({ ...h.request, idempotencyKey: person, stopPhrase: STOP_PHRASE, notice: noticeFor(person) });
  if (!sent.ok) throw new Error(`the send for ${person} was refused`);
  const runId = sent.run.runId;
  await h.manager.tick();
  await h.report(runId, 'joining');
  await h.report(runId, 'in_call', { participantCount: 2 });
  await h.report(runId, 'notice_posted');
  await h.report(runId, 'monitor_heartbeat', {}, h.clock.now() + 1); // the monitor's first observation after the notice opens capture
  return runId;
}

async function stateOf(h: Harness, runId: string): Promise<string | undefined> {
  return (await h.stores.runs.get(runId))?.state;
}

/** Whether the bot was told to leave. */
function toldToLeave(h: Harness, runId: string): boolean {
  return (h.provider.commands.get(runId) ?? []).some((command) => command.name === 'leave');
}

describe('the stop phrase in the chat', () => {
  it('stops the run on a message that is the phrase, whatever its case, the whitespace around and inside it, and its closing punctuation', async () => {
    for (const text of ['Notetaker stop', '  notetaker STOP!', 'Notetaker stop.', 'NOTETAKER  stop?!', '\tNotetaker stop \n']) {
      const h = harness();
      const runId = await joined(h, 'Dana');
      await h.report(runId, 'chat_message', { text, sender: 'Sam' });
      expect({ text, state: await stateOf(h, runId) }).toEqual({ text, state: 'purging' });
      expect(h.provider.commands.get(runId)?.slice(1)).toEqual([{ name: 'suspendCapture' }, { name: 'leave', reason: 'stopped_by_participant' }]);
    }
  });

  it("leaves the run in the call on another bot's notice, which holds the phrase inside a longer message", async () => {
    const h = harness();
    const runId = await joined(h, 'Dana');
    await h.report(runId, 'chat_message', { text: noticeFor('Sam').text, sender: "Sam's Notetaker" });
    expect(await stateOf(h, runId)).toBe('in_call');
    expect(toldToLeave(h, runId)).toBe(false);
    // the notice is an ordinary chat message: stored and handed to the handlers
    expect(h.seen.filter((e) => e.type === 'bot:chat_message' && e.runId === runId)).toHaveLength(1);
  });

  it("leaves the run in the call on another bot's short notice to a late arrival", async () => {
    const h = harness();
    const runId = await joined(h, 'Dana');
    await h.report(runId, 'chat_message', { text: noticeFor('Sam').lateArrivalText, sender: "Sam's Notetaker" });
    expect(await stateOf(h, runId)).toBe('in_call');
    expect(toldToLeave(h, runId)).toBe(false);
  });

  it('leaves the run in the call on a message that holds the phrase among other words', async () => {
    for (const text of ['Notetaker stop please', 'ok, Notetaker stop', 'Notetaker stopped taking notes?']) {
      const h = harness();
      const runId = await joined(h, 'Dana');
      await h.report(runId, 'chat_message', { text, sender: 'Sam' });
      expect({ text, state: await stateOf(h, runId), left: toldToLeave(h, runId) }).toEqual({ text, state: 'in_call', left: false });
    }
  });

  it("keeps two bots in one chat running when each reads the other's notices, and the phrase still stops both", async () => {
    const h = harness();
    const dana = await joined(h, 'Dana');
    const sam = await joined(h, 'Sam');
    // each bot reads the other's notice, and the short form each one posts when the other arrives
    await h.report(dana, 'chat_message', { text: noticeFor('Sam').text, sender: "Sam's Notetaker" });
    await h.report(sam, 'chat_message', { text: noticeFor('Dana').lateArrivalText, sender: "Dana's Notetaker" });
    await h.report(sam, 'chat_message', { text: noticeFor('Dana').text, sender: "Dana's Notetaker" });
    await h.report(dana, 'chat_message', { text: noticeFor('Sam').lateArrivalText, sender: "Sam's Notetaker" });
    expect([await stateOf(h, dana), await stateOf(h, sam)]).toEqual(['in_call', 'in_call']);
    expect([toldToLeave(h, dana), toldToLeave(h, sam)]).toEqual([false, false]);
    // a participant who types the phrase stops every bot that reads it
    await h.report(dana, 'chat_message', { text: 'Notetaker stop', sender: 'Lee' });
    await h.report(sam, 'chat_message', { text: 'Notetaker stop', sender: 'Lee' });
    expect([await stateOf(h, dana), await stateOf(h, sam)]).toEqual(['purging', 'purging']);
  });

  it('stops the run on a stop_command, which carries no text', async () => {
    const h = harness();
    const runId = await joined(h, 'Dana');
    await h.report(runId, 'stop_command', { sender: 'Sam' });
    expect(await stateOf(h, runId)).toBe('purging');
    expect(h.provider.commands.get(runId)?.slice(1)).toEqual([{ name: 'suspendCapture' }, { name: 'leave', reason: 'stopped_by_participant' }]);
  });
});
