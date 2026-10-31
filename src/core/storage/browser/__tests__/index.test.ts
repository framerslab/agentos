/**
 * The storage entry a page imports: the key-value store it exports is the library's, `@framers/sql-storage-adapter/kv`,
 * under the names the entry has always had, so a page's keys stay where they are and AgentOS opens no IndexedDB itself.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as library from '@framers/sql-storage-adapter/kv';
import * as entry from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(here, '../index.ts');
const KV = '@framers/sql-storage-adapter/kv';

/** The names the entry takes from the library, under which a page reaches the key-value store. */
const FROM_THE_LIBRARY = ['MemoryKeyValueStore', 'namespaced', 'IndexedDbKeyValueStore', 'openIndexedDbStore', 'idb', 'createSqlKeyValueStore'] as const;

/** The file a relative specifier names, as TypeScript resolves it: `.ts` added, `.js` read as `.ts`, then the folder's `index.ts`. */
function resolveRelative(file: string, specifier: string): string {
  const base = resolve(dirname(file), specifier);
  const candidates = [`${base}.ts`, ...(base.endsWith('.js') ? [`${base.slice(0, -3)}.ts`] : []), join(base, 'index.ts')];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new Error(`${file}: ${specifier} names no file (tried ${candidates.join(', ')})`);
  return found;
}

/** Every module the entry reaches through a value import or re-export, with what each imports from. */
function reach(start: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [start];
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

/** What the reached modules import from outside this repository, as `file: specifier`. */
function outside(reached: Map<string, string[]>): string[] {
  const found: string[] = [];
  for (const [file, specifiers] of reached) {
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) found.push(`${file}: ${specifier}`);
    }
  }
  return found;
}

describe('the browser storage entry', () => {
  it("exports the library's key-value store under the same names: each one is the function the library exports", () => {
    const own = entry as Record<string, unknown>;
    const theirs = library as Record<string, unknown>;
    for (const name of FROM_THE_LIBRARY) {
      expect(own[name], name).toBeDefined();
      expect(own[name], name).toBe(theirs[name]);
    }
  });

  it("reaches one module outside this repository, the library's key-value module, and opens no IndexedDB itself", () => {
    const reached = reach(INDEX);
    expect(outside(reached)).toEqual([`${INDEX}: ${KV}`]);
    for (const file of reached.keys()) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\bindexedDB\b/);
    }
  });
});
