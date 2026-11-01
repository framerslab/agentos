/**
 * @file configurationErrorDocs.test.ts
 * The docs name the code a host reads when the runtime refuses a configuration.
 * The error's `code` is the string `SYS_CONFIGURATION_ERROR`, the value of
 * `GMIErrorCode.CONFIGURATION_ERROR`; a host that compares `err.code` with the
 * member's name never matches. A page names the member only with the string
 * beside it, as `CONFIGURATION_ERROR` (`SYS_CONFIGURATION_ERROR`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GMIErrorCode } from '../errors';

/** The repository's root, which holds docs/. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The Markdown pages under docs/. */
const DOCS = path.join(ROOT, 'docs');

/** Every Markdown page under `dir`, with the generated API reference left out. */
function pages(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return full === path.join(DOCS, 'api') ? [] : pages(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

/** The member's name in backticks, where the string a host reads does not follow it. */
const BARE_MEMBER = /`CONFIGURATION_ERROR`(?! \(`SYS_CONFIGURATION_ERROR`\))/g;

describe('the docs on a configuration refusal', () => {
  it('name the string a host reads in err.code', () => {
    expect(GMIErrorCode.CONFIGURATION_ERROR).toBe('SYS_CONFIGURATION_ERROR');
    const bare = pages(DOCS).flatMap((file) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) => [...line.matchAll(BARE_MEMBER)].map(() => `${path.relative(ROOT, file)} line ${index + 1}`)),
    );
    expect(bare).toEqual([]);
  });

  it('read the pages under docs/', () => {
    expect(pages(DOCS)).toContain(path.join(DOCS, 'GMI.md'));
  });
});
