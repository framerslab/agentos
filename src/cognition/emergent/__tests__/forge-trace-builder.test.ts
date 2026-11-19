/**
 * @fileoverview Unit tests of the forge trace's JSON-safe copy and its cuts: each field's JSON within its cap,
 * escaping included, a cut that ends on a whole character, and a marker in the place of each value JSON cannot write.
 */

import { describe, expect, it } from 'vitest';
import {
  jsonSafeCopy,
  traceString,
  traceText,
  traceValue,
  type ForgeTraceCut,
} from '../ForgeTrace.js';

/** The UTF-8 length of `value`'s JSON text. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** The character of `text` that starts at `index`: a whole surrogate pair, or one unit. */
function characterAt(text: string, index: number): string {
  return String.fromCodePoint(text.codePointAt(index)!);
}

/** `start` is a start of `text` that does not end between the two halves of a surrogate pair. */
function expectWholeCharacterStart(text: string, start: string): void {
  expect(text.startsWith(start)).toBe(true);
  const end = start.length;
  const splitsAPair = end > 0 && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end));
  expect(splitsAPair).toBe(false);
}

/**
 * `result` is the cut of `text` at `capBytes`: the whole text's UTF-8 length, its own JSON within the cap, and the
 * longest whole-character start that fits (one more character would not).
 */
function expectCutOf(text: string, capBytes: number, result: unknown): ForgeTraceCut {
  expect(result).toMatchObject({ $trace: 'cut' });
  const cut = result as ForgeTraceCut;
  expect(cut.bytes).toBe(Buffer.byteLength(text));
  expect(jsonBytes(cut)).toBeLessThanOrEqual(capBytes);
  expectWholeCharacterStart(text, cut.head);
  expect(jsonBytes({ ...cut, head: cut.head + characterAt(text, cut.head.length) })).toBeGreaterThan(capBytes);
  return cut;
}

const OTHER = { $trace: 'unserializable', kind: 'other' };

