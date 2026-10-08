/**
 * @fileoverview The broker's `fs.writeFile` and `fs.unlink` for code-forged
 * tools under a ceiling: the path checks against the roots (lexical, then
 * the parent's real path, then the last component), and the operations. A
 * write opens its file with an exclusive create and no signal, so the broker
 * always knows whether it made the file, and writes through the handle in
 * chunks, checking the call's signal and its own time bound between them: a
 * cut write closes the handle and removes what it made. A removal or a
 * rename, once started, runs to its end. Node has no `openat`, so a process
 * that swaps a parent directory for a link between the check and the open is
 * outside what these checks stop; and an exclusive create on a network file
 * system that does not honour it is too. The documentation says both.
 * @module @framers/agentos/emergent/broker/fs-write
 */

import { lstat, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import type { DryRunOverlay } from './dry-run.js';
import { withinRoots } from './fs-read.js';
import { isProtectedRoot } from './protected.js';
import { CapabilityRefusal } from './refusal.js';

/** The bytes a write hands the file system at once; the call's signal is checked between them. */
const CHUNK_BYTES = 64 * 1024;

/**
 * An effect cut by the call's end or by its own time bound before it was
 * done. `fileLeft` is set when the broker could not remove a file it made.
 */
export class EffectCut extends CapabilityRefusal {
  constructor(
    readonly outcome: 'aborted' | 'timed_out',
    detail: string,
    readonly fileLeft: boolean = false,
  ) {
    super(fileLeft ? 'file_left' : outcome, detail);
  }
}

/**
 * Write or delete roots, each root's real path resolved lazily and pinned,
 * as the broker's read roots are. A root whose real path is protected (see
 * protected.ts) is set apart when it resolves: a target under it is refused
 * with `protected_path`, whether the root existed at construction or not.
 */
export class EffectRoots {
  private readonly cache = new Map<string, Promise<string | undefined>>();
  private readonly guarded = new Set<string>();

  constructor(
    readonly roots: readonly string[],
    private readonly protectedReal: readonly string[],
  ) {}

  /** The roots' real paths, the protected ones set apart. */
  async real(): Promise<{ allowed: string[]; guarded: string[] }> {
    const allowed: string[] = [];
    for (const root of this.roots) {
      const real = await this.realOf(root);
      if (real !== undefined && !this.guarded.has(real)) {
        allowed.push(real);
      }
    }
    return { allowed, guarded: [...this.guarded] };
  }

  private realOf(root: string): Promise<string | undefined> {
    const cached = this.cache.get(root);
    if (cached !== undefined) {
      return cached;
    }
    const pending = realpath(root).then(
      (real) => {
        if (isProtectedRoot(real, this.protectedReal)) {
          this.guarded.add(real);
        }
        return real;
      },
      () => {
        // A root that does not resolve yet grants nothing until it does.
        this.cache.delete(root);
        return undefined;
      },
    );
    this.cache.set(root, pending);
    return pending;
  }
}

/** What the run's view says of a path: the overlay first in a dry run, then the real tree. */
async function kindOf(target: string, overlay: DryRunOverlay | undefined): Promise<'file' | 'other' | 'absent'> {
  const seen = overlay?.look(target);
  if (seen === 'file') {
    return 'file';
  }
  if (seen === 'absent') {
    return 'absent';
  }
  try {
    const stats = await lstat(target);
    return stats.isFile() ? 'file' : 'other';
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'absent';
    }
    throw error;
  }
}

/**
 * The path checks of a write or a delete, in order: a path string; the path
 * resolved as a read's is (against the process's working directory) and
 * checked against the roots; the real path of its parent checked against the
 * roots' real paths, the parent having to exist (no directory is made).
 * Returns the target as written: the parent's real path and the last
 * component.
 */
async function checkPath(filePath: unknown, roots: EffectRoots, functionName: string): Promise<string> {
  if (typeof filePath !== 'string') {
    throw new CapabilityRefusal('invalid_path', `${functionName} takes a path string`);
  }
  const resolved = path.resolve(filePath);
  if (!withinRoots(resolved, roots.roots)) {
    throw new CapabilityRefusal('path_not_allowed', resolved);
  }
  const name = path.basename(resolved);
  if (name === '' || resolved === path.parse(resolved).root) {
    throw new CapabilityRefusal('not_a_file', resolved);
  }
  let parent: string;
  try {
    parent = await realpath(path.dirname(resolved));
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new CapabilityRefusal('no_such_directory', path.dirname(resolved));
    }
    throw error;
  }
  const { allowed, guarded } = await roots.real();
  if (withinRoots(parent, guarded)) {
    throw new CapabilityRefusal('protected_path', `${resolved} is under a protected root`);
  }
  if (!withinRoots(parent, allowed)) {
    throw new CapabilityRefusal('path_not_allowed', `${resolved} resolves outside the roots`);
  }
  return path.join(parent, name);
}

