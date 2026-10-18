import { describe, expect, it } from 'vitest';
import { createErrorMask } from '../redact.js';
import { maskedPrebuilt, maskStreamMembers } from '../maskedOutput.js';
import { isAgent } from '../../strategies/shared.js';
import type { Agent } from '../../../types.js';

const SECRET = 'sk-unit-secret-0001';
const mask = createErrorMask({ list: [SECRET] });

async function* pieces(...items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield item;
}
async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/** A pre-built seat whose answers, parts and promises all carry the secret. */
const seat = {
  description: 'a seat',
  dependsOn: ['other'],
  generate: async () => ({
    text: `saw ${SECRET}`,
    toolCalls: [{ name: 't', args: { k: SECRET }, result: [SECRET] }],
    usage: { totalTokens: 3 },
  }),
  stream: () => ({
    textStream: pieces('the key is sk-unit-', 'secret-0001 now'),
    fullStream: pieces({ type: 'text', text: `x ${SECRET}` }, { type: 'error', error: new Error(`boom ${SECRET}`) }),
    text: Promise.resolve(`t ${SECRET}`),
    usage: Promise.reject(new Error(`u ${SECRET}`)),
  }),
  session: () => ({}),
  usage: async () => ({}),
  close: async () => {},
} as unknown as Agent;

type Streamed = {
  textStream: AsyncIterable<string>;
  fullStream: AsyncIterable<Record<string, unknown>>;
  text: Promise<string>;
  usage: Promise<unknown>;
};

