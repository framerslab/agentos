import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(here, '../browser.ts');

/** Every module the entry reaches, with what each imports or re-exports from. */
function reach(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    const found = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s(?!type\s)[^;]*?\sfrom\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
      (match) => match[1] ?? match[2] ?? match[3],
    );
    seen.set(file, found);
    for (const specifier of found) {
      if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
    }
  }
  return seen;
}

describe('the library\'s browser entry', () => {
  it('reaches no Node module and no package: only this repository\'s own files', () => {
    const outside: string[] = [];
    for (const [file, specifiers] of reach(ENTRY)) {
      for (const specifier of specifiers) {
        if (!specifier.startsWith('.')) outside.push(`${file}: ${specifier}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it('names what a page needs', async () => {
    const entry = await import('../browser.js');
    expect(Object.keys(entry).sort()).toEqual(expect.arrayContaining(['LexicalIndex', 'chunkTurns', 'lexicalTokens', 'snippetAround']));
  });
});
