/**
 * @fileoverview Finds a key that one JSON object repeats.
 *
 * `JSON.parse` keeps only the last value of a duplicated key, so
 * `{"items":[{"id":"a"},{"id":"b"}],"items":[{"id":"c"}]}` parses to an object
 * with one item and no error. A model's structured reply that repeats a key
 * therefore loses data without a sign. {@link findDuplicateJsonKey} walks the
 * text with a small tokenizer (strings with their escapes, objects and arrays)
 * and reports the first key an object holds twice, so a structured-output
 * parser can treat the reply as malformed and ask again.
 *
 * @module agentos/core/utils/jsonDuplicateKeys
 */

/** A key one object of the text holds more than once. */
export interface DuplicateJsonKey {
  /** The key as the object holds it, its escapes read (`"a"` is `a`). */
  key: string;
  /** Where the object that repeats it sits: `<root>`, `items[1]`, `items[0].meta`. */
  path: string;
}

type Frame =
  | { kind: 'object'; keys: Set<string>; expectKey: boolean; key?: string }
  | { kind: 'array'; index: number };

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COMMA = 0x2c;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Returns the first key an object in `text` holds twice, or `undefined` when
 * every object's keys are distinct. Keys compare after their escapes are read,
 * as `JSON.parse` compares them.
 *
 * The walk does not validate the JSON: run it on text that `JSON.parse`
 * accepts. On text that does not parse, it reports what it found before the
 * text went wrong, and an unterminated key ends the walk with `undefined`.
 *
 * @param text JSON text.
 * @example
 * findDuplicateJsonKey('{"items":[1],"items":[2]}'); // { key: 'items', path: '<root>' }
 * findDuplicateJsonKey('{"a":{"b":1,"b":2}}');       // { key: 'b', path: 'a' }
 * findDuplicateJsonKey('{"a":1,"b":1}');             // undefined
 */
export function findDuplicateJsonKey(text: string): DuplicateJsonKey | undefined {
  const frames: Frame[] = [];
  const length = text.length;
  let i = 0;
  while (i < length) {
    const code = text.charCodeAt(i);
    if (code === QUOTE) {
      const start = i;
      i++;
      while (i < length) {
        const c = text.charCodeAt(i);
        if (c === BACKSLASH) {
          i += 2;
          continue;
        }
        if (c === QUOTE) break;
        i++;
      }
      const end = i;
      i++;
      const top = frames[frames.length - 1];
      if (top?.kind === 'object' && top.expectKey) {
        if (end >= length) return undefined;
        const key = readKey(text.slice(start, end + 1));
        if (top.keys.has(key)) return { key, path: pathOf(frames) };
        top.keys.add(key);
        top.key = key;
        top.expectKey = false;
      }
      continue;
    }
    if (code === OPEN_BRACE) {
      frames.push({ kind: 'object', keys: new Set(), expectKey: true });
    } else if (code === OPEN_BRACKET) {
      frames.push({ kind: 'array', index: 0 });
    } else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
      frames.pop();
    } else if (code === COMMA) {
      const top = frames[frames.length - 1];
      if (top?.kind === 'object') top.expectKey = true;
      else if (top?.kind === 'array') top.index++;
    }
    i++;
  }
  return undefined;
}

/** A key token's value, its escapes read; the text between the quotes when the token is not a valid JSON string. */
function readKey(token: string): string {
  try {
    return JSON.parse(token) as string;
  } catch {
    return token.slice(1, -1);
  }
}

/** The path of the innermost frame, the object that repeats a key. */
function pathOf(frames: readonly Frame[]): string {
  let out = '';
  for (let f = 0; f < frames.length - 1; f++) {
    const frame = frames[f]!;
    if (frame.kind === 'array') {
      out += `[${frame.index}]`;
    } else {
      const key = frame.key ?? '';
      if (IDENTIFIER.test(key)) out += out === '' ? key : `.${key}`;
      else out += `[${JSON.stringify(key)}]`;
    }
  }
  return out || '<root>';
}
