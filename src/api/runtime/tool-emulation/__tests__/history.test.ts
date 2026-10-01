import { describe, expect, it } from 'vitest';
import { toShimMessages } from '../history';

describe('toShimMessages', () => {
  it('keeps each tool result paired with its call when results arrive out of order', () => {
    const shim = toShimMessages([
      { role: 'user', content: 'Weather and news?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
          { id: 'call_b', type: 'function', function: { name: 'get_news', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_b', content: '{"headline":"Rain"}' },
      { role: 'tool', tool_call_id: 'call_a', content: '{"temp_c":18}' },
    ]);

    expect(shim).toEqual([
      { role: 'user', content: 'Weather and news?' },
      {
        role: 'assistant',
        content:
          '<tool_call>{"name":"get_weather","arguments":{"city":"Paris"},"id":"call_a"}</tool_call>\n' +
          '<tool_call>{"name":"get_news","arguments":{},"id":"call_b"}</tool_call>',
      },
      {
        role: 'user',
        content:
          '<tool_response>{"id":"call_b","name":"get_news","output":{"headline":"Rain"}}</tool_response>\n' +
          '<tool_response>{"id":"call_a","name":"get_weather","output":{"temp_c":18}}</tool_response>',
      },
    ]);
  });

  it('keeps plain turns and non-JSON results as text', () => {
    expect(
      toShimMessages([
        { role: 'system', content: 'Be brief.' },
        { role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'c1', function: { name: 'ping', arguments: 'not json' } }] },
        { role: 'tool', tool_call_id: 'c1', name: 'ping', content: 'pong' },
      ]),
    ).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'assistant', content: 'Checking.\n<tool_call>{"name":"ping","arguments":"not json","id":"c1"}</tool_call>' },
      { role: 'user', content: '<tool_response>{"id":"c1","name":"ping","output":"pong"}</tool_response>' },
    ]);
  });
});
