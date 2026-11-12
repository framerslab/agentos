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
import { GeminiProviderError } from '../../src/core/llm/providers/errors/GeminiProviderError.js';

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

/** An error built and given fields in one call: `Object.assign(new Error(...), { name: ..., code: ... })`. Group 1 is the fields. */
const ASSIGNED = /Object\.assign\(\s*new [A-Z]\w*\([\s\S]{0,600}?\),\s*\{([^}]*)\}/g;

/**
 * The top-level arguments of a call or the parameters of a constructor, read from `text` just after its `(`: each
 * trimmed, with strings, comments and nested brackets skipped. `angle` also nests `<...>`, for a parameter's type.
 */
function topLevelArguments(text: string, start: number, angle: boolean): string[] | undefined {
  const opens = angle ? '([{<' : '([{';
  const closes = angle ? ')]}>' : ')]}';
  const args: string[] = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '=' && text[i + 1] === '>') {
      i++;
    } else if (opens.includes(ch)) {
      depth++;
    } else if (closes.includes(ch)) {
      if (depth === 0) { args.push(text.slice(from, i)); return args.map((a) => a.trim()); }
      depth--;
    } else if (ch === ',' && depth === 0) {
      args.push(text.slice(from, i));
      from = i + 1;
    }
  }
  return undefined;
}

/** A class the source declares: its name, the class it extends, and its text up to the next class of its file. */
interface DeclaredClass { name: string; base: string; body: string; file: string }

/** The library's error classes: each class that extends a built-in error class, or extends one of these. */
function libraryErrorClasses(files: readonly string[]): DeclaredClass[] {
  const declared: DeclaredClass[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const found = [...text.matchAll(/\bclass ([A-Z]\w*) extends ([A-Z][\w.]*)/g)];
    found.forEach((match, i) => {
      declared.push({ name: match[1], base: match[2].split('.').pop() ?? match[2], body: text.slice(match.index ?? 0, found[i + 1]?.index ?? text.length), file });
    });
  }
  const errors = new Set(['Error', 'TypeError', 'RangeError']);
  for (let grew = true; grew;) {
    grew = false;
    for (const c of declared) if (!errors.has(c.name) && errors.has(c.base)) { errors.add(c.name); grew = true; }
  }
  return declared.filter((c) => errors.has(c.name));
}

