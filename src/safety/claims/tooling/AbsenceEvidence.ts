/**
 * @module safety/claims/tooling/AbsenceEvidence
 *
 * Evidence that a capability does not exist. A tripwire names selectors (route, contract, table and field patterns,
 * source, interface and asset patterns), foundations a match may be (with the reason), the paths searched and the
 * negative probes; `buildAbsenceRecord` searches every target inside the scope, classifies each match, records the
 * full hash of the commit searched, the scoped manifest with its digest and the probes' answers, and reaches one
 * verdict: `absent`, `tripped` or `invalid`. A record with no selectors, a commit that is not a full hash, an empty
 * manifest without a stated reason, or a probe that reached nothing or answered more than once is invalid: a failed
 * request or a missing keyword is never evidence of absence. `absenceAdapter` reads a record again before it lets an
 * `absent` verdict authorize a claim, so a record that lacks its commit, terms or reason, or whose manifest no longer
 * matches its digest, authorizes nothing. `inventoryDiff` refuses an addition to the route, contract, schema or
 * interface inventory that nobody classified, a blank classification counting as none, so a rename cannot evade a
 * selector.
 */
import { digestOf, sha256Hex } from '../digest.js';
import type { EvidenceAdapter } from '../types.js';

/** A full commit hash: 40 hexadecimal digits (SHA-1) or 64 (SHA-256), in lower case as Git prints them. */
const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** Orders two strings by their UTF-16 code units; 0 when they are equal. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** True for a reason with more than white space in it. */
const stated = (reason: unknown): reason is string => typeof reason === 'string' && reason.trim() !== '';

/** `Array.isArray` for a list that is only read; unlike `Array.isArray`, it keeps the list's item type. */
const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

/** What a selector reads. */
export type SelectorKind = 'route' | 'contract' | 'table' | 'field' | 'path' | 'source' | 'ui' | 'asset';

/** One selector: a regular expression over a target's lines, with the `u` flag. */
export interface Selector {
  kind: SelectorKind;
  pattern: string;
}

/** A pattern whose lines are foundations, not the capability, and why. */
export interface Foundation {
  pattern: string;
  reason: string;
}

/** A negative probe and the statuses that mean "not here". */
export interface ProbeSpec {
  method: 'GET' | 'POST';
  path: string;
  expect: readonly number[];
}

/** A probe's answer; `status` is null when nothing answered. */
export interface ProbeResult {
  method: 'GET' | 'POST';
  path: string;
  status: number | null;
}

/** One claim's tripwire. */
export interface TripwireInput {
  claimId: string;
  selectors: readonly Selector[];
  foundations: readonly Foundation[];
  /** Path prefixes searched. */
  scope: readonly string[];
  probes: readonly ProbeSpec[];
  /** Why the claim has no database or route to search, when it has none; an empty manifest needs it, and a blank one counts as none. */
  noDatabaseReason: string | null;
}

/** One file to search. */
export interface ScanTarget {
  path: string;
  text: string;
  /** What the file is; only selectors of the same kind read it. */
  kind: SelectorKind;
}

/** One match. */
export interface AbsenceMatch {
  path: string;
  /** The line, counted from 1. */
  line: number;
  selector: Selector;
  /** The matching line, trimmed, at most 200 characters. */
  excerpt: string;
  classification: 'foundation' | 'capability';
  /** The foundation's reason; null for a capability match. */
  reason: string | null;
}

/** The record bound to one claim id. */
export interface AbsenceRecord {
  claimId: string;
  /** The full hash of the commit searched. */
  commit: string;
  /** Every target inside the scope, with the SHA-256 of its text, ordered by path, then kind, then digest, whatever order the targets came in. */
  manifest: readonly { path: string; sha256: string }[];
  /** `digestOf(manifest)`. */
  manifestDigest: string;
  /** The tripwire's reason for having no database or route to search, as it gave it; null when it gave none. */
  noDatabaseReason: string | null;
  /** Each selector as `kind:pattern`. */
  terms: readonly string[];
  matches: readonly AbsenceMatch[];
  /** The probes that answered, each once. */
  probes: readonly ProbeResult[];
  verdict: 'absent' | 'tripped' | 'invalid';
  /** Why the record is invalid; empty otherwise. */
  problems: readonly string[];
}

/**
 * Searches the scoped targets and probes for a claim's capability.
 *
 * @param input - The tripwire.
 * @param commit - The full hash of the commit searched (40 or 64 lower-case hexadecimal digits); anything else makes the record invalid.
 * @param targets - Every candidate file, with what it is.
 * @param probes - The probes' answers, one for each probe; a probe answered more than once makes the record invalid.
 */