describe('forge trace: the copy and the cuts', () => {
  it('a text within its cap is kept whole', () => {
    const cut: string[] = [];
    expect(traceText('add_numbers', 256, 'toolName', cut)).toBe('add_numbers');
    // A text whose JSON, quotes included, is exactly the cap is kept: 254 ASCII letters, and 127 two-byte letters.
    expect(traceText('a'.repeat(254), 256, 'toolName', cut)).toBe('a'.repeat(254));
    expect(traceText('é'.repeat(127), 256, 'toolName', cut)).toBe('é'.repeat(127));
    // A value that is not a string is kept as its JSON text.
    expect(traceText({ code: 'E1', retry: false }, 256, 'reason', cut)).toBe('{"code":"E1","retry":false}');
    expect(traceText(42, 256, 'reason', cut)).toBe('42');
    expect(cut).toEqual([]);

    // One byte more is cut.
    expect(traceText('a'.repeat(255), 256, 'toolName', cut)).toMatchObject({ $trace: 'cut', bytes: 255 });
    expect(cut).toEqual(['toolName']);
  });

  it('a text over its cap keeps a whole-character head whose JSON fits the cap', () => {
    const texts = {
      ascii: 'a'.repeat(1000),
      emoji: 'ab' + '\u{1F600}'.repeat(300),
      cjk: '漢字かな'.repeat(200),
      loneSurrogates: 'x\ud800y\udc00z\ud800\u{1F600}'.repeat(80),
    };
    for (const [label, text] of Object.entries(texts)) {
      const cut: string[] = [];
      const result = traceText(text, 256, `texts.${label}`, cut);
      const marker = expectCutOf(text, 256, result);
      expect(marker.head.length).toBeGreaterThan(0);
      expect(cut).toEqual([`texts.${label}`]);
    }

    // In the emoji text the cap falls across a 4-byte character: the head stops before it, never inside it.
    const emoji = traceText(texts.emoji, 256, 'emoji', []) as ForgeTraceCut;
    expect(isHighSurrogate(texts.emoji.charCodeAt(emoji.head.length))).toBe(true);
    expect(isLowSurrogate(emoji.head.charCodeAt(emoji.head.length - 1))).toBe(true);
  });

  it('escaping counts toward the cap', () => {
    const text = '"\\\u0001'.repeat(5000);
    const cut: string[] = [];
    const result = traceText(text, 1024, 'reason', cut);
    expectCutOf(text, 1024, result);
    expect(cut).toEqual(['reason']);

    // A value's JSON holds the escapes once, and the cut's JSON escapes its head again: the cut fits all the same.
    const value = { text };
    const valueCut = traceValue(value, 1024, 'tests[0].input', cut);
    expectCutOf(JSON.stringify(value), 1024, valueCut);
    expect(cut).toEqual(['reason', 'tests[0].input']);
  });

  it('a value over its cap becomes a cut of its JSON text', () => {
    const value = { items: Array.from({ length: 500 }, (_, i) => ({ id: i, label: `item ${i} ✓` })) };
    const json = JSON.stringify(value);
    const cut: string[] = [];
    const result = expectCutOf(json, 512, traceValue(value, 512, 'tests[0].input', cut));
    expect(result.bytes).toBe(Buffer.byteLength(json));
    expect(json.startsWith(result.head)).toBe(true);
    expect(cut).toEqual(['tests[0].input']);

    // The JSON text cut is the copy's, markers included.
    const odd = { big: 10n, pad: 'p'.repeat(600) };
    const oddJson = JSON.stringify(jsonSafeCopy(odd));
    const oddCut = expectCutOf(oddJson, 256, traceValue(odd, 256, 'tests[1].result.output', cut));
    expect(oddCut.head.startsWith('{"big":{"$trace":"unserializable","kind":"bigint"},"pad":"ppp')).toBe(true);

    // A value within its cap is its copy: equal, not the same object. undefined stays undefined.
    const small = { a: [1, 'two', null] };
    const kept = traceValue(small, 512, 'request.inputSchema', cut);
    expect(kept).toEqual(small);
    expect(kept).not.toBe(small);
    expect(traceValue(undefined, 512, 'request.outputSchema', cut)).toBeUndefined();
    expect(cut).toEqual(['tests[0].input', 'tests[1].result.output']);
  });

  it('values that cannot be written as JSON become markers in place', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    const shared = { v: 1 };
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();

    const copy = jsonSafeCopy({
      big: 10n,
      cyclic,
      fn: () => 1,
      sym: Symbol('s'),
      throwing: {
        ok: 1,
        get bad(): number {
          throw new Error('getter');
        },
      },
      badToJSON: {
        toJSON(): never {
          throw new Error('toJSON');
        },
      },
      proxy: new Proxy({ a: 1 }, {
        get(): never {
          throw new Error('get');
        },
      }),
      revoked,
      keyed: { toJSON: (key: string) => `key:${key}` },
      absent: undefined,
      list: [undefined, NaN, Infinity, -Infinity, 1, () => 2],
      when: new Date(Date.UTC(2026, 10, 18)),
      boxed: [new Number(3), new String('s'), new Boolean(false)],
      sharedTwice: { a: shared, b: [shared] },
    });

    expect(copy).toEqual({
      big: { $trace: 'unserializable', kind: 'bigint' },
      cyclic: { name: 'root', self: { $trace: 'unserializable', kind: 'cycle' } },
      fn: { $trace: 'unserializable', kind: 'function' },
      sym: { $trace: 'unserializable', kind: 'symbol' },
      throwing: { ok: 1, bad: OTHER },
      badToJSON: OTHER,
      proxy: OTHER,
      revoked: OTHER,
      keyed: 'key:keyed',
      list: [null, null, null, null, 1, { $trace: 'unserializable', kind: 'function' }],
      when: '2026-11-18T00:00:00.000Z',
      boxed: [3, 's', false],
      sharedTwice: { a: { v: 1 }, b: [{ v: 1 }] },
    });
    expect('absent' in (copy as object)).toBe(false);

    // A value that is itself one of these is its marker; undefined is undefined.
    expect(jsonSafeCopy(10n)).toEqual({ $trace: 'unserializable', kind: 'bigint' });
    expect(jsonSafeCopy(() => 1)).toEqual({ $trace: 'unserializable', kind: 'function' });
    expect(jsonSafeCopy(undefined)).toBeUndefined();

    // A key named __proto__ stays a key of the copy and changes no prototype.
    const parsed: unknown = JSON.parse('{"__proto__":{"polluted":true},"x":1}');
    const protoCopy = jsonSafeCopy(parsed) as Record<string, unknown>;
    expect(Object.keys(protoCopy)).toEqual(['__proto__', 'x']);
    expect(Object.getPrototypeOf(protoCopy)).toBe(Object.prototype);
    expect(JSON.stringify(protoCopy)).toBe('{"__proto__":{"polluted":true},"x":1}');

    // A value nested 10,000 levels deep is copied without running out of stack: past 256 levels it is a marker.
    let deep: Record<string, unknown> = { leaf: true };
    for (let level = 0; level < 10_000; level += 1) {
      deep = { a: deep };
    }
    const deepCopy = jsonSafeCopy(deep);
    expect(() => JSON.stringify(deepCopy)).not.toThrow();
    let node: unknown = deepCopy;
    for (let level = 0; level < 256; level += 1) {
      node = (node as { a: unknown }).a;
    }
    expect(node).toEqual(OTHER);
  });

  it('each cut pushes its path, and a field within its cap pushes none', () => {
    const cut: string[] = [];
    traceText('short', 256, 'request.name', cut);
    traceValue({ type: 'object' }, 256, 'request.inputSchema', cut);
    traceString('forge_1', 256, 'forgeId', cut);
    traceValue(undefined, 256, 'request.outputSchema', cut);
    expect(cut).toEqual([]);

    traceText('x'.repeat(300), 256, 'request.name', cut);
    traceValue({ type: 'object', description: 'y'.repeat(300) }, 256, 'request.inputSchema', cut);
    traceString('z'.repeat(300), 256, 'agentId', cut);
    traceText({ message: 'w'.repeat(300) }, 256, 'reason', cut);
    expect(cut).toEqual(['request.name', 'request.inputSchema', 'agentId', 'reason']);
  });

  it('a plain string over its cap keeps a whole-character start and lists its path', () => {
    const cut: string[] = [];
    expect(traceString('session-1', 256, 'sessionId', cut)).toBe('session-1');
    expect(cut).toEqual([]);

    const text = 'id-' + '\u{1F600}'.repeat(200);
    const start = traceString(text, 256, 'sessionId', cut);
    expectWholeCharacterStart(text, start);
    expect(jsonBytes(start)).toBeLessThanOrEqual(256);
    expect(jsonBytes(start + characterAt(text, start.length))).toBeGreaterThan(256);
    expect(cut).toEqual(['sessionId']);

    // A 1 MiB string keeps the same start a short one over the cap keeps.
    expect(traceString('n'.repeat(1 << 20), 256, 'forgeId', cut)).toBe('n'.repeat(254));
    expect(cut).toEqual(['sessionId', 'forgeId']);
  });
});