describe('maskedPrebuilt', () => {
  it('is still an agent with its description and dependencies, and its generate() result comes out with every string masked', async () => {
    const masked = maskedPrebuilt(seat, mask);
    expect(isAgent(masked)).toBe(true);
    expect((masked as unknown as { description: string }).description).toBe('a seat');
    expect((masked as unknown as { dependsOn: string[] }).dependsOn).toEqual(['other']);
    expect(await masked.generate('go')).toEqual({
      text: 'saw [redacted]',
      toolCalls: [{ name: 't', args: { k: '[redacted]' }, result: ['[redacted]'] }],
      usage: { totalTokens: 3 },
    });
  });

  it('its stream() masks a secret split between two text pieces whole, the parts, the error part and every promise, settled or rejected', async () => {
    const streamed = maskedPrebuilt(seat, mask).stream('go') as unknown as Streamed;
    expect((await drain(streamed.textStream)).join('')).toBe('the key is [redacted] now');
    const parts = await drain(streamed.fullStream);
    expect(parts[0]).toEqual({ type: 'text', text: 'x [redacted]' });
    expect((parts[1].error as Error).message).toBe('boom [redacted]');
    expect(await streamed.text).toBe('t [redacted]');
    await expect(streamed.usage).rejects.toThrow('u [redacted]');
  });

  it('a generate() that rejects leaves it masked, as its stream does', async () => {
    const failing = { ...seat, generate: async () => { throw new Error(`refused ${SECRET}`); } } as unknown as Agent;
    await expect(maskedPrebuilt(failing, mask).generate('go')).rejects.toThrow('refused [redacted]');
  });

  it('its stream() masks the other strings of a text part and of an error part, on the text released at once and on the text held for a later piece', async () => {
    const chatty = {
      ...seat,
      stream: () => ({
        fullStream: pieces(
          { type: 'text', text: 'plain', agent: 'a', note: `n ${SECRET}` },
          { type: 'error', error: new Error('e'), agent: 'a', detail: `d ${SECRET}` },
          // The tail could start the secret: 'held ' is released now, 'sk-unit-' when the stream ends.
          { type: 'text', text: 'held sk-unit-', agent: 'b', note: `m ${SECRET}` },
        ),
      }),
    } as unknown as Agent;
    const parts = await drain((maskedPrebuilt(chatty, mask).stream('go') as unknown as Streamed).fullStream);
    expect(parts).toHaveLength(4);
    expect(parts[0]).toEqual({ type: 'text', text: 'plain', agent: 'a', note: 'n [redacted]' });
    expect(parts[1]).toMatchObject({ type: 'error', agent: 'a', detail: 'd [redacted]' });
    expect((parts[1].error as Error).message).toBe('e');
    expect(parts[2]).toEqual({ type: 'text', text: 'held ', agent: 'b', note: 'm [redacted]' });
    expect(parts[3]).toEqual({ type: 'text', text: 'sk-unit-', agent: 'b', note: 'm [redacted]' });
    expect(JSON.stringify(parts)).not.toContain(SECRET);
  });

  it("its stream() masks a secret split around a tool call and its result whole: the parts that waited behind the held tail come out before the masked text, and another agent's text passes meanwhile", async () => {
    // 'sk-unit-' could start the secret, so it is held when the tool parts arrive; the next text piece of the same agent completes it.
    const tooled = {
      ...seat,
      stream: () => ({
        fullStream: pieces(
          { type: 'text', text: 'the key is sk-unit-', agent: 'a' },
          { type: 'tool-call', toolName: 't', args: {}, agent: 'a' },
          { type: 'tool-result', toolName: 't', result: { ok: true }, agent: 'a' },
          { type: 'text', text: 'hello', agent: 'b' },
          { type: 'text', text: 'secret-0001 now', agent: 'a' },
        ),
      }),
    } as unknown as Agent;
    const parts = await drain((maskedPrebuilt(tooled, mask).stream('go') as unknown as Streamed).fullStream);
    expect(parts.filter((p) => p.type === 'text' && p.agent === 'a').map((p) => p.text).join('')).toBe('the key is [redacted] now');
    expect(JSON.stringify(parts)).not.toContain(SECRET);
    expect(parts.map((p) => [p.type, p.agent, p.text])).toEqual([
      ['text', 'a', 'the key is '],
      ['text', 'b', 'hello'],
      ['tool-call', 'a', undefined],
      ['tool-result', 'a', undefined],
      ['text', 'a', '[redacted] now'],
    ]);
  });

  it('a held tail that turns out to be no secret comes out before the parts that waited behind it, and a tail held at the end before them too; a stream error releases both and is thrown masked', async () => {
    const benign = {
      ...seat,
      stream: () => ({
        fullStream: pieces(
          { type: 'text', text: 'ends with sk-', agent: 'a' },
          { type: 'tool-call', toolName: 't', args: {}, agent: 'a' },
          { type: 'text', text: 'y more', agent: 'a' },
          { type: 'text', text: 'then sk-unit-', agent: 'a' },
          { type: 'tool-result', toolName: 't', result: 'late', agent: 'a' },
        ),
      }),
    } as unknown as Agent;
    expect(await drain((maskedPrebuilt(benign, mask).stream('go') as unknown as Streamed).fullStream)).toEqual([
      { type: 'text', text: 'ends with ', agent: 'a' },
      { type: 'text', text: 'sk-', agent: 'a' },
      { type: 'tool-call', toolName: 't', args: {}, agent: 'a' },
      { type: 'text', text: 'y more', agent: 'a' },
      { type: 'text', text: 'then ', agent: 'a' },
      { type: 'text', text: 'sk-unit-', agent: 'a' },
      { type: 'tool-result', toolName: 't', result: 'late', agent: 'a' },
    ]);
    async function* failing(): AsyncGenerator<unknown> {
      yield { type: 'text', text: 'held sk-unit-' };
      yield { type: 'tool-call', toolName: 't', args: {} };
      throw new Error(`stream died ${SECRET}`);
    }
    const dying = { ...seat, stream: () => ({ fullStream: failing() }) } as unknown as Agent;
    const seen: Record<string, unknown>[] = [];
    let thrown: Error | undefined;
    try {
      for await (const part of (maskedPrebuilt(dying, mask).stream('go') as unknown as Streamed).fullStream) seen.push(part);
    } catch (error) {
      thrown = error as Error;
    }
    expect(seen).toEqual([{ type: 'text', text: 'held ' }, { type: 'text', text: 'sk-unit-' }, { type: 'tool-call', toolName: 't', args: {} }]);
    expect(thrown?.message).toBe('stream died [redacted]');
  });

  it('a part behind a held tail waits until the text before it is out: a piece that settles only part of the tail releases that part and keeps the part behind the rest, and parts that arrived between held pieces come out between them', async () => {
    // 'sk-unit-' is held when the tool call arrives; 's' keeps 'sk-unit-s' held, still a prefix of the secret; 'k' settles
    // 'sk-unit-' as no secret and holds 'sk', so the tool call comes out after 'sk-unit-' and before 'sk done'.
    const partial = {
      ...seat,
      stream: () => ({
        fullStream: pieces(
          { type: 'text', text: 'x sk-unit-', agent: 'a' },
          { type: 'tool-call', toolName: 't', args: {}, agent: 'a' },
          { type: 'text', text: 's', agent: 'a' },
          { type: 'text', text: 'k', agent: 'a' },
          { type: 'text', text: ' done', agent: 'a' },
        ),
      }),
    } as unknown as Agent;
    expect(await drain((maskedPrebuilt(partial, mask).stream('go') as unknown as Streamed).fullStream)).toEqual([
      { type: 'text', text: 'x ', agent: 'a' },
      { type: 'text', text: 'sk-unit-', agent: 'a' },
      { type: 'tool-call', toolName: 't', args: {}, agent: 'a' },
      { type: 'text', text: 'sk done', agent: 'a' },
    ]);
    // The tool call arrived after 'sk-' and the tool result after 'unit-', both held; 'x' settles the run as no secret.
    const between = {
      ...seat,
      stream: () => ({
        fullStream: pieces(
          { type: 'text', text: 'a sk-', agent: 'a' },
          { type: 'tool-call', toolName: 't', args: {}, agent: 'a' },
          { type: 'text', text: 'unit-', agent: 'a' },
          { type: 'tool-result', toolName: 't', result: 'r', agent: 'a' },
          { type: 'text', text: 'x', agent: 'a' },
        ),
      }),
    } as unknown as Agent;
    expect(await drain((maskedPrebuilt(between, mask).stream('go') as unknown as Streamed).fullStream)).toEqual([
      { type: 'text', text: 'a ', agent: 'a' },
      { type: 'text', text: 'sk-', agent: 'a' },
      { type: 'tool-call', toolName: 't', args: {}, agent: 'a' },
      { type: 'text', text: 'unit-', agent: 'a' },
      { type: 'tool-result', toolName: 't', result: 'r', agent: 'a' },
      { type: 'text', text: 'x', agent: 'a' },
    ]);
  });
});

describe('maskStreamMembers', () => {
  it('keeps members that are neither iterables nor promises, and leaves text with no secret as it came', async () => {
    const result = maskStreamMembers({ textStream: pieces('plain', ' text'), text: Promise.resolve('plain'), label: 'kept' }, mask);
    expect(result.label).toBe('kept');
    expect(await drain(result.textStream as AsyncIterable<string>)).toEqual(['plain', ' text']);
    expect(await result.text).toBe('plain');
  });

  it('releases the text held before a stream error, then throws the error masked', async () => {
    async function* failing(): AsyncGenerator<string> {
      yield 'held sk-unit-';
      throw new Error(`stream died ${SECRET}`);
    }
    const result = maskStreamMembers({ textStream: failing() }, mask);
    const seen: string[] = [];
    let thrown: Error | undefined;
    try {
      for await (const piece of result.textStream as AsyncIterable<string>) seen.push(piece);
    } catch (error) {
      thrown = error as Error;
    }
    expect(seen.join('')).toBe('held sk-unit-');
    expect(thrown?.message).toBe('stream died [redacted]');
  });
});
