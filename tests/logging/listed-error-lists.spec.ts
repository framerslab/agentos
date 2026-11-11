/**
 * @file listed-error-lists.spec.ts
 * `listedErrorFields()` keeps an error's type and code only when the library lists them, and the two lists hold
 * every error class and every literal error code the library's own source declares, each in a form a line may carry.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LISTED_ERROR_CODES, LISTED_ERROR_TYPES, errorFields, listedErrorFields, valid } from '../../src/core/logging/events.js';
import { GMIErrorCode } from '../../src/core/utils/errors.js';

const named = (name: string, code?: unknown): Error => Object.assign(new Error('never written'), { name, ...(code === undefined ? {} : { code }) });

/** Every non-test TypeScript file under `dir`. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) { if (entry !== '__tests__' && entry !== 'node_modules') out.push(...sources(path)); continue; }
    if (path.endsWith('.ts') && !/\.(test|spec|d)\.ts$/.test(path)) out.push(path);
  }
  return out;
}

describe('listedErrorFields', () => {
  it('keeps a listed type and a listed code', () => {
    expect(listedErrorFields(named('OpenRouterProviderError', 'STREAM_PARSING_ERROR'))).toEqual({ type: 'OpenRouterProviderError', code: 'STREAM_PARSING_ERROR' });
    expect(listedErrorFields(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toEqual({ type: 'Error', code: 'ECONNRESET' });
  });
  it('writes a name and a code that only have the right shape as unknown', () => {
    const planted = Object.assign(new Error('PERSONAL_DATA'), { name: 'MeetMeAtBakerStreetError', code: 'PERSONAL_DATA' });
    expect(listedErrorFields(planted)).toEqual({ type: 'unknown', code: 'unknown' });
    expect(errorFields(planted)).toEqual({ type: 'unknown', code: 'unknown' });
    expect(listedErrorFields(named('Error', '23505'))).toEqual({ type: 'Error', code: 'unknown' });
    expect(listedErrorFields(named('Error', 'rev_1'))).toEqual({ type: 'Error', code: 'unknown' });
  });
  it('writes a value that is not an Error by its typeof, and an error with no code as unknown', () => {
    expect(listedErrorFields(undefined)).toEqual({ type: 'undefined', code: 'unknown' });
    expect(listedErrorFields('a string')).toEqual({ type: 'string', code: 'unknown' });
    expect(listedErrorFields({ code: 'ECONNRESET' })).toEqual({ type: 'object', code: 'ECONNRESET' });
    expect(listedErrorFields(new TypeError('x'))).toEqual({ type: 'TypeError', code: 'unknown' });
  });
  it('never throws on a value whose properties throw when read', () => {
    const hostile = Object.defineProperties(new Error('x'), { name: { get() { throw new Error('no'); } }, code: { get() { throw new Error('no'); } } });
    expect(listedErrorFields(hostile)).toEqual({ type: 'unknown', code: 'unknown' });
    const proxy = new Proxy({}, { get() { throw new Error('no'); }, getPrototypeOf() { throw new Error('no'); } });
    expect(listedErrorFields(proxy)).toEqual({ type: 'unknown', code: 'unknown' });
  });
});

describe('the two lists', () => {
  const files = sources('src');
  it('hold every error class the library declares', () => {
    const missing = new Set<string>();
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/\bclass ([A-Z][A-Za-z0-9]*(?:Error|Exception))\b/g)) {
        if (!LISTED_ERROR_TYPES.has(match[1])) missing.add(`${match[1]} (${file})`);
      }
    }
    expect([...missing]).toEqual([]);
  });
  it('hold every code of the error-code enum and every literal code an error class gives itself', () => {
    const missing = new Set<string>();
    for (const value of Object.values(GMIErrorCode)) if (!LISTED_ERROR_CODES.has(String(value))) missing.add(`GMIErrorCode ${value}`);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (!/\bclass [A-Z][A-Za-z0-9]*(?:Error|Exception)\b/.test(text)) continue;
      for (const match of text.matchAll(/(?:\bcode(?:: [A-Za-z' |]+)? = |this\.code = )'([A-Z][A-Z0-9_]*)'/g)) {
        if (!LISTED_ERROR_CODES.has(match[1])) missing.add(`${match[1]} (${file})`);
      }
    }
    expect([...missing]).toEqual([]);
  });
  it('hold only values a line may carry, and are frozen', () => {
    expect([...LISTED_ERROR_TYPES].filter((type) => !valid('word', type, 'type'))).toEqual([]);
    expect([...LISTED_ERROR_CODES].filter((code) => !valid('word', code, 'code'))).toEqual([]);
    expect(Object.isFrozen(LISTED_ERROR_TYPES)).toBe(true);
    expect(Object.isFrozen(LISTED_ERROR_CODES)).toBe(true);
  });
});
