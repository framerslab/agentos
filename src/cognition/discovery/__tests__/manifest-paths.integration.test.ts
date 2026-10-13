/**
 * @file manifest-paths.integration.test.ts
 * The capability manifest scanner against a temp folder: a capability is read only from its own folder, and one
 * whose manifest names a file elsewhere, or whose files are reached through a link or are not regular files, is
 * refused and recorded while the scan goes on with the others.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { CapabilityManifestRefusedError, CapabilityManifestScanner } from '../CapabilityManifestScanner.js';

// <root>/secret.txt and <root>/secret.json sit two levels above each capability's files: <root>/caps/<capability>/.
let root: string;
let caps: string;
let warn: MockInstance<typeof console.warn>;

const SECRET = 'A file outside every capability folder, which no capability may read.';
const SECRET_JSON = '{"type":"object","description":"A schema outside every capability folder."}';
const GOOD_SKILL = '# Good Tool\n\nUse this tool for good things.\n';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-paths-'));
  caps = path.join(root, 'caps');
  fs.mkdirSync(caps);
  fs.writeFileSync(path.join(root, 'secret.txt'), SECRET);
  fs.writeFileSync(path.join(root, 'secret.json'), SECRET_JSON);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A manifest for the capability `name`, with extra lines such as a `skillContent`. */
function manifest(name: string, ...lines: string[]): string {
  return [`kind: tool`, `name: ${name}`, `description: The ${name} capability.`, ...lines].join('\n');
}

