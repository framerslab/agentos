/**
 * @fileoverview What each entry of an archive or a folder becomes, before anything is read or sent: a document of a
 * type the caller reads, a transcript, a recording, or skipped with its reason; its title from its path, a Notion
 * export's trailing id dropped; its folder; and a nested archive opened one level deep. It holds no product rule: the
 * caller passes its types, its bounds and its archive opener. Beside it, `sha256Hex` hashes a text so a caller can find
 * two copies of one text. Browser-safe: it imports nothing but the library's own SHA-256.
 * @module agentos/cognition/library/planEntries
 */

import { sha256Hex as sha256HexSync } from '../../core/utils/sha256.js';

/** An entry as the caller lists it: its path inside the archive or folder, with `/` between parts, and its size. */
export interface PlanEntryInput {
  path: string;
  /** In bytes. */
  size: number;
}

/** What an entry can become. */
export type PlannedKind = 'document' | 'transcript' | 'recording';

/** The caller's rules. Extensions are written in lower case with their dot, as `.md`. */
export interface PlanRules {
  /** A document's extension to its media type. */
  documentTypes: Readonly<Record<string, string>>;
  /** The extensions read as transcripts. */
  transcriptExtensions: readonly string[];
  /** The extensions read as recordings. */
  recordingExtensions: readonly string[];
  /** The extensions of an archive the plan opens. @default ['.zip'] */
  archiveExtensions?: readonly string[];
  /**
   * The most bytes an entry of each kind may hold, and, for `archive`, the most a nested archive may hold for the plan
   * to open it: 0, any positive number or `Infinity`. An entry whose size is no byte count (a finite number of 0 or
   * more) is skipped with the reason `size`; a bound below 0, `NaN` or no number at all (`null`, a numeric text such as
   * `'5'`, `true`, an object) rejects the plan with a `RangeError`.
   */
  maxBytes: (kind: PlannedKind | 'archive') => number;
  /**
   * Lists a nested archive's entries, once its size is within `maxBytes('archive')`; without it, a nested archive is
   * skipped. What it throws rejects the plan.
   */
  openArchive?: (path: string) => Promise<PlanEntryInput[]>;
  /**
   * The most entries planned, skipped ones included: those past it are skipped with the reason `count`. A count below
   * 0, `NaN` or no number at all (`null`, a numeric text such as `'5'`, `true`, an object) rejects the plan with a
   * `RangeError`.
   * @default Infinity
   */
  maxEntries?: number;
}

/** Why an entry is skipped. */
export type PlanSkipReason = 'type' | 'size' | 'path' | 'nested' | 'count';

/** One entry's plan. */
export interface PlannedEntry {
  /** The entry's path, as listed. */
  path: string;
  /** The archive a nested entry was listed from; `null` for an entry of the top level. */
  within: string | null;
  /** The file's name with its extension dropped, and a Notion export's trailing id. */
  title: string;
  /** The folders on its path, each with a Notion export's trailing id dropped; `null` at the top. */
  folder: string | null;
  /** What the entry becomes, or `skipped` with its `reason`. */
  becomes: PlannedKind | 'skipped';
  /** A document's media type, from the caller's types; `null` for anything else. */
  mediaType: string | null;
  /** Why it is skipped; `null` when it is not. */
  reason: PlanSkipReason | null;
}

/** A Notion export's 32-hex id at the end of a page's or a folder's name. */
const NOTION_ID = /\s[0-9a-f]{32}$/i;

/** A path's extension in lower case with its dot, or `''`. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** A path's title: its file name with the extension and a Notion id dropped, or the name when nothing else is left. */
function titleOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const base = name.replace(/\.[^.]+$/, '');
  return base.replace(NOTION_ID, '').trim() || name;
}

/** A path's folder: the parts before its name, each with a Notion id dropped, or `null` at the top. */
function folderOf(path: string): string | null {
  const parts = path.split('/').slice(0, -1).map((part) => part.replace(NOTION_ID, '').trim());
  return parts.length === 0 ? null : parts.join('/');
}

/**
 * Whether a path leaves its archive or folder: an absolute path, one on a drive (`C:/notes.md`, `C:notes.md`), a
 * backslash, a `..` part or an empty part.
 */
function climbs(path: string): boolean {
  return (
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '..' || part === '')
  );
}

