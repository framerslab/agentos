import { describe, expect, it } from 'vitest';
import { canonicalJson, digestOf, sha256Hex } from '../digest.js';

describe('canonical JSON and its digest', () => {
  it('sorts keys at every depth, drops undefined members and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: 'x' }, e: undefined })).toBe('{"a":{"c":"x","d":[3,1]},"b":1}');
    expect(canonicalJson([undefined, null])).toBe('[null,null]');
  });
  it('writes an array hole as null, as JSON does, so a hole neither vanishes nor breaks the text', () => {
    const holes: unknown[] = [];
    holes.length = 2;
    const gap: unknown[] = ['a'];
    gap[2] = 'c';
    expect(canonicalJson(holes)).toBe('[null,null]');
    expect(canonicalJson({ list: gap })).toBe('{"list":["a",null,"c"]}');
    expect(canonicalJson(gap)).toBe(JSON.stringify(gap));
    const one: unknown[] = [];
    one.length = 1;
    expect(digestOf(one)).toBe(digestOf([null]));
    expect(digestOf(one)).not.toBe(digestOf([]));
  });
  it('reads an array length and each member once, as JSON does, so a getter cannot grow or change the text', () => {
    const grown = (): unknown[] => {
      const items: unknown[] = ['a', 'b'];
      Object.defineProperty(items, 0, {
        get() {
          items.push('x');
          return 'a';
        },
        enumerable: true,
        configurable: true,
      });
      return items;
    };
    expect(canonicalJson(grown())).toBe('["a","b"]');
    expect(canonicalJson(grown())).toBe(JSON.stringify(grown()));
    let reads = 0;
    const counted = {
      get a() {
        reads += 1;
        return reads;
      },
    };
    expect(canonicalJson(counted)).toBe('{"a":1}');
    expect(reads).toBe(1);
  });
  it('gives equal digests to equal values written in a different key order', () => {
    expect(digestOf({ x: 1, y: [true] })).toBe(digestOf({ y: [true], x: 1 }));
  });
  it('refuses what JSON cannot hold', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/not finite/);
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(/plain object/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/function/);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => canonicalJson(loop)).toThrow(/cycle/);
  });
  it('hashes text as UTF-8 and bytes as they are', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'));
  });
});
