/**
 * @file jsonDuplicateKeys.test.ts
 * findDuplicateJsonKey on keys repeated at the top level and inside nested
 * objects and arrays, on keys that differ only in their escapes, and on
 * strings whose contents look like JSON structure.
 */
import { describe, expect, it } from 'vitest';

import { findDuplicateJsonKey } from '../jsonDuplicateKeys';

describe('findDuplicateJsonKey', () => {
  it('finds a key the top-level object repeats', () => {
    expect(findDuplicateJsonKey('{"items":[{"id":"a"},{"id":"b"}],"items":[{"id":"c"}]}')).toEqual({
      key: 'items',
      path: '<root>',
    });
  });

  it('names the array element and the field that hold the object repeating a key', () => {
    expect(findDuplicateJsonKey('{"items":[{"id":"a"},{"id":"b","frames":[1],"frames":[2]}]}')).toEqual({
      key: 'frames',
      path: 'items[1]',
    });
    expect(findDuplicateJsonKey('{"items":[{"meta":{"k":1,"k":2}}]}')).toEqual({ key: 'k', path: 'items[0].meta' });
    expect(findDuplicateJsonKey('[[1],[{"a":1,"a":2}]]')).toEqual({ key: 'a', path: '[1][0]' });
    expect(findDuplicateJsonKey('{"two words":{"x":1,"x":2}}')).toEqual({ key: 'x', path: '["two words"]' });
  });

  it('compares keys after their escapes are read, as JSON.parse does', () => {
    expect(findDuplicateJsonKey('{"a":1,"\\u0061":2}')).toEqual({ key: 'a', path: '<root>' });
    expect(findDuplicateJsonKey('{"a\\"b":1,"a\\u0022b":2}')).toEqual({ key: 'a"b', path: '<root>' });
  });

  it('finds nothing when every object keeps its keys distinct', () => {
    expect(findDuplicateJsonKey('{"a":1,"b":{"a":2},"c":[{"a":3},{"a":4}]}')).toBeUndefined();
    expect(findDuplicateJsonKey('{"a":{"a":{"a":1}}}')).toBeUndefined();
    expect(findDuplicateJsonKey('[]')).toBeUndefined();
    expect(findDuplicateJsonKey('"text"')).toBeUndefined();
    expect(findDuplicateJsonKey('{}')).toBeUndefined();
  });

  it('reads string values as values, whatever braces, quotes and commas they hold', () => {
    const json = '{"note":"{\\"a\\":1,\\"a\\":2}, [x]","a":"\\\\","b":"a,\\"note\\":"}';
    expect(JSON.parse(json)).toMatchObject({ a: '\\' });
    expect(findDuplicateJsonKey(json)).toBeUndefined();
    expect(findDuplicateJsonKey('{"v":"}\\"","v":1}')).toEqual({ key: 'v', path: '<root>' });
  });

  it('keeps an array\'s element count across values of every kind', () => {
    expect(findDuplicateJsonKey('{"l":[1,"s",true,null,{"z":0},[2,3],{"q":1,"q":2}]}')).toEqual({ key: 'q', path: 'l[6]' });
  });
});
