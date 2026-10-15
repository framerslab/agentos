/**
 * @file frontMatter.lint.test.ts
 * The lint rule that keeps gray-matter behind the front-matter module: an
 * import of the package, or of a file inside it, is refused anywhere under
 * src/ except in src/core/utils/frontMatter.ts. Each case lints a text with
 * ESLint and the repository's own configuration, as `pnpm run lint` does.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/** The repository's root, which holds eslint.config.js. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** ESLint with the repository's configuration. */
const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: path.join(ROOT, 'eslint.config.js') });

/**
 * The rules ESLint reports for a module that imports `specifier`, linted as
 * the file at `relativePath`.
 */
async function rulesReported(specifier: string, relativePath: string): Promise<Array<string | null>> {
  const code = `import matter from '${specifier}';\n\nexport const read = matter;\n`;
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, relativePath) });
  return result.messages.map((message) => message.ruleId);
}

describe('the gray-matter import rule', () => {
  it.each(['gray-matter', 'gray-matter/index.js', 'gray-matter/lib/engines.js'])(
    'refuses an import of %s outside the front-matter module',
    async (specifier) => {
      expect(await rulesReported(specifier, 'src/cognition/memory/io/FrontMatterImport.ts')).toContain(
        'no-restricted-imports',
      );
    },
  );

  it('lets the front-matter module import gray-matter', async () => {
    expect(await rulesReported('gray-matter', 'src/core/utils/frontMatter.ts')).not.toContain('no-restricted-imports');
  });
});
