/**
 * @file GMI.launch-frame.test.ts
 * The launched team a turn sits in (`metadata.agencyLaunch`, which a `launch_agency` seat's turns carry): the GMI hands
 * each tool call of the turn a frozen copy of its own in `sessionData.agencyLaunch`, where a launch from that call reads
 * its parent; a tool continuation keeps the frame of the turn it continues; a turn that names none hands none.
 */
import { describe, expect, it } from 'vitest';
import { createScriptedGmi, runTurn, scriptedProvider, textReply, textTurn, toolCallReply } from './helpers/scriptedGmi';

const lookup = (id: string) => toolCallReply([{ id, name: 'lookup', args: { q: id } }]);

describe('the launch frame a GMI turn carries', () => {
  it('reaches each tool call as a frozen copy of its own, through a tool continuation, and never a turn that names none', async () => {
    const frame = { launchId: 'agency-1', role: 'checker', depth: 2 };
    const { provider } = scriptedProvider([
      toolCallReply([{ id: 'call_a', name: 'lookup', args: { q: 'a' } }, { id: 'call_b', name: 'lookup', args: { q: 'b' } }]),
      textReply('Found both.'),
      lookup('call_c'),
      textReply('Continued.'),
      lookup('call_d'),
      textReply('Done.'),
    ]);
    const { gmi, processToolCall } = await createScriptedGmi({ provider });
    const handed = () => processToolCall.mock.calls.map(([details]) => details.sessionData?.agencyLaunch);

    await runTurn(gmi, textTurn('t1', 'Look both up.', { agencyLaunch: frame }));
    // A continuation's input names no frame: its tool call sits in the team of the turn it continues.
    await gmi.handleToolResults([{ toolCallId: 'call_x', toolName: 'lookup', output: { ok: true } }], 'user-1');
    const frames = handed();
    expect(frames).toEqual([frame, frame, frame]);
    // A copy for each call, frozen: no tool changes the frame a later call reads, nor the turn's own.
    expect(new Set([frame, ...frames]).size).toBe(4);
    expect(frames.every((handedFrame) => Object.isFrozen(handedFrame))).toBe(true);

    // The next turn names none: its tool call's session data holds no frame.
    await runTurn(gmi, textTurn('t2', 'Look it up.'));
    expect(processToolCall).toHaveBeenCalledTimes(4);
    expect(processToolCall.mock.calls[3][0].sessionData).toEqual({ sessionId: 'session-1', conversationId: 'session-1' });
  });
});
