import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(here, '../browser.ts');
/** The page's storage, which the entry re-exports whole. */
const STORAGE_INDEX = resolve(here, '../../../core/storage/browser/index.ts');
/** The one module outside this repository the entry reaches: the library's key-value store, from the storage index alone. */
const KV = '@framers/sql-storage-adapter/kv';

/**
 * The file a relative specifier names, tried as TypeScript resolves it: the file itself when the specifier carries an
 * extension and it exists (a published `.js`), the specifier with `.ts` added, its `.js` read as `.ts`, `.js` added,
 * then its folder's `index.ts` or `index.js`. A specifier that names none of them fails the walk by name.
 */
function resolveRelative(file: string, specifier: string): string {
  const base = resolve(dirname(file), specifier);
  const candidates = [
    ...(/\.[cm]?[jt]s$/.test(base) ? [base] : []),
    `${base}.ts`,
    ...(base.endsWith('.js') ? [`${base.slice(0, -3)}.ts`] : []),
    `${base}.js`,
    join(base, 'index.ts'),
    join(base, 'index.js'),
  ];
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

/** The checkout of the library beside this one, when there is one: vitest.config.ts aliases the package to its source. */
const SIBLING_LIBRARY = resolve(here, '../../../../../sql-storage-adapter');

/**
 * The library's key-value module as the tests reach it: in a checkout of the library beside this one, that module's
 * source, which vitest.config.ts aliases `@framers/sql-storage-adapter/kv` to whenever the sibling's `src/index.ts`
 * exists, whether or not the sibling holds a build; otherwise the published file the installed package names under
 * `./kv`.
 */
function libraryKvEntry(): string {
  if (existsSync(join(SIBLING_LIBRARY, 'src/index.ts'))) {
    const source = join(SIBLING_LIBRARY, 'src/features/kv/index.ts');
    if (!existsSync(source)) throw new Error(`the library beside this checkout has no ${source}, where vitest.config.ts sends ${KV}`);
    return source;
  }
  const manifestPath = createRequire(import.meta.url).resolve('@framers/sql-storage-adapter/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    exports: Record<string, string | { import?: string | { default?: string }; default?: string } | undefined>;
  };
  const kv = manifest.exports['./kv'];
  if (kv === undefined) throw new Error("the library's package.json names no ./kv export");
  const target = typeof kv === 'string' ? kv : typeof kv.import === 'string' ? kv.import : (kv.import?.default ?? kv.default);
  if (target === undefined) throw new Error(`the library's ./kv export names no file: ${JSON.stringify(kv)}`);
  const published = resolve(dirname(manifestPath), target);
  if (!existsSync(published)) throw new Error(`the library's ./kv export names ${published}, which does not exist`);
  return published;
}

describe('the library\'s browser entry', () => {
  it('reaches no Node module and one package module, the library\'s key-value store, from the storage index alone', () => {
    expect(outside(reach(ENTRY))).toEqual([`${STORAGE_INDEX}: ${KV}`]);
  });

  it('reaches, through the key-value module, nothing outside that module: no adapter, so neither sql.js nor pg', () => {
    const kvEntry = libraryKvEntry();
    const reached = reach(kvEntry);
    expect(reached.size).toBeGreaterThan(1);
    expect(outside(reached)).toEqual([]);
    const folder = dirname(kvEntry);
    for (const file of reached.keys()) expect(file.startsWith(folder), file).toBe(true);
  });

  it('finds the Node module behind an import written without an extension', () => {
    // BM25Index reaches node:module through StopWordFilter, whose import of naturalInterop has no extension.
    const reached = reach(resolve(here, '../../rag/search/BM25Index.ts'));
    expect(outside(reached)).toContain(`${resolve(here, '../../nlp/naturalInterop.ts')}: node:module`);
  });

  it('reaches no Node module from FuzzyIndex, which reads words by the library\'s word rule', () => {
    const reached = reach(resolve(here, '../../rag/search/FuzzyIndex.ts'));
    expect([...reached.keys()]).toContain(resolve(here, '../tokens.ts'));
    expect(outside(reached)).toEqual([]);
  });

  it('names what a page needs', async () => {
    const entry = await import('../browser.js');
    expect(Object.keys(entry).sort()).toEqual(
      expect.arrayContaining(['FuzzyIndex', 'LexicalIndex', 'chunkTurns', 'countWords', 'foldText', 'lexicalTokens', 'snippetAround', 'withinOneEdit']),
    );
  });

  it('names the readers of an HTML page and a CSV file', async () => {
    const entry = await import('../browser.js');
    expect(Object.keys(entry)).toEqual(expect.arrayContaining(['readCsv', 'readHtml']));
  });

  it('names a page\'s storage: the key-value store over IndexedDB, in memory or over a SQL table, the outbox and the comparison of lists', async () => {
    const entry = await import('../browser.js');
    expect(Object.keys(entry).sort()).toEqual(
      expect.arrayContaining([
        'IndexedDbKeyValueStore',
        'MemoryKeyValueStore',
        'Outbox',
        'createSqlKeyValueStore',
        'idb',
        'namespaced',
        'openIndexedDbStore',
        'reconcileList',
      ]),
    );
  });
});
