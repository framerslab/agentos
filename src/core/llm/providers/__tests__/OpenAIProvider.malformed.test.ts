import { describe, it, expect, vi } from 'vitest';

vi.stubGlobal('fetch', vi.fn());

import { OpenAIProvider } from '../implementations/OpenAIProvider';

// CR7: the response mappers used to access `choices[0]` / `choices.map`
// unguarded under @ts-nocheck — a malformed response (missing `choices`) would
// throw a TypeError instead of degrading. These guard against that.
type Mapper = (resp: unknown, acc?: unknown) => { choices: unknown[] };
const priv = (p: OpenAIProvider, name: string) =>
  (p as unknown as Record<string, Mapper>)[name].bind(p);

describe('OpenAIProvider — malformed-response guards (CR7)', () => {
  it('mapApiToCompletionResponse returns empty choices instead of crashing when choices is absent', () => {
    const p = new OpenAIProvider();
    const out = priv(p, 'mapApiToCompletionResponse')({
      id: 'x', object: 'chat.completion', created: 1, model: 'gpt-4o',
    });
    expect(out.choices).toEqual([]);
  });

  it('mapApiToStreamChunkResponse returns empty choices instead of crashing on a chunk with no choices and no usage', () => {
    const p = new OpenAIProvider();
    const out = priv(p, 'mapApiToStreamChunkResponse')(
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o' },
      new Map(),
    );
    expect(out.choices).toEqual([]);
  });
});