/**
 * A write's scope: the path checks, then the last component, which may
 * exist only as a regular file, and under `create-only` not at all.
 */
export async function checkWrite(
  filePath: unknown,
  roots: EffectRoots,
  mode: 'create-only' | 'create-or-replace',
  overlay?: DryRunOverlay,
): Promise<string> {
  const target = await checkPath(filePath, roots, 'fs.writeFile');
  const kind = await kindOf(target, overlay);
  if (kind === 'other') {
    throw new CapabilityRefusal('not_a_file', target);
  }
  if (kind === 'file' && mode === 'create-only') {
    throw new CapabilityRefusal('file_exists', target);
  }
  return target;
}

/** A delete's scope: the path checks, then the last component, which must be a regular file. */
export async function checkDelete(filePath: unknown, roots: EffectRoots, overlay?: DryRunOverlay): Promise<string> {
  const target = await checkPath(filePath, roots, 'fs.unlink');
  const kind = await kindOf(target, overlay);
  if (kind === 'absent') {
    throw new CapabilityRefusal('no_such_file', target);
  }
  if (kind === 'other') {
    throw new CapabilityRefusal('not_a_file', target);
  }
  return target;
}

/** The data a write carries, as bytes: a string is written as UTF-8. */
export function writeBytes(data: unknown): Uint8Array {
  if (typeof data === 'string') {
    return Buffer.from(data, 'utf8');
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new CapabilityRefusal('unsupported_data', 'fs.writeFile takes a string, an ArrayBuffer or a typed array');
}

async function removeQuietly(file: string): Promise<boolean> {
  try {
    await unlink(file);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Writes `data` at `target` (already checked). Under `create-only` the
 * target itself is created exclusively; under `create-or-replace` a
 * temporary file beside it, named for the call, is created exclusively and
 * then renamed over the target. A cut (the call's `signal`, or the effect's
 * `timer`, started when the effect was admitted) that arrives while the open
 * runs takes effect once the open settles.
 */
export async function writeAt(
  target: string,
  data: Uint8Array,
  mode: 'create-only' | 'create-or-replace',
  callId: string,
  signal: AbortSignal,
  timer: AbortSignal,
): Promise<{ bytes: number }> {
  const cutNow = (): EffectCut | undefined =>
    signal.aborted
      ? new EffectCut('aborted', target)
      : timer.aborted
        ? new EffectCut('timed_out', target)
        : undefined;
  const before = cutNow();
  if (before) {
    throw before;
  }
  const file = mode === 'create-only' ? target : path.join(path.dirname(target), `.${path.basename(target)}.${callId}.tmp`);
  let handle: FileHandle;
  try {
    handle = await open(file, 'wx');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // Put there between the check and the open.
      throw new CapabilityRefusal('file_exists', file);
    }
    throw error;
  }
  let failure: unknown;
  try {
    for (let offset = 0; offset < data.byteLength; ) {
      const cut = cutNow();
      if (cut) {
        failure = cut;
        break;
      }
      const { bytesWritten } = await handle.write(data, offset, Math.min(CHUNK_BYTES, data.byteLength - offset));
      offset += bytesWritten;
    }
  } catch (error: unknown) {
    failure = error;
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (failure === undefined && mode === 'create-or-replace') {
    try {
      await rename(file, target);
    } catch (error: unknown) {
      failure = error;
    }
  }
  if (failure !== undefined) {
    const removed = await removeQuietly(file);
    if (failure instanceof EffectCut) {
      throw removed ? failure : new EffectCut(failure.outcome, `${file} could not be removed`, true);
    }
    throw failure;
  }
  return { bytes: data.byteLength };
}

/**
 * Removes `target` (already checked): one directory entry, a regular file.
 * The removal is one system call: the call's `signal` and the effect's
 * `timer` can stop it from starting, and once started it runs to its end.
 */
export async function removeAt(target: string, signal: AbortSignal, timer: AbortSignal): Promise<{ bytes: number }> {
  if (signal.aborted) {
    throw new EffectCut('aborted', target);
  }
  if (timer.aborted) {
    throw new EffectCut('timed_out', target);
  }
  await unlink(target);
  return { bytes: 0 };
}
