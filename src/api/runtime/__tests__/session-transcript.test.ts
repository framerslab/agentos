import { describe, expect, it } from 'vitest';
import {
  validateTranscriptPairing,
  toProviderReplayMessage,
  transcriptTokenText,
  type SessionTranscriptMessage,
} from '../../sessionTranscript.js';

const VALID: SessionTranscriptMessage[] = [
  { role: 'user', content: 'build the game' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'tc_1', type: 'function', function: { name: 'ReadCurrentBundle', arguments: '{}' } },
      {
        id: 'tc_2',
        type: 'function',
        function: { name: 'RunSandboxTest', arguments: '{"suite":"boot"}' },
      },
    ],
  },
  { role: 'tool', tool_call_id: 'tc_1', content: '{"iteration":3}' },
  { role: 'tool', tool_call_id: 'tc_2', content: '{"passed":true}' },
  { role: 'assistant', content: 'Both tracks look green.' },
];

describe('validateTranscriptPairing', () => {
  it('accepts a valid parallel-tool transcript', () => {
    expect(validateTranscriptPairing(VALID)).toEqual({ ok: true });
  });

  it('rejects an orphan tool result (no preceding assistant tool_call with that id)', () => {
    const orphan: SessionTranscriptMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'tc_x', content: '{}' },
    ];
    const verdict = validateTranscriptPairing(orphan);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/orphan tool result/i);
  });

  it('rejects a tool_call with no following result before the next user turn', () => {
    const dangling: SessionTranscriptMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'T', arguments: '{}' } }],
      },
      { role: 'user', content: 'next' },
    ];
    const verdict = validateTranscriptPairing(dangling);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/unanswered tool_call/i);
  });

  it('preserves thinking blocks verbatim (opaque pass-through fields survive)', () => {
    const withThinking: SessionTranscriptMessage[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: 'a',
        thinking: { text: 'chain', signature: 'sig_abc' },
      },
    ];
    expect(validateTranscriptPairing(withThinking)).toEqual({ ok: true });
    expect(withThinking[1]).toHaveProperty('thinking.signature', 'sig_abc');
  });
});

describe('transcriptTokenText', () => {
  it('serializes text, tool arguments, tool results, and thinking deterministically', () => {
    const a = transcriptTokenText(VALID);
    const b = transcriptTokenText(VALID);
    expect(a).toBe(b);
    expect(a).toContain('ReadCurrentBundle');
    expect(a).toContain('"suite":"boot"');
    expect(a).toContain('{"passed":true}');
    expect(a).toContain('Both tracks look green.');
  });
});

describe('toProviderReplayMessage', () => {
  it('keeps a plain message as role and content only', () => {
    expect(toProviderReplayMessage({ role: 'user', content: 'hi' })).toEqual({ role: 'user', content: 'hi' });
  });

  it('prefers recorded thinkingBlocks over the documented thinking shape', () => {
    const blocks = [{ type: 'thinking', thinking: 'recorded', signature: 's1' }];
    expect(
      toProviderReplayMessage({
        role: 'assistant',
        content: null,
        thinkingBlocks: blocks,
        thinking: { text: 'other', signature: 's2' },
      } as never),
    ).toMatchObject({ thinkingBlocks: blocks });
  });

  it('maps redacted thinking to a redacted_thinking block and drops unsigned thinking', () => {
    expect(
      toProviderReplayMessage({ role: 'assistant', content: 'a', thinking: { text: '', redacted: 'opaque' } } as never),
    ).toEqual({ role: 'assistant', content: 'a', thinkingBlocks: [{ type: 'redacted_thinking', data: 'opaque' }] });
    expect(
      toProviderReplayMessage({ role: 'assistant', content: 'a', thinking: { text: 'unsigned' } } as never),
    ).toEqual({ role: 'assistant', content: 'a' });
  });
});
