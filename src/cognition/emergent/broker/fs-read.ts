/**
 * @fileoverview The broker's `fs.readFile` for code-forged tools under a
 * ceiling, and the path rules it shares with the forge's legacy read:
 * lexical containment first, then the real path against the roots' real
 * paths, each root's real path pinned on first success. The read is a
 * stream refused past its limit, so no file is held whole before the limit
 * applies.
 * @module @framers/agentos/emergent/broker/fs-read
 */

import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { CapabilityRefusal } from './refusal.js';

/**
 * Whether a path lies under one of the roots. Decided by `path.relative`, not
 * a string prefix: a root that ends in a separator (`/`, `C:\`) would
 * otherwise be compared against a doubled separator, and `path.relative`
 * applies the platform's case rules. `''` is the root itself; a result that
 * climbs out (`..`, `../x`) or stays absolute (another Windows drive) is
 * outside. Checking the `..` segment, not the prefix, keeps a sibling named
 * `..foo` from reading as an escape.
 */
export function withinRoots(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(root, candidate);
    return (
      relative === '' ||
      (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  });
}

/**
 * Read roots, each root's real path resolved lazily and pinned per root.
 *
 * Both sides of a containment check are real paths: a root is often itself a
 * link (on macOS `/tmp` is a link to `/private/tmp`). A resolved root stays
 * pinned for the life of this object, so a root link repointed under a
 * running sandbox is not followed. A failed resolution is not pinned, so a
 * root that becomes readable later is picked up, and one unreadable root
 * never un-pins a sibling; its lexical form never matches a real path, so it
 * cannot widen the reads while it stays unreadable.
 */
export class ReadRoots {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(readonly roots: readonly string[]) {}

  real(): Promise<string[]> {
    return Promise.all(this.roots.map((root) => this.realOf(root)));
  }

  private realOf(root: string): Promise<string> {
    const cached = this.cache.get(root);
    if (cached !== undefined) {
      return cached;
    }
    const pending = realpath(root).catch(() => {
      this.cache.delete(root);
      return root;
    });
    this.cache.set(root, pending);
    return pending;
  }
}

/** A read refused past its limit, with how far it got. */
export class ReadTooLarge extends CapabilityRefusal {
  constructor(
    readonly bytesRead: number,
    limit: number,
  ) {
    super('file_too_large', `more than ${limit} bytes`);
  }
}

/** The check made before the filesystem is touched: a path string, lexically under a root. Returns the resolved path. */
export function prepareRead(filePath: unknown, roots: ReadRoots): string {
  if (typeof filePath !== 'string') {
    throw new CapabilityRefusal('invalid_path', 'fs.readFile takes a path string');
  }
  const resolved = path.resolve(filePath);
  if (!withinRoots(resolved, roots.roots)) {
    throw new CapabilityRefusal('path_not_allowed', resolved);
  }
  return resolved;
}

/**
 * The real-path check and the read. The file read is the resolved real path,
 * not the caller's string: resolving the caller's string again would walk a
 * link a second time, and the link can be repointed between the two walks.
 */
export async function readPrepared(
  resolved: string,
  roots: ReadRoots,
  scope: { maxBytesPerRead: number; timeoutMs: number },
  signal: AbortSignal,
): Promise<{ text: string; bytes: number }> {
  const real = await realpath(resolved);
  if (!withinRoots(real, await roots.real())) {
    throw new CapabilityRefusal('path_not_allowed', `${resolved} resolves outside the roots`);
  }
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(scope.timeoutMs)]);
  if (bounded.aborted) {
    throw new CapabilityRefusal(signal.aborted ? 'aborted' : 'timed_out', resolved);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const stream = createReadStream(real);

    function finish(error: Error | null, result?: { text: string; bytes: number }): void {
      if (settled) {
        return;
      }
      settled = true;
      bounded.removeEventListener('abort', onAbort);
      if (error) {
        stream.destroy();
        reject(error);
        return;
      }
      resolve(result as { text: string; bytes: number });
    }

    function onAbort(): void {
      finish(new CapabilityRefusal(signal.aborted ? 'aborted' : 'timed_out', resolved));
    }

    bounded.addEventListener('abort', onAbort, { once: true });
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += buffer.byteLength;
      if (total > scope.maxBytesPerRead) {
        finish(new ReadTooLarge(total, scope.maxBytesPerRead));
        return;
      }
      chunks.push(buffer);
    });
    stream.on('error', (error: Error) => finish(error));
    stream.on('end', () => finish(null, { text: Buffer.concat(chunks).toString('utf-8'), bytes: total }));
  });
}

/** The broker's read without its records: the checks, then the read. */
export async function brokeredRead(
  filePath: unknown,
  roots: ReadRoots,
  scope: { maxBytesPerRead: number; timeoutMs: number },
  signal: AbortSignal,
): Promise<string> {
  return (await readPrepared(prepareRead(filePath, roots), roots, scope, signal)).text;
}
