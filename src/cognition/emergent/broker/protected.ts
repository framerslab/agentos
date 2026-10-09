/**
 * @fileoverview The paths no `fs.write` or `fs.delete` root may hold or lie
 * inside: the library's own package directory, the `node_modules` directory
 * it was loaded from, the directory of the process's entry script, and the
 * paths the host lists in `protectedPaths`; and no root may pass through a
 * directory named `node_modules`. The check is partial, and the
 * documentation says so: the library cannot find a host's own code and data
 * in general, so the host lists them.
 * @module @framers/agentos/emergent/broker/protected
 */

import { readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@framers/agentos';

function realOrResolved(candidate: string): string {
  const resolved = path.resolve(candidate);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** Whether `candidate` is `root` or lies under it, by path segments. */
function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** The directory of the package.json named `@framers/agentos` above this module, if one is found. */
function libraryRoot(): string | undefined {
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown };
      if (manifest.name === PACKAGE_NAME) {
        return dir;
      }
    } catch {
      // Not this directory; look one up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
  return undefined;
}

/**
 * The real paths a write or delete root may neither hold nor lie inside,
 * computed once per engine: the library's package directory, the nearest
 * `node_modules` above it, the entry script's directory, and the host's list.
 */
export function protectedRealPaths(hostPaths: readonly string[] = []): string[] {
  const found = new Set<string>();
  const library = libraryRoot();
  if (library) {
    const real = realOrResolved(library);
    found.add(real);
    const segments = real.split(path.sep);
    const index = segments.lastIndexOf('node_modules');
    if (index > 0) {
      found.add(segments.slice(0, index + 1).join(path.sep));
    }
  }
  const entry = process.argv[1];
  if (typeof entry === 'string' && entry !== '') {
    found.add(path.dirname(realOrResolved(entry)));
  }
  for (const hostPath of hostPaths) {
    found.add(realOrResolved(hostPath));
  }
  return [...found];
}

/** A root (by its real path) that holds or lies inside a protected path, or passes through `node_modules`. */
export function isProtectedRoot(realRoot: string, protectedReal: readonly string[]): boolean {
  if (realRoot.split(path.sep).includes('node_modules')) {
    return true;
  }
  return protectedReal.some((guarded) => within(realRoot, guarded) || within(guarded, realRoot));
}
