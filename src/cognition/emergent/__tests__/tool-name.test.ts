import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  InvalidToolNameError,
  forgedToolNameProblem,
  resolveToolFolder,
  type ToolNameProblem,
} from '../ToolName.js';

/** Names a model may give a forged tool, among them the longest the rule allows. */
const ACCEPTED = ['add_numbers', 'fetch-github-pr', 'Tutor', 'a', 'A1_b-2', 'x'.repeat(200)];

/** Names the forge refuses, each with the part of the rule it breaks. */
const REFUSED: Array<[unknown, ToolNameProblem]> = [
  [undefined, 'type'],
  [null, 'type'],
  [42, 'type'],
  [['add_numbers'], 'type'],
  ['', 'empty'],
  ['../escaped', 'character'],
  ['../../outside', 'character'],
  ['skills/../../escaped', 'character'],
  ['/etc/cron.d/job', 'character'],
  ['..\\escaped', 'character'],
  ['C:escaped', 'character'],
  ['tool:stream', 'character'],
  ['tool?', 'character'],
  ['to\u0000ol', 'character'],
  ['tool\n', 'character'],
  ['..', 'dot'],
  ['.', 'dot'],
  ['.hidden', 'dot'],
  [' tool', 'edge'],
  ['tool.', 'edge'],
  ['x'.repeat(201), 'length'],
  // Safe as a folder name, but not an identifier.
  ['my tool', 'identifier'],
  ['tool.v2', 'identifier'],
  ['9lives', 'identifier'],
  ['_private', 'identifier'],
  ['-flag', 'identifier'],
  ['caf\u00e9', 'identifier'],
  ['\u017Fum', 'identifier'],
];

/** What `fn` throws; fails the test when it throws nothing. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw');
}

describe('the forge holds a tool name to the path rule and the identifier pattern', () => {
  it.each(ACCEPTED)('accepts %j', (name) => {
    expect(forgedToolNameProblem(name)).toBeNull();
  });

  it.each(REFUSED)('refuses %j as %s', (name, problem) => {
    expect(forgedToolNameProblem(name)).toBe(problem);
  });

  it('accepts no name the exporter refuses: each resolves to its own folder inside the output folder', () => {
    for (const name of ACCEPTED) {
      expect(resolveToolFolder('/srv/skills', name, path.posix)).toBe(`/srv/skills/${name}`);
      expect(resolveToolFolder('C:\\skills', name, path.win32)).toBe(`C:\\skills\\${name}`);
    }
  });
});

describe('the exporter resolves a tool folder only inside the output folder', () => {
  it.each([
    ['../escaped', 'character'],
    ['..\\escaped', 'character'],
    ['..', 'dot'],
    ['', 'empty'],
    ['x'.repeat(201), 'length'],
    [7, 'type'],
  ] as Array<[unknown, ToolNameProblem]>)('refuses %j as %s, on POSIX and on Windows paths', (name, problem) => {
    for (const [root, paths] of [
      ['/srv/skills', path.posix],
      ['C:\\skills', path.win32],
    ] as const) {
      const err = thrownBy(() => resolveToolFolder(root, name, paths));
      expect(err).toBeInstanceOf(InvalidToolNameError);
      expect(err).toMatchObject({ name: 'InvalidToolNameError', code: 'INVALID_TOOL_NAME', problem });
    }
  });

  it('accepts a safe folder name that is no identifier, as a stored row or a tool a host builds may hold', () => {
    expect(resolveToolFolder('/srv/skills', 'my tool', path.posix)).toBe('/srv/skills/my tool');
  });

  it('refuses a name whose folder the platform would place outside the output folder', () => {
    // Path functions that place every folder above the output folder: the guard behind the name rule refuses it.
    const leaky: Pick<path.PlatformPath, 'resolve' | 'sep'> = {
      sep: '/',
      resolve: (...parts: string[]) => (parts.length > 1 ? '/srv/elsewhere' : path.posix.resolve(...parts)),
    };
    expect(thrownBy(() => resolveToolFolder('/srv/skills', 'add_numbers', leaky))).toMatchObject({
      code: 'INVALID_TOOL_NAME',
      problem: 'outside',
    });
  });

  it('names the refused name in its message, escaped and cut to its first 64 characters', () => {
    expect(thrownBy(() => resolveToolFolder('/srv/skills', `../${'a'.repeat(100)}`, path.posix))).toMatchObject({
      message: expect.stringContaining(`tool name "../${'a'.repeat(61)}..." refused`),
    });
    expect(thrownBy(() => resolveToolFolder('/srv/skills', null, path.posix))).toMatchObject({
      message: expect.stringContaining('tool name of type null refused'),
    });
  });
});
