/**
 * @fileoverview A forge test's view of the files it touched. In a dry run
 * every check is made as in a real call, but a write lands in a temporary
 * directory made for the run, a delete marks its target gone for the run,
 * and every check that asks whether a path exists, or what it is, asks this
 * overlay first and the real tree second. A state-changing request is never
 * sent: it takes the first unused answer the test case gave for its method
 * and URL, or a `204` saying it was not sent.
 * @module @framers/agentos/emergent/broker/dry-run
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ForgeTestResponse, HttpMethod } from '../types.js';

/** The answers one forge test case may give its state-changing requests. */
export const MAX_TEST_RESPONSES = 16;

/** The header a state-changing request answered by a dry run carries when the test case gave no answer for it. */
export const NOT_SENT_HEADER = 'x-agentos-forge-test';

/** What the overlay knows of a path: written by the run, deleted by it, or nothing (ask the real tree). */
export type OverlayEntry = 'file' | 'absent' | undefined;

export class DryRunOverlay {
  private dir: Promise<string> | undefined;
  private readonly written = new Map<string, string>();
  private readonly deleted = new Set<string>();
  private readonly used = new Set<number>();
  private counter = 0;

  constructor(private readonly responses: readonly ForgeTestResponse[]) {}

  /** What the run did to `target` (a real path), if anything. */
  look(target: string): OverlayEntry {
    if (this.written.has(target)) {
      return 'file';
    }
    return this.deleted.has(target) ? 'absent' : undefined;
  }

  /** A write: the data goes to the run's own directory; the target reads as that file for the rest of the run. */
  async write(target: string, data: Uint8Array): Promise<void> {
    this.dir ??= mkdtemp(path.join(tmpdir(), 'agentos-dry-run-'));
    const dir = await this.dir;
    this.counter += 1;
    const file = path.join(dir, String(this.counter));
    await writeFile(file, data, { flag: 'wx' });
    this.written.set(target, file);
    this.deleted.delete(target);
  }

  /** A delete: the target reads as absent for the rest of the run. */
  remove(target: string): void {
    this.written.delete(target);
    this.deleted.add(target);
  }

  /** The bytes the run wrote at `target`, or undefined when it wrote none there. */
  async read(target: string): Promise<Buffer | undefined> {
    const file = this.written.get(target);
    return file === undefined ? undefined : readFile(file);
  }

  /** The answer for a state-changing request, which is not sent. */
  answer(method: HttpMethod, url: URL): Response {
    for (let index = 0; index < this.responses.length; index += 1) {
      const candidate = this.responses[index];
      if (this.used.has(index) || candidate.method !== method) {
        continue;
      }
      let candidateUrl: string;
      try {
        candidateUrl = new URL(candidate.url).href;
      } catch {
        continue;
      }
      if (candidateUrl === url.href) {
        this.used.add(index);
        // These statuses carry no body; the forge refuses an answer outside 200 to 599.
        const noBody = candidate.status === 204 || candidate.status === 205 || candidate.status === 304;
        return new Response(noBody ? null : (candidate.body ?? null), {
          status: candidate.status,
          headers: candidate.headers ?? {},
        });
      }
    }
    return new Response(null, { status: 204, headers: { [NOT_SENT_HEADER]: 'not-sent' } });
  }

  /** Removes the run's directory. */
  async dispose(): Promise<void> {
    const dir = this.dir;
    this.dir = undefined;
    if (dir) {
      await rm(await dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
