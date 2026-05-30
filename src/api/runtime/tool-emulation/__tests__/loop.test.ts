import { describe, it, expect, vi } from 'vitest';
import { runEmulatedToolLoop } from '../loop';

const recall = {
  id: 'r', name: 'recall', displayName: 'R', description: 'recall',
  inputSchema: { type: 'object', properties: {} },
  execute: vi.fn(async () => ({ success: true, output: { found: 'beach trip' } })),
} as any;

function fakeModel(scripted: string[]) {
  let i = 0;
  return vi.fn(async (_messages: any[]) => ({ text: scripted[i++] ?? '', usage: { totalTokens: 1 } }));
}

describe('runEmulatedToolLoop', () => {
  it('executes a tool then returns the tool-free final answer', async () => {
    const callModel = fakeModel([
      '<tool_call>{"name":"recall","arguments":{}}</tool_call>',
      'You went to the beach.',
    ]);
    const out = await runEmulatedToolLoop({
      tools: [recall], messages: [{ role: 'user', content: 'where did I go?' }],
      callModel, maxRoundtrips: 5,
    });
    expect(recall.execute).toHaveBeenCalledTimes(1);
    expect(out.text).toBe('You went to the beach.');
    expect(out.finishReason).toBe('stop');
    expect(out.toolCalls.map((c) => c.name)).toEqual(['recall']);
  });

  it('feeds an error tool_response back for an unknown tool', async () => {
    const callModel = fakeModel([
      '<tool_call>{"name":"nope","arguments":{}}</tool_call>',
      'ok',
    ]);
    const out = await runEmulatedToolLoop({
      tools: [recall], messages: [{ role: 'user', content: 'hi' }], callModel, maxRoundtrips: 5,
    });
    expect(out.text).toBe('ok');
    const secondCallMessages = callModel.mock.calls[1][0];
    expect(JSON.stringify(secondCallMessages)).toContain('error');
  });

  it('stops at maxRoundtrips and returns best-effort text', async () => {
    const callModel = fakeModel([
      '<tool_call>{"name":"recall","arguments":{}}</tool_call>',
      '<tool_call>{"name":"recall","arguments":{}}</tool_call>',
      '<tool_call>{"name":"recall","arguments":{}}</tool_call>',
    ]);
    const out = await runEmulatedToolLoop({
      tools: [recall], messages: [{ role: 'user', content: 'hi' }], callModel, maxRoundtrips: 2,
    });
    expect(out.finishReason).toBe('tool-calls');
  });
});
