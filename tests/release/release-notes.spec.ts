/**
 * The release notes semantic-release publishes, generated as the Release
 * workflow generates them: the release-notes generator with the
 * conventionalcommits preset and the options in release.config.js.
 *
 * The commits are taken from CI run 39482074431, whose dry run listed merge
 * commits under the breaking-change notes and printed raw type headings
 * ("### docs", "### ci") while release.config.js gave writerOpts a transform
 * of its own, which replaced the preset's.
 */
import { fileURLToPath } from 'node:url';

import { generateNotes } from '@semantic-release/release-notes-generator';
import { beforeAll, describe, expect, it } from 'vitest';

import config from '../../release.config.js';

const NOTES_PLUGIN = '@semantic-release/release-notes-generator';

/** The preset's template puts a warning sign before each note group's title. */
const BREAKING_HEADING = '### \u26a0 BREAKING CHANGES';

/** Hash and message of each commit, newest first, as git log lists them. */
const COMMITS: Array<[hash: string, message: string]> = [
  ['34a41019064210a56868ab10f85ebb1d3ecfe1c9', 'Merge de1f6c8e440f058b849f1af44e67ba8a4647f18c into 978df0f143979105f86eb0d43e4183df3eefc411'],
  ['de1f6c8e440f058b849f1af44e67ba8a4647f18c', "Merge branch 'master' into feat/notetaker-personality"],
  ['978df0f143979105f86eb0d43e4183df3eefc411', 'docs(memory): cite the matched-reader run in the vendor table (#579)'],
  ['32d89c091b16d1184411da4887a2a763852a0c76', "Merge remote-tracking branch 'origin/master' into feat/notetaker-personality"],
  ['04d76849c0acb4e3f5d3fc74a7ca0a167b7c43b4', 'fix(personas): strict declaration checks, one trigger per workflow, four type-only names'],
  ['df468f8d5982a7d8527096be0bddcf20dbb1eaa4', 'feat(personas): expose and document the notetaker substrate API'],
  [
    'c1279014a5b5e4c89118f9cd8e1f50c2312cc6f6',
    'fix(personas)!: enforce operator-only traits on every host\n\n'
      + 'BREAKING CHANGE: adapt_personality now refuses honesty and emotionality with operator_only even when the host has no learning layer.',
  ],
  ['4e7e73a3ee3506c87967a87421513a92d0268f3d', "ci: refresh the bump's lockfile on an empty pnpm store, and fail a refresh that drops an integrity (#571)"],
  ['0629448c7d47a7346e3ea32937eae58f1077f1b5', 'test(personas): refuse honesty and emotionality on the full runtime without learning'],
  ['31406fd8452bbc050cd6328d5cd7f317383b0603', 'chore(deps): bump @framers/* deps to latest published versions (#574)'],
  ['d98b5992e96b9599ed9d33030ecef5b43d9a4f5e', 'feat(personas): add a grounded writing register and notetaker preset'],
];

function notesPluginConfig(): Record<string, unknown> {
  const entry = config.plugins.find((plugin: unknown) => Array.isArray(plugin) && plugin[0] === NOTES_PLUGIN);
  if (!Array.isArray(entry)) throw new Error(`${NOTES_PLUGIN} is not in release.config.js`);
  return entry[1];
}

describe('release notes from release.config.js', () => {
  let lines: string[] = [];

  beforeAll(async () => {
    const notes: string = await generateNotes(notesPluginConfig(), {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      commits: COMMITS.map(([hash, message]) => ({ hash, message })),
      lastRelease: { gitTag: 'v0.14.25', gitHead: '31089cdeccfc15b98cbf87298f2b736120eaf11f', version: '0.14.25' },
      nextRelease: { type: 'minor', version: '0.15.0', gitTag: 'v0.15.0', gitHead: '34a41019064210a56868ab10f85ebb1d3ecfe1c9' },
      options: { repositoryUrl: config.repositoryUrl },
    });
    lines = notes.split('\n');
  });

  it('titles the sections as the preset does and leaves the hidden types out', () => {
    expect(lines.filter((line) => line.startsWith('### '))).toEqual([BREAKING_HEADING, '### Features', '### Bug Fixes']);
  });

  it('leaves merge commits out', () => {
    expect(lines.filter((line) => line.startsWith('* Merge '))).toEqual([]);
  });

  it('lists only the breaking-change notes under their heading', () => {
    const start = lines.indexOf(BREAKING_HEADING);
    expect(start).toBeGreaterThan(-1);
    const next = lines.findIndex((line, index) => index > start && line.startsWith('### '));
    const block = lines.slice(start + 1, next === -1 ? lines.length : next).filter((line) => line.trim() !== '');
    expect(block).toEqual([
      '* **personas:** adapt_personality now refuses honesty and emotionality with operator_only even when the host has no learning layer.',
    ]);
  });

  it('links each commit by its 7-character hash', () => {
    expect(lines).toContain(
      '* **personas:** enforce operator-only traits on every host ([c127901](https://github.com/framerslab/agentos/commit/c1279014a5b5e4c89118f9cd8e1f50c2312cc6f6))',
    );
  });
});