export function buildAbsenceRecord(input: TripwireInput, commit: string, targets: readonly ScanTarget[], probes: readonly ProbeResult[]): AbsenceRecord {
  const problems: string[] = [];
  if (!FULL_COMMIT.test(commit)) problems.push('the searched commit is not a full commit hash');
  if (input.selectors.length === 0) problems.push('the tripwire names no selector');
  // A total order (path, then kind, then digest), so the manifest and its digest do not depend on the order the targets
  // arrive in, even when one file is read as two kinds.
  const scoped = targets
    .filter((t) => input.scope.some((prefix) => t.path.startsWith(prefix)))
    .map((t) => ({ ...t, sha256: sha256Hex(t.text) }))
    .sort((a, b) => compareText(a.path, b.path) || compareText(a.kind, b.kind) || compareText(a.sha256, b.sha256));
  if (scoped.length === 0 && !stated(input.noDatabaseReason)) problems.push('the scoped manifest is empty and no reason says why');
  const foundations = input.foundations.map((f) => ({ re: new RegExp(f.pattern, 'u'), reason: f.reason }));
  const matches: AbsenceMatch[] = [];
  for (const selector of input.selectors) {
    const re = new RegExp(selector.pattern, 'u');
    for (const target of scoped) {
      if (target.kind !== selector.kind) continue;
      target.text.split('\n').forEach((line, index) => {
        if (!re.test(line)) return;
        const foundation = foundations.find((f) => f.re.test(line));
        matches.push({ path: target.path, line: index + 1, selector, excerpt: line.trim().slice(0, 200), classification: foundation === undefined ? 'capability' : 'foundation', reason: foundation?.reason ?? null });
      });
    }
  }
  const answered: ProbeResult[] = [];
  for (const spec of input.probes) {
    // Two answers to one probe leave no way to tell which one the app gave, so neither is recorded.
    const results = probes.filter((p) => p.method === spec.method && p.path === spec.path);
    if (results.length > 1) problems.push(`the probe ${spec.method} ${spec.path} was answered more than once`);
    else if (results.length === 0 || results[0].status === null) problems.push(`the probe ${spec.method} ${spec.path} reached nothing`);
    else answered.push(results[0]);
  }
  const manifest = scoped.map((t) => ({ path: t.path, sha256: t.sha256 }));
  const trippedByProbe = answered.some((r) => !(input.probes.find((p) => p.method === r.method && p.path === r.path)?.expect ?? []).includes(r.status as number));
  const verdict = problems.length > 0 ? 'invalid' : matches.some((m) => m.classification === 'capability') || trippedByProbe ? 'tripped' : 'absent';
  return {
    claimId: input.claimId,
    commit,
    manifest,
    manifestDigest: digestOf(manifest),
    noDatabaseReason: input.noDatabaseReason,
    terms: input.selectors.map((s) => `${s.kind}:${s.pattern}`),
    matches,
    probes: answered,
    verdict,
    problems,
  };
}

/**
 * Why an `absent` record with no problems still cannot authorize its claim, or null when it holds up. The record is the
 * JSON a caller kept, so each part its verdict rests on is read again rather than trusted: the full hash of the commit
 * searched, at least one search term, a manifest that matches its digest and, when the manifest is empty, a stated
 * reason, no match that is not a foundation, and a status from every probe it lists.
 *
 * @param payload - The record as the evidence holds it.
 */
function absentRecordFault(payload: Partial<AbsenceRecord>): string | null {
  const { commit, manifest, manifestDigest, noDatabaseReason, terms, matches, probes, problems } = payload;
  if (!isList(manifest) || !isList(terms) || !isList(matches) || !isList(probes) || !isList(problems)) return 'the record lacks its manifest, terms, matches, probes or problems';
  if (typeof commit !== 'string' || !FULL_COMMIT.test(commit)) return 'the record names no full commit hash';
  if (terms.length === 0) return 'the record names no search term';
  if (manifestDigest !== digestOf(manifest)) return 'the manifest does not match its digest';
  if (manifest.length === 0 && !stated(noDatabaseReason)) return 'the manifest is empty and no reason says why';
  // An item of a kept list can be any JSON value, null included, so each one is read with care.
  if (matches.some((m) => m?.classification !== 'foundation')) return 'the record holds a match that is not a foundation';
  if (probes.some((p) => typeof p?.status !== 'number')) return 'the record holds a probe that did not answer';
  return null;
}

/**
 * The adapter for `absence` evidence: `supported` for an `absent` record of the claim that holds up when it is read
 * again, `contradicted` when tripped, `unverifiable` when invalid or when an `absent` record lacks what its verdict
 * rests on.
 */
export function absenceAdapter(): EvidenceAdapter {
  return {
    kind: 'absence',
    check: async (record, claim) => {
      const payload = record.payload as Partial<AbsenceRecord>;
      if (payload.claimId !== claim.claimId) return { verdict: 'unverifiable', basis: 'deterministic', detail: 'the record is bound to another claim' };
      if (payload.verdict === 'absent' && (payload.problems ?? []).length === 0) {
        const fault = absentRecordFault(payload);
        if (fault !== null) return { verdict: 'unverifiable', basis: 'deterministic', detail: fault };
        return { verdict: 'supported', basis: 'deterministic', detail: `absent at ${payload.commit ?? ''}` };
      }
      if (payload.verdict === 'tripped') return { verdict: 'contradicted', basis: 'deterministic', detail: `${(payload.matches ?? []).filter((m) => m.classification === 'capability').length} capability matches` };
      return { verdict: 'unverifiable', basis: 'deterministic', detail: (payload.problems ?? ['an invalid record']).join('; ') };
    },
  };
}

/** One item of a route, contract, schema or interface inventory. */
export interface InventoryItem {
  kind: 'route' | 'contract' | 'table' | 'field' | 'ui' | 'path' | 'source';
  id: string;
}

/**
 * What the current inventory adds that the committed, classified one does not hold, and what it lost. A committed item
 * whose classification is blank counts as unclassified.
 *
 * @param committed - The classified inventory.
 * @param current - The inventory read from the candidate.
 */
export function inventoryDiff(committed: readonly (InventoryItem & { classification: string })[], current: readonly InventoryItem[]): { unclassified: InventoryItem[]; removed: InventoryItem[] } {
  const key = (item: InventoryItem): string => `${item.kind}\u0000${item.id}`;
  const known = new Set(committed.filter((item) => stated(item.classification)).map(key));
  const now = new Set(current.map(key));
  return {
    unclassified: current.filter((item) => !known.has(key(item))).map(({ kind, id }) => ({ kind, id })),
    removed: committed.filter((item) => !now.has(key(item))).map(({ kind, id }) => ({ kind, id })),
  };
}
