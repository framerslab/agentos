/**
 * @file skill-content-path.test.ts
 * The rule for a manifest's `skillContent`, through the scanner's resolver: a path below the capability's folder,
 * its names joined by `/` after an optional leading `./`, on POSIX and Windows paths.
 */
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CapabilityManifestRefusedError, resolveSkillContentPath } from '../CapabilityManifestScanner.js';
import type { CapabilityManifestProblem } from '../types.js';

/** The error `run` throws, or undefined when it returns. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** The problem the resolver names for `value` under a capability folder, or null when it resolves the value. */
function problemOf(value: unknown, paths: path.PlatformPath = path.posix): CapabilityManifestProblem | null {
  const root = paths === path.win32 ? 'C:\\caps\\tool' : '/srv/caps/tool';
  const err = thrownBy(() => resolveSkillContentPath(root, value, paths));
  if (err === undefined) return null;
  if (err instanceof CapabilityManifestRefusedError) return err.problem;
  throw err;
}

describe('resolveSkillContentPath', () => {
  const accepted: Array<[string, string, string, string]> = [
    ['the path the skill exporter writes', './SKILL.md', '/srv/caps/tool/SKILL.md', 'C:\\caps\\tool\\SKILL.md'],
    ['a file name alone', 'SKILL.md', '/srv/caps/tool/SKILL.md', 'C:\\caps\\tool\\SKILL.md'],
    ['a file in a folder', 'docs/skill.md', '/srv/caps/tool/docs/skill.md', 'C:\\caps\\tool\\docs\\skill.md'],
    ['a file in a folder after ./', './docs/skill.md', '/srv/caps/tool/docs/skill.md', 'C:\\caps\\tool\\docs\\skill.md'],
    ['dots and spaces inside names', 'notes/v1..v2 draft.md', '/srv/caps/tool/notes/v1..v2 draft.md', 'C:\\caps\\tool\\notes\\v1..v2 draft.md'],
  ];

  it.each(accepted)('accepts %s, on POSIX and on Windows paths', (_label, value, posixFile, windowsFile) => {
    expect(resolveSkillContentPath('/srv/caps/tool', value, path.posix)).toBe(posixFile);
    expect(resolveSkillContentPath('C:\\caps\\tool', value, path.win32)).toBe(windowsFile);
  });

  const refused: Array<[string, unknown, CapabilityManifestProblem]> = [
    ['a parent folder', '../x', 'dot'],
    ['a parent folder after ./', './../x', 'dot'],
    ['a file two levels up', '../../secret.txt', 'dot'],
    ['a parent folder after a name', 'docs/../../x', 'dot'],
    ['the folder itself', '.', 'dot'],
    ['./ twice', '././SKILL.md', 'dot'],
    ['a hidden file', '.env', 'dot'],
    ['a hidden folder', 'docs/.git/config', 'dot'],
    ['an absolute path', '/etc/passwd', 'segment'],
    ['a doubled slash', 'docs//skill.md', 'segment'],
    ['a trailing slash', 'docs/', 'segment'],
    ['a Windows drive path', 'C:\\Windows\\win.ini', 'character'],
    ['a Windows drive path written with slashes', 'C:/Windows/win.ini', 'character'],
    ['a path on another drive', 'D:skill.md', 'character'],
    ['a Windows share', '\\\\server\\share\\skill.md', 'character'],
    ['a parent folder written with a backslash', '..\\x', 'character'],
    ['a file stream', 'SKILL.md:hidden', 'character'],
    ['a NUL byte', 'SKILL.md\u0000.txt', 'character'],
    ['a line break', 'SKILL\n.md', 'character'],
    ['a name ending with a space', 'docs /skill.md', 'edge'],
    ['a name ending with a dot', 'docs./skill.md', 'edge'],
    ['a name past the byte limit', `docs/${'x'.repeat(201)}`, 'length'],
    ['./ alone', './', 'empty'],
    ['an empty value', '', 'empty'],
    ['a number', 42, 'type'],
    ['true', true, 'type'],
    ['null', null, 'type'],
    ['a list', ['SKILL.md'], 'type'],
    ['an object', { path: 'SKILL.md' }, 'type'],
  ];

  it.each(refused)('refuses %s, on POSIX and on Windows paths', (_label, value, problem) => {
    expect(problemOf(value, path.posix)).toBe(problem);
    expect(problemOf(value, path.win32)).toBe(problem);
  });

  it('refuses a value whose file the platform would place outside the folder', () => {
    // Path functions that place every file above the capability's folder: the guard behind the rule refuses it.
    const leaky: Pick<path.PlatformPath, 'resolve' | 'sep'> = {
      sep: '/',
      resolve: (...parts: string[]) => (parts.length > 1 ? '/srv/elsewhere/SKILL.md' : path.posix.resolve(...parts)),
    };
    expect(thrownBy(() => resolveSkillContentPath('/srv/caps/tool', './SKILL.md', leaky))).toMatchObject({
      code: 'CAPABILITY_MANIFEST_REFUSED',
      field: 'skillContent',
      problem: 'outside',
    });
  });

  it('throws a typed error whose message shows only the start of the value, escaped', () => {
    const err = thrownBy(() => resolveSkillContentPath('/srv/caps/tool', `../${'z'.repeat(10_000)}\u0000`, path.posix));

    expect(err).toBeInstanceOf(CapabilityManifestRefusedError);
    expect(err).toBeInstanceOf(Error);
    const refusal = err as CapabilityManifestRefusedError;
    expect(refusal).toMatchObject({
      name: 'CapabilityManifestRefusedError',
      code: 'CAPABILITY_MANIFEST_REFUSED',
      field: 'skillContent',
      problem: 'character',
    });
    expect(refusal.message).toContain(`capability skillContent "../${'z'.repeat(61)}..." refused`);
    expect(refusal.message).not.toContain('\u0000');
    expect(refusal.message.length).toBeLessThan(300);
    expect(thrownBy(() => resolveSkillContentPath('/srv/caps/tool', null, path.posix))).toMatchObject({
      message: expect.stringContaining('capability skillContent of type null refused'),
    });
  });
});