/**
 * Whether a count or a bound is a number of 0 or more, `Infinity` among them. `NaN` is none, and neither is anything
 * that is no number, though JavaScript compares `null` as 0, a numeric text as its number and `true` as 1.
 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && value >= 0;
}

/**
 * A count or a bound as an error names it, with none of its own code run: a text quoted, so `'5'` reads apart from 5;
 * a bigint with its `n`; an object or a function by its kind alone, since its own `toString` could throw in place of
 * the `RangeError`, and an object made with no prototype has no `toString` to call.
 */
function shown(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return 'a function';
  if (typeof value === 'object' && value !== null) return 'an object';
  return String(value);
}

/**
 * The plan of every entry, in order, a nested archive's entries in its place. A folder's own entry (a path that ends
 * with `/`, as a ZIP lists one) is no file and is left out. The plan reads no file, so two copies of one text are
 * planned alike: a caller finds them by the hash of what it reads, as `sha256Hex` gives it.
 *
 * @param entries - The entries of an archive or a folder.
 * @param rules - The caller's types, bounds and archive opener.
 * @throws RangeError when `maxEntries`, or what `maxBytes` answers for a kind it is asked about, is below 0, `NaN` or no
 * number at all (`null`, a numeric text, `true`, an object, whatever its own `toString` does).
 */
export async function planEntries(entries: readonly PlanEntryInput[], rules: PlanRules): Promise<PlannedEntry[]> {
  const planned: PlannedEntry[] = [];
  const archives = rules.archiveExtensions ?? ['.zip'];
  // Only a count left out is Infinity: null is a count given as no number, and is refused below.
  const countGiven: unknown = rules.maxEntries === undefined ? Number.POSITIVE_INFINITY : rules.maxEntries;
  // A count that is no number would let every entry past it, so it is refused, as a bound that is no number is below.
  if (!isCount(countGiven)) throw new RangeError(`planEntries: maxEntries must be a number of 0 or more, not ${shown(countGiven)}`);
  const maxEntries: number = countGiven;

  /** Whether a size is a byte count within the caller's bound for its kind. */
  const fits = (size: number, kind: PlannedKind | 'archive'): boolean => {
    const bound: unknown = rules.maxBytes(kind);
    if (!isCount(bound)) throw new RangeError(`planEntries: maxBytes('${kind}') must answer a number of 0 or more, not ${shown(bound)}`);
    return Number.isFinite(size) && size >= 0 && size <= bound;
  };

  const visit = async (entry: PlanEntryInput, within: string | null): Promise<void> => {
    if (entry.path.endsWith('/')) return;
    const base = { path: entry.path, within, title: titleOf(entry.path), folder: folderOf(entry.path), mediaType: null };
    if (planned.length >= maxEntries) {
      planned.push({ ...base, becomes: 'skipped', reason: 'count' });
      return;
    }
    if (climbs(entry.path)) {
      planned.push({ ...base, becomes: 'skipped', reason: 'path' });
      return;
    }
    const extension = extensionOf(entry.path);
    if (archives.includes(extension)) {
      if (within !== null || rules.openArchive === undefined) {
        planned.push({ ...base, becomes: 'skipped', reason: 'nested' });
        return;
      }
      if (!fits(entry.size, 'archive')) {
        planned.push({ ...base, becomes: 'skipped', reason: 'size' });
        return;
      }
      for (const inner of await rules.openArchive(entry.path)) await visit(inner, entry.path);
      return;
    }
    const becomes: PlannedKind | null = Object.prototype.hasOwnProperty.call(rules.documentTypes, extension)
      ? 'document'
      : rules.transcriptExtensions.includes(extension)
        ? 'transcript'
        : rules.recordingExtensions.includes(extension)
          ? 'recording'
          : null;
    if (becomes === null) {
      planned.push({ ...base, becomes: 'skipped', reason: 'type' });
      return;
    }
    if (!fits(entry.size, becomes)) {
      planned.push({ ...base, becomes: 'skipped', reason: 'size' });
      return;
    }
    planned.push({ ...base, becomes, mediaType: becomes === 'document' ? rules.documentTypes[extension] : null, reason: null });
  };

  for (const entry of entries) await visit(entry, null);
  return planned;
}

/** The part of Web Crypto `sha256Hex` uses. */
interface Digester {
  digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
}

/**
 * The SHA-256 of a text's UTF-8 bytes, or of bytes, in lower-case hexadecimal: by the platform's `crypto.subtle`
 * where it has one, and by the library's own SHA-256 where it has none, as in a page outside a secure context.
 *
 * @param input - A text, hashed as UTF-8, or bytes.
 */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const subtle = (globalThis as unknown as { crypto?: { subtle?: Digester } }).crypto?.subtle;
  if (subtle === undefined) return sha256HexSync(input);
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
