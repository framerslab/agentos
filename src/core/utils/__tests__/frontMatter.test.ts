/**
 * @file frontMatter.test.ts
 * Front matter read and written as data: a block marked as JavaScript, which
 * gray-matter's own engines evaluate, is never run, whether a file opens with
 * it or a body that front matter is written onto does. Each such case also
 * hands the same text to gray-matter with its own engines, which shows the
 * block is one it runs.
 */
import matter from 'gray-matter';

import { afterEach, describe, expect, it } from 'vitest';

import { readFrontMatter, writeFrontMatter } from '../frontMatter.js';

/** A global the JavaScript blocks below set when they are evaluated. */
const MARK = '__agentosFrontMatterEvaluated';

/** The text after the block in the files below. */
const BODY = '# Notes\n\nThe review moved to Thursday.\n';

/** Whether a block below has been evaluated since the last test. */
function evaluated(): boolean {
  return Reflect.get(globalThis, MARK) === true;
}

/**
 * A file whose front matter is marked with `language`. Evaluated, the block
 * sets the mark and gives the title `evaluated`.
 */
function fileMarked(language: string): string {
  return `---${language}\n{ title: (globalThis.${MARK} = true) && 'evaluated' }\n---\n${BODY}`;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, MARK);
});

describe('readFrontMatter', () => {
  it('reads a YAML block and a JSON block into data, and takes each off the body', () => {
    const yaml = readFrontMatter(`---\ntitle: Notes\ndraft: false\n---\n${BODY}`);
    expect(yaml.data).toEqual({ title: 'Notes', draft: false });
    expect(yaml.content).toBe(BODY);

    const json = readFrontMatter(`---json\n{ "title": "Notes", "draft": false }\n---\n${BODY}`);
    expect(json.data).toEqual({ title: 'Notes', draft: false });
    expect(json.content).toBe(BODY);
  });

  it.each(['js', 'javascript', 'JS', ' js'])('evaluates no block marked as "%s"', (language) => {
    const text = fileMarked(language);

    const file = readFrontMatter(text);
    expect(evaluated()).toBe(false);
    expect(file.data).toEqual({});
    expect(file.content).toBe(BODY);

    // gray-matter with its own engines runs the same block.
    expect(matter(text, {}).data).toEqual({ title: 'evaluated' });
    expect(evaluated()).toBe(true);
  });
});

describe('writeFrontMatter', () => {
  it('writes the block in YAML, then the body as it is', () => {
    expect(writeFrontMatter('# Notes', { title: 'Notes', strength: 0.5 })).toBe(
      '---\ntitle: Notes\nstrength: 0.5\n---\n# Notes\n',
    );
  });

  it('keeps a body that opens with a line of dashes', () => {
    const body = '---\nA rule opens this note.\n';

    const written = writeFrontMatter(body, { id: 'trace-1' });
    expect(written).toBe(`---\nid: trace-1\n---\n${body}`);

    const back = readFrontMatter(written);
    expect(back.data).toEqual({ id: 'trace-1' });
    expect(back.content).toBe(body);
  });

  it('evaluates no body that opens with a block marked as JavaScript, and keeps it whole', () => {
    const body = fileMarked('js');

    const written = writeFrontMatter(body, { id: 'trace-2' });
    expect(evaluated()).toBe(false);
    expect(written).toBe(`---\nid: trace-2\n---\n${body}`);

    const back = readFrontMatter(written);
    expect(evaluated()).toBe(false);
    expect(back.data).toEqual({ id: 'trace-2' });
    expect(back.content).toBe(body);

    // matter.stringify given the same body as a string reads it with its own engines and runs the block.
    expect(() => matter.stringify(body, { id: 'trace-2' }, {})).toThrow('stringifying JavaScript is not supported');
    expect(evaluated()).toBe(true);
  });
});
