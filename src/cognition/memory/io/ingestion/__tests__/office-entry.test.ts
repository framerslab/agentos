/**
 * @fileoverview The office loader's entry, `@framers/agentos/cognition/memory/office`,
 * read as source: importing it loads no package and no Node built-in, and
 * officeparser, its optional peer, is imported by `load` alone, so a host that
 * never reads an office document never loads it. No other module of the
 * package imports officeparser.
 *
 * The walk follows static imports and re-exports, and side-effect imports,
 * from the entry through the repository's own files. A type-only import is
 * erased by the compiler and is not followed; a dynamic import is listed apart.
 *
 * @module memory/ingestion/__tests__/office-entry.test
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DocumentTooLargeError as WordLoaderError } from '../DocxLoader.js';
import { DocumentTooLargeError as OfficeEntryError } from '../OfficeLoader.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../../..');
const src = join(root, 'src');
const ENTRY = resolve(here, '../OfficeLoader.ts');

/** Static imports and re-exports with a `from` clause; `import type` and `export type` are left out. */
const STATIC_FROM = /(?:^|\n)\s*(?:import|export)\s(?!type\s)[^;]*?\sfrom\s+['"]([^'"]+)['"]/g;

/** Side-effect imports: `import 'x'`. */
const SIDE_EFFECT = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

/** Dynamic imports of a literal specifier. */
const DYNAMIC = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** What a module imports, split into what loads with it and what it imports when it runs. */
function importsOf(file: string): { statics: string[]; dynamics: string[] } {
  const source = readFileSync(file, 'utf8');
  const statics = [...source.matchAll(STATIC_FROM), ...source.matchAll(SIDE_EFFECT)].map((match) => match[1]);
  const dynamics = [...source.matchAll(DYNAMIC)].map((match) => match[1]);
  return { statics, dynamics };
}

/**
 * The file a relative specifier names, tried as TypeScript resolves it: the specifier with `.ts` added, its `.js`
 * read as `.ts`, then its folder's `index.ts`. A specifier that names none of them fails the walk by name.
 */
function resolveRelative(file: string, specifier: string): string {
  const base = resolve(dirname(file), specifier);
  const candidates = [`${base}.ts`, ...(base.endsWith('.js') ? [`${base.slice(0, -3)}.ts`] : []), join(base, 'index.ts')];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new Error(`${file}: ${specifier} names no file (tried ${candidates.join(', ')})`);
  return found;
}

/** Every module that loads with the entry, by static imports, with what each imports. */
function loadsWith(entry: string): Map<string, { statics: string[]; dynamics: string[] }> {
  const seen = new Map<string, { statics: string[]; dynamics: string[] }>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    const found = importsOf(file);
    seen.set(file, found);
    for (const specifier of found.statics) {
      if (specifier.startsWith('.')) queue.push(resolveRelative(file, specifier));
    }
  }
  return seen;
}

/** A path under the repository, with forward slashes. */
function fromRoot(file: string): string {
  return relative(root, file).split(sep).join('/');
}

/** Whether a specifier names officeparser or a file inside it. */
function isOfficeparser(specifier: string): boolean {
  return specifier === 'officeparser' || specifier.startsWith('officeparser/');
}

describe('the office loader entry', () => {
  it('loads only its own module and the error module: no package and no Node built-in', () => {
    const graph = loadsWith(ENTRY);
    expect([...graph.keys()].map(fromRoot).sort()).toEqual([
      'src/cognition/memory/io/ingestion/DocumentTooLargeError.ts',
      'src/cognition/memory/io/ingestion/OfficeLoader.ts',
    ]);
    const outside = [...graph].flatMap(([file, found]) =>
      found.statics.filter((specifier) => !specifier.startsWith('.')).map((specifier) => `${fromRoot(file)}: ${specifier}`),
    );
    expect(outside).toEqual([]);
  });

  it('imports officeparser when it reads, and nothing else', () => {
    const dynamics = [...loadsWith(ENTRY)].flatMap(([file, found]) =>
      found.dynamics.map((specifier) => `${fromRoot(file)}: ${specifier}`),
    );
    expect(dynamics).toEqual(['src/cognition/memory/io/ingestion/OfficeLoader.ts: officeparser']);
  });

  it('is the only module of the package that imports officeparser, and none imports it when it loads', () => {
    const modules = readdirSync(src, { encoding: 'utf8', recursive: true })
      .filter((name) => name.endsWith('.ts') && !name.split(/[\\/]/).includes('__tests__'))
      .map((name) => join(src, name))
      // Only a module that names officeparser can import it; the others are not parsed.
      .filter((file) => readFileSync(file, 'utf8').includes('officeparser'));
    expect(modules.map(fromRoot)).toContain('src/cognition/memory/io/ingestion/OfficeLoader.ts');
    const statically: string[] = [];
    const dynamically: string[] = [];
    for (const file of modules) {
      const { statics, dynamics } = importsOf(file);
      if (statics.some(isOfficeparser)) statically.push(fromRoot(file));
      if (dynamics.some(isOfficeparser)) dynamically.push(fromRoot(file));
    }
    expect(statically).toEqual([]);
    expect(dynamically).toEqual(['src/cognition/memory/io/ingestion/OfficeLoader.ts']);
  });

  it('is the package export ./cognition/memory/office, with officeparser an optional peer and no side effects', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
      sideEffects: unknown;
      peerDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
      dependencies?: Record<string, string>;
    };
    expect(pkg.exports['./cognition/memory/office']).toEqual({
      types: './dist/cognition/memory/io/ingestion/OfficeLoader.d.ts',
      import: './dist/cognition/memory/io/ingestion/OfficeLoader.js',
      default: './dist/cognition/memory/io/ingestion/OfficeLoader.js',
    });
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.peerDependencies.officeparser).toBeDefined();
    expect(pkg.peerDependenciesMeta.officeparser).toEqual({ optional: true });
    expect(pkg.dependencies?.officeparser).toBeUndefined();
  });

  it('exports the error the Word loader throws, so one instanceof check covers both', () => {
    expect(OfficeEntryError).toBe(WordLoaderError);
    expect(new OfficeEntryError(10)).toBeInstanceOf(WordLoaderError);
  });
});