describe('listedErrorFields', () => {
  it('keeps a listed type and a listed code', () => {
    expect(listedErrorFields(named('OpenRouterProviderError', 'STREAM_PARSING_ERROR'))).toEqual({ type: 'OpenRouterProviderError', code: 'STREAM_PARSING_ERROR' });
    expect(listedErrorFields(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toEqual({ type: 'Error', code: 'ECONNRESET' });
    expect(listedErrorFields(new GeminiProviderError('Gemini blocked the prompt', 'content_filter'))).toEqual({ type: 'GeminiProviderError', code: 'content_filter' });
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
  it('hold every name the library gives an error: a class that sets its name, and a name set on an error it throws', () => {
    const missing = new Set<string>();
    const need = (name: string, file: string) => { if (valid('word', name, 'type') && !LISTED_ERROR_TYPES.has(name)) missing.add(`${name} (${file})`); };
    for (const { body, file } of libraryErrorClasses(files)) {
      for (const match of body.matchAll(/\bthis\.name = '([A-Za-z]\w*)'/g)) need(match[1], file);
    }
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(ASSIGNED)) for (const field of match[1].matchAll(/\bname: '([A-Za-z]\w*)'/g)) need(field[1], file);
      for (const match of text.matchAll(/\b(?:error|err)\.name = '([A-Za-z]\w*)'/g)) need(match[1], file);
    }
    expect([...missing]).toEqual([]);
  });
  it('hold every code a library error is given: by assignment, by a declared union of codes, or as the argument in the place its constructor takes the code', () => {
    const missing = new Set<string>();
    const need = (code: string, file: string) => { if (valid('word', code, 'code') && !LISTED_ERROR_CODES.has(code)) missing.add(`${code} (${file})`); };
    const classes = libraryErrorClasses(files);
    const unions = new Map<string, string[]>();
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/\btype ([A-Z]\w*)\s*=((?:\s*\|?\s*'[A-Za-z]\w*')+)\s*;/g)) {
        unions.set(match[1], [...match[2].matchAll(/'([A-Za-z]\w*)'/g)].map((literal) => literal[1]));
      }
    }
    // The place of `code` among each class's constructor parameters, and a subclass that keeps that constructor.
    const codeAt = new Map<string, number>();
    for (const c of classes) {
      const ctor = /\bconstructor\(/.exec(c.body);
      const params = ctor ? topLevelArguments(c.body, ctor.index + ctor[0].length, true) : undefined;
      const at = (params ?? []).findIndex((p) => /^code\b/.test(p.replace(/^(?:(?:public|private|protected)\s+)?(?:readonly\s+)?/, '')));
      if (at >= 0) codeAt.set(c.name, at);
    }
    for (let grew = true; grew;) {
      grew = false;
      for (const c of classes) if (!codeAt.has(c.name) && codeAt.has(c.base) && !/\bconstructor\(/.test(c.body)) { codeAt.set(c.name, codeAt.get(c.base) as number); grew = true; }
    }
    /** The literal at the code's place among the arguments of the call whose `(` ends at `start`. */
    const codeArgument = (text: string, start: number, at: number): string | undefined => /^'([A-Za-z]\w*)'$/.exec(topLevelArguments(text, start, false)?.[at] ?? '')?.[1];
    for (const { base, body, file } of classes) {
      for (const match of body.matchAll(/\b(?:readonly|public|private|protected)\s+(?:readonly\s+)?code\??: ((?:'[A-Za-z]\w*'\s*\|?\s*)+|[A-Z]\w*)/g)) {
        const literals = match[1].startsWith("'") ? [...match[1].matchAll(/'([A-Za-z]\w*)'/g)].map((literal) => literal[1]) : unions.get(match[1]) ?? [];
        for (const code of literals) need(code, file);
      }
      const at = codeAt.get(base);
      if (at !== undefined) for (const match of body.matchAll(/\bsuper\(/g)) { const code = codeArgument(body, (match.index ?? 0) + match[0].length, at); if (code) need(code, file); }
    }
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(ASSIGNED)) for (const field of match[1].matchAll(/\bcode: '([A-Za-z]\w*)'/g)) need(field[1], file);
      for (const match of text.matchAll(/\.code = '([A-Za-z]\w*)'/g)) need(match[1], file);
      for (const [name, at] of codeAt) {
        for (const match of text.matchAll(new RegExp(`\\bnew ${name}\\(`, 'g'))) { const code = codeArgument(text, (match.index ?? 0) + match[0].length, at); if (code) need(code, file); }
      }
    }
    expect([...missing]).toEqual([]);
  });
  it("hold the ledger's refusal codes", () => {
    const codes = ['LEDGER_IDENTITY_MISMATCH', 'LEDGER_STATE_INVALID', 'LEDGER_UNAVAILABLE'];
    expect(codes.filter((code) => !LISTED_ERROR_CODES.has(code))).toEqual([]);
  });
  it('hold only values a line may carry', () => {
    expect([...LISTED_ERROR_TYPES].filter((type) => !valid('word', type, 'type'))).toEqual([]);
    expect([...LISTED_ERROR_CODES].filter((code) => !valid('word', code, 'code'))).toEqual([]);
  });
  it('cannot be changed by a caller that reaches them', () => {
    const sizes = [LISTED_ERROR_TYPES.size, LISTED_ERROR_CODES.size];
    for (const list of [LISTED_ERROR_TYPES, LISTED_ERROR_CODES] as unknown as Array<Set<string>>) {
      for (const change of [() => list.add('PERSONAL_DATA'), () => list.delete('ECONNRESET'), () => list.delete('Error'), () => list.clear()]) {
        try { change(); } catch { /* a refusal is as good as no method */ }
      }
      expect(Object.isFrozen(list)).toBe(true);
    }
    expect([LISTED_ERROR_TYPES.size, LISTED_ERROR_CODES.size]).toEqual(sizes);
    expect(LISTED_ERROR_CODES.has('PERSONAL_DATA')).toBe(false);
    expect(LISTED_ERROR_CODES.has('ECONNRESET')).toBe(true);
    expect(LISTED_ERROR_TYPES.has('Error')).toBe(true);
    expect(listedErrorFields(named('Error', 'PERSONAL_DATA'))).toEqual({ type: 'Error', code: 'unknown' });
  });
});
