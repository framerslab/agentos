/**
 * The browser entries' module graphs, read from the build.
 *
 * `@framers/agentos/io/voice-pipeline/browser` is the entry a browser bundle
 * imports, so nothing it reaches may import a Node built-in, or any package:
 * every module in its graph is one of the library's own, imported by a
 * relative path. This suite walks the built files from the entry, following
 * every static import and re-export and every dynamic import of a literal
 * path on a line of code, and fails on any other specifier. A dynamic import
 * of a variable is not an edge of the graph, as it is not one for a bundler.
 *
 * `@framers/agentos/io/hearing/capture` is a browser entry as well, held to
 * the same rule. Its worklet module, `capture-worklet.js`, is a file a host
 * copies to its own origin and loads by its address, so it imports nothing.
 *
 * CI builds before it tests, and there the suite always runs: a missing build
 * fails it instead of skipping it. On a machine without a build it is skipped
 * (run `pnpm run build` first to check the current source).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(here, '../../../../dist');
const entry = path.join(distRoot, 'io', 'voice-pipeline', 'browser.js');
const inCI = Boolean(process.env.CI);

/**
 * Static imports and re-exports with a `from` clause, side-effect imports,
 * and dynamic imports of a literal path on a line that is not a comment (the
 * build keeps TSDoc, whose lines start with `*`).
 */
const SPECIFIER_PATTERNS = [
  /^\s*(?:import|export)\s+[\w*{}\s,$]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /^(?!\s*(?:\*|\/\/|\/\*))[^\n]*?\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm,
];

/** The specifiers a built module imports. */
function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

/** Every module reachable from `start` by relative specifiers, with what each imports. */
function walk(start: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (graph.has(file)) continue;
    const specifiers = specifiersOf(readFileSync(file, 'utf8'));
    graph.set(file, specifiers);
    for (const specifier of specifiers) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        queue.push(path.resolve(path.dirname(file), specifier));
      }
    }
  }
  return graph;
}

/** A built file's path under `dist`, with forward slashes. */
function fromDist(file: string): string {
  return path.relative(distRoot, file).split(path.sep).join('/');
}

describe.skipIf(!inCI && !existsSync(entry))('the browser entry of the voice pipeline', () => {
  it("imports only the library's own modules, so no Node built-in and no package", () => {
    expect(existsSync(entry), `${fromDist(entry)} is not built`).toBe(true);
    const outside = [...walk(entry)].flatMap(([file, specifiers]) =>
      specifiers
        .filter((specifier) => !specifier.startsWith('./') && !specifier.startsWith('../'))
        .map((specifier) => `${fromDist(file)} imports ${specifier}`)
    );
    expect(outside).toEqual([]);
  });

  it('reaches the modules it is the entry for', () => {
    const files = [...walk(entry).keys()].map(fromDist);
    expect(files).toEqual(
      expect.arrayContaining([
        'io/voice-pipeline/browser.js',
        'io/voice-pipeline/transcriptLedger.js',
        'io/voice-pipeline/inputLevel.js',
      ])
    );
  });
});

/** The capture entry, and the worklet module a host serves on its own. */
const captureEntry = path.join(distRoot, 'io', 'hearing', 'AudioWorkletCapture.js');
const captureWorklet = path.join(distRoot, 'io', 'hearing', 'capture-worklet.js');

describe.skipIf(!inCI && !existsSync(captureEntry))('the capture entry of hearing', () => {
  it("imports only the library's own modules, and its worklet module imports nothing", () => {
    expect(existsSync(captureEntry), `${fromDist(captureEntry)} is not built`).toBe(true);
    const graph = walk(captureEntry);
    const outside = [...graph].flatMap(([file, specifiers]) =>
      specifiers
        .filter((specifier) => !specifier.startsWith('./') && !specifier.startsWith('../'))
        .map((specifier) => `${fromDist(file)} imports ${specifier}`)
    );
    expect(outside).toEqual([]);
    expect([...graph.keys()].map(fromDist)).toEqual(
      expect.arrayContaining([
        'io/hearing/AudioWorkletCapture.js',
        'io/hearing/capture-worklet.js',
      ])
    );
    expect(graph.get(captureWorklet), `${fromDist(captureWorklet)} imports`).toEqual([]);
  });
});
