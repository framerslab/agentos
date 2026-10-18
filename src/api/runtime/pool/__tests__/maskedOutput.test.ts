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