/** Make the folder of the capability `name` with `files` in it, and return the folder. */
function capability(name: string, files: Record<string, string>): string {
  const dir = path.join(caps, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

describe('a capability is read only from its own folder', () => {
  it('a manifest whose skillContent names a file two levels up, or at an absolute path, is refused and recorded, and the scan reads the good capability', async () => {
    capability('good', { 'CAPABILITY.yaml': manifest('good', 'skillContent: ./SKILL.md'), 'SKILL.md': GOOD_SKILL });
    capability('escape', { 'CAPABILITY.yaml': manifest('escape', 'skillContent: ../../secret.txt') });
    capability('absolute', {
      'CAPABILITY.yaml': manifest('absolute', `skillContent: ${path.join(root, 'secret.txt')}`),
    });

    const result = await new CapabilityManifestScanner().scanWithRefusals([caps]);

    expect(result.descriptors).toHaveLength(1);
    expect(result.descriptors[0]).toMatchObject({ id: 'tool:good', name: 'good', fullContent: GOOD_SKILL });
    expect(result.refused).toHaveLength(2);
    expect(result.refused).toEqual(
      expect.arrayContaining([
        { manifestPath: path.join(caps, 'escape', 'CAPABILITY.yaml'), field: 'skillContent', problem: 'dot' },
        {
          manifestPath: path.join(caps, 'absolute', 'CAPABILITY.yaml'),
          field: 'skillContent',
          // On Windows the absolute path holds a drive and backslashes.
          problem: process.platform === 'win32' ? 'character' : 'segment',
        },
      ]),
    );
    // The outside file's text is nowhere in what the scan returns.
    expect(JSON.stringify(result)).not.toContain(SECRET);
    // Each refusal was written as a warning naming its manifest.
    const warnings = warn.mock.calls.map((call) => String(call[0]));
    expect(warnings.filter((line) => line.includes(path.join(caps, 'escape', 'CAPABILITY.yaml')))).toHaveLength(1);
    expect(warnings.filter((line) => line.includes(path.join(caps, 'absolute', 'CAPABILITY.yaml')))).toHaveLength(1);
    // scan() returns the same capabilities, and parseManifest throws the typed error.
    expect((await new CapabilityManifestScanner().scan([caps])).map((descriptor) => descriptor.id)).toEqual(['tool:good']);
    const thrown = await new CapabilityManifestScanner()
      .parseManifest(path.join(caps, 'escape', 'CAPABILITY.yaml'), path.join(caps, 'escape'))
      .catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(CapabilityManifestRefusedError);
    expect(thrown).toMatchObject({ code: 'CAPABILITY_MANIFEST_REFUSED', field: 'skillContent', problem: 'dot' });
  });

  it('a manifest that sets skillContent to an empty value, null, false or a number is refused and recorded, and one that leaves it out reads SKILL.md beside it', async () => {
    capability('good', { 'CAPABILITY.yaml': manifest('good'), 'SKILL.md': GOOD_SKILL });
    // Each of these holds a SKILL.md too, which a value read as unset would load.
    const set: Array<[string, string, string]> = [
      ['set-empty', 'skillContent: ""', 'empty'],
      ['set-null', 'skillContent: null', 'empty'],
      ['set-false', 'skillContent: false', 'type'],
      ['set-zero', 'skillContent: 0', 'type'],
    ];
    for (const [name, line] of set) {
      capability(name, { 'CAPABILITY.yaml': manifest(name, line), 'SKILL.md': `# ${name}\n` });
    }

    const result = await new CapabilityManifestScanner().scanWithRefusals([caps]);

    expect(result.descriptors.map((descriptor) => descriptor.id)).toEqual(['tool:good']);
    expect(result.descriptors[0].fullContent).toBe(GOOD_SKILL);
    expect(result.refused).toHaveLength(set.length);
    expect(result.refused).toEqual(
      expect.arrayContaining(
        set.map(([name, , problem]) => ({ manifestPath: path.join(caps, name, 'CAPABILITY.yaml'), field: 'skillContent', problem })),
      ),
    );
  });

  it.skipIf(process.platform === 'win32')(
    'a link at a capability file, or at a folder on the way to one, to a file outside, refuses the capability, and nothing is read through it',
    async () => {
      capability('good', { 'CAPABILITY.yaml': manifest('good'), 'SKILL.md': GOOD_SKILL });
      // SKILL.md beside the manifest is a link to the outside file.
      const linkedSkill = capability('linked-skill', { 'CAPABILITY.yaml': manifest('linked-skill') });
      fs.symlinkSync(path.join(root, 'secret.txt'), path.join(linkedSkill, 'SKILL.md'));
      // skillContent names docs/SKILL.md, and docs is a link to a folder outside.
      const outsideFolder = path.join(root, 'outside-docs');
      fs.mkdirSync(outsideFolder);
      fs.writeFileSync(path.join(outsideFolder, 'SKILL.md'), SECRET);
      const linkedFolder = capability('linked-folder', {
        'CAPABILITY.yaml': manifest('linked-folder', 'skillContent: docs/SKILL.md'),
      });
      fs.symlinkSync(outsideFolder, path.join(linkedFolder, 'docs'), 'dir');
      // schema.json is a link to a JSON file outside.
      const linkedSchema = capability('linked-schema', { 'CAPABILITY.yaml': manifest('linked-schema') });
      fs.symlinkSync(path.join(root, 'secret.json'), path.join(linkedSchema, 'schema.json'));
      // The manifest itself is a link to a manifest outside, whose description holds the outside text.
      fs.writeFileSync(path.join(root, 'outside.yaml'), manifest('linked-manifest').replace(/^description: .*$/m, `description: ${SECRET}`));
      const linkedManifest = path.join(caps, 'linked-manifest');
      fs.mkdirSync(linkedManifest);
      fs.symlinkSync(path.join(root, 'outside.yaml'), path.join(linkedManifest, 'CAPABILITY.yaml'));

      const result = await new CapabilityManifestScanner().scanWithRefusals([caps]);

      expect(result.descriptors.map((descriptor) => descriptor.id)).toEqual(['tool:good']);
      expect(result.descriptors[0].fullContent).toBe(GOOD_SKILL);
      expect(result.refused).toHaveLength(4);
      expect(result.refused).toEqual(
        expect.arrayContaining([
          { manifestPath: path.join(linkedSkill, 'CAPABILITY.yaml'), field: 'skillContent', problem: 'link' },
          { manifestPath: path.join(linkedFolder, 'CAPABILITY.yaml'), field: 'skillContent', problem: 'link' },
          { manifestPath: path.join(linkedSchema, 'CAPABILITY.yaml'), field: 'schema', problem: 'link' },
          { manifestPath: path.join(linkedManifest, 'CAPABILITY.yaml'), field: 'manifest', problem: 'link' },
        ]),
      );
      const returned = JSON.stringify(result);
      expect(returned).not.toContain(SECRET);
      expect(returned).not.toContain('A schema outside every capability folder.');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a named pipe at a capability file refuses the capability at once, with no wait for a writer',
    async () => {
      capability('good', { 'CAPABILITY.yaml': manifest('good'), 'SKILL.md': GOOD_SKILL });
      const pipedSkill = capability('piped-skill', { 'CAPABILITY.yaml': manifest('piped-skill') });
      const pipedManifest = path.join(caps, 'piped-manifest');
      fs.mkdirSync(pipedManifest);
      // Named pipes that no process writes: a read that waited would wait for ever.
      execFileSync('mkfifo', [path.join(pipedSkill, 'SKILL.md'), path.join(pipedManifest, 'CAPABILITY.yaml')]);

      const result = await new CapabilityManifestScanner().scanWithRefusals([caps]);

      expect(result.descriptors.map((descriptor) => descriptor.id)).toEqual(['tool:good']);
      expect(result.refused).toHaveLength(2);
      expect(result.refused).toEqual(
        expect.arrayContaining([
          { manifestPath: path.join(pipedSkill, 'CAPABILITY.yaml'), field: 'skillContent', problem: 'special' },
          { manifestPath: path.join(pipedManifest, 'CAPABILITY.yaml'), field: 'manifest', problem: 'special' },
        ]),
      );
      expect(fs.lstatSync(path.join(pipedSkill, 'SKILL.md')).isFIFO()).toBe(true);
    },
    15_000,
  );
});
