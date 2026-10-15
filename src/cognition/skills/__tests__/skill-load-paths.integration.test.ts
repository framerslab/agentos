/**
 * @file skill-load-paths.integration.test.ts
 * The skill registry against a temp working folder: a skill's SKILL.md is read only when it is a regular file in
 * the skill's own folder, reached through no link, and a binary a skill requires is looked for on PATH only under a
 * single file name.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { loadSkillFromDir } from '../SkillLoader.js';
import { SkillRegistry } from '../SkillRegistry.js';
import { resolveDefaultSkillsDirs } from '../paths.js';

// The working folder is <base>/work, whose skills are in <base>/work/skills; <base>/secret.md sits outside it.
let base: string;
let cwd: string;
let skills: string;
let warn: MockInstance<typeof console.warn>;

const SECRET = 'Text outside every skill folder, which no skill may read.';
const GOOD_SKILL = '---\nname: good\ndescription: A good skill.\n---\n\nUse this skill for good things.\n';

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-load-paths-'));
  cwd = path.join(base, 'work');
  skills = path.join(cwd, 'skills');
  fs.mkdirSync(path.join(skills, 'good'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'good', 'SKILL.md'), GOOD_SKILL);
  // No front matter: a read of it would make the whole text the skill's body, which the prompt holds.
  fs.writeFileSync(path.join(base, 'secret.md'), SECRET);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  fs.rmSync(base, { recursive: true, force: true });
});

/** The skills folders read by default for the working folder: <cwd>/skills, with no home or environment folder. */
function defaultDirs(): string[] {
  return resolveDefaultSkillsDirs({ cwd, env: {}, includeHomeCodexSkillsDir: false });
}

/** The warnings that name `file`. */
function warningsAbout(file: string): string[] {
  return warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes(file));
}

/** A skill folder named `name` whose SKILL.md requires the binaries in `requires`, as front matter gives them. */
function skillRequiring(name: string, requires: string): void {
  fs.mkdirSync(path.join(skills, name));
  const frontMatter = ['---', `name: ${name}`, `description: The ${name} skill.`, 'metadata:', '  agentos:', '    requires:', `      ${requires}`, '---'];
  fs.writeFileSync(path.join(skills, name, 'SKILL.md'), `${frontMatter.join('\n')}\n\nRun the ${name} tool.\n`);
}

describe('a skill is read only from its own folder', () => {
  it.skipIf(process.platform === 'win32')(
    'a SKILL.md that is a link to a file outside is skipped with a warning, and the outside text is nowhere in the snapshot',
    async () => {
      fs.mkdirSync(path.join(skills, 'notes'));
      fs.symlinkSync(path.join(base, 'secret.md'), path.join(skills, 'notes', 'SKILL.md'));
      // A skill folder that is itself a link to a folder outside, which a caller names to the loader directly.
      const outsideSkill = path.join(base, 'outside-skill');
      fs.mkdirSync(outsideSkill);
      fs.writeFileSync(path.join(outsideSkill, 'SKILL.md'), SECRET);
      fs.symlinkSync(outsideSkill, path.join(skills, 'linked'), 'dir');

      expect(defaultDirs()).toEqual([skills]);
      const registry = new SkillRegistry();
      const loaded = await registry.loadFromDirs(defaultDirs());
      const snapshot = registry.buildSnapshot({ strict: true });
      const direct = await loadSkillFromDir(path.join(skills, 'linked'));

      expect(loaded).toBe(1);
      expect(registry.listAll().map((entry) => entry.skill.name)).toEqual(['good']);
      expect(snapshot.prompt).toContain('Use this skill for good things.');
      expect(snapshot.prompt).not.toContain(SECRET);
      expect(JSON.stringify(registry.listAll())).not.toContain(SECRET);
      expect(direct).toBeNull();
      expect(warningsAbout(path.join(skills, 'notes', 'SKILL.md'))).toEqual([
        `[SkillLoader] Skipped ${path.join(skills, 'notes', 'SKILL.md')}: it is reached through a symbolic link`,
      ]);
      expect(warningsAbout(path.join(skills, 'linked', 'SKILL.md'))).toHaveLength(1);
      // The listing passes over the linked folder with a warning of its own.
      expect(warningsAbout(path.join(skills, 'linked'))).toContain(`[SkillLoader] Skipped ${path.join(skills, 'linked')}: it is a symbolic link`);
    },
  );

  it('a binary a skill requires is looked for on PATH under one file name: a name with a slash, a leading dot or no string counts as missing', async () => {
    // <base>/bin is the only folder on PATH. <base>/tools/tool is a program too, but not in a folder on PATH.
    const bin = path.join(base, 'bin');
    const tools = path.join(base, 'tools');
    fs.mkdirSync(bin);
    fs.mkdirSync(tools);
    for (const file of [path.join(bin, 'present'), path.join(bin, '.hidden'), path.join(tools, 'tool')]) {
      fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(file, 0o755);
    }
    skillRequiring('uses-present', 'bins: ["present"]');
    // <base>/bin/../tools/tool is a program that a probe would find, so only the name check leaves these out.
    skillRequiring('climbs-out', 'bins: ["../tools/tool"]');
    skillRequiring('any-climbs-out', 'anyBins: ["../tools/tool"]');
    skillRequiring('hidden', 'bins: [".hidden"]');
    skillRequiring('numbered', 'bins: [42]');

    const registry = new SkillRegistry();
    await registry.loadFromDirs([skills]);
    const savedPath = process.env.PATH;
    process.env.PATH = bin;
    let listed: string[] = [];
    try {
      listed = registry.buildSnapshot({ strict: true }).skills.map((skill) => skill.name).sort();
      // A second snapshot warns about no name again.
      registry.buildSnapshot({ strict: true });
    } finally {
      process.env.PATH = savedPath;
    }

    expect(listed).toEqual(['good', 'uses-present']);
    const warnings = warn.mock.calls.map((call) => String(call[0]));
    for (const [skill, name] of [
      ['climbs-out', '"../tools/tool"'],
      ['any-climbs-out', '"../tools/tool"'],
      ['hidden', '".hidden"'],
      ['numbered', 'of type number'],
    ]) {
      expect(warnings.filter((line) => line.includes(`Skill '${skill}': the binary name ${name} is not one file name`))).toHaveLength(1);
    }
  });
});
