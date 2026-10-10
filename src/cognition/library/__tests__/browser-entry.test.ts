import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(here, '../browser.ts');

/**
 * The file a relative specifier names, tried as TypeScript resolves it: the specifier with `.ts` added, its `.js` read
 * as `.ts`, then its folder's `index.ts`. A specifier that names none of them fails the walk by name.
 */
function resolveRelative(file: string, specifier: string): string {
  const base = resolve(dirname(file), specifier);
  const candidates = [`${base}.ts`, ...(base.endsWith('.js') ? [`${base.slice(0, -3)}.ts`] : []), join(base, 'index.ts')];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new Error(`${file}: ${specifier} names no file (tried ${candidates.join(', ')})`);
  return found;
}

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
      if (specifier.startsWith('.')) queue.push(resolveRelative(file, specifier));
    }
  }
  return seen;
}

/** What the modules a walk reached import from outside this repository, as `file: specifier`. */
function outside(reached: Map<string, string[]>): string[] {
  const found: string[] = [];
  for (const [file, specifiers] of reached) {
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) found.push(`${file}: ${specifier}`);
    }
  }
  return found;
}

describe('the library\'s browser entry', () => {
  it('reaches no Node module and no package: only this repository\'s own files', () => {
    expect(outside(reach(ENTRY))).toEqual([]);
  });

  it('finds the Node module behind an import written without an extension', () => {
    // BM25Index reaches node:module through StopWordFilter, whose import of naturalInterop has no extension.
    const reached = reach(resolve(here, '../../rag/search/BM25Index.ts'));
    expect(outside(reached)).toContain(`${resolve(here, '../../nlp/naturalInterop.ts')}: node:module`);
  });

  it('names what a page needs', async () => {
    const entry = await import('../browser.js');
    expect(Object.keys(entry).sort()).toEqual(expect.arrayContaining(['LexicalIndex', 'chunkTurns', 'lexicalTokens', 'snippetAround']));
  });
});
