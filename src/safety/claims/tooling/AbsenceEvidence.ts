/**
 * @module safety/claims/tooling/AbsenceEvidence
 *
 * Evidence that a capability does not exist. A tripwire names selectors (route, contract, table and field patterns,
 * source, interface and asset patterns), foundations a match may be (with the reason), the paths searched and the
 * negative probes; `buildAbsenceRecord` searches every target inside the scope, classifies each match, records the
 * scoped manifest with its digest and the probes' answers, and reaches one verdict: `absent`, `tripped` or `invalid`.
 * A record with no selectors, an empty manifest without a stated reason, or a probe that reached nothing is invalid:
 * a failed request or a missing keyword is never evidence of absence. `inventoryDiff` refuses an addition to the
 * route, contract, schema or interface inventory that nobody classified, so a rename cannot evade a selector.
 */
import { digestOf, sha256Hex } from '../digest.js';
import type { EvidenceAdapter } from '../types.js';

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
  /** Why the claim has no database or route to search, when it has none; an empty manifest needs it. */
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
  commit: string;
  /** Every target inside the scope, in path order, with the SHA-256 of its text. */
  manifest: readonly { path: string; sha256: string }[];
  /** `digestOf(manifest)`. */
  manifestDigest: string;
  /** Each selector as `kind:pattern`. */
  terms: readonly string[];
  matches: readonly AbsenceMatch[];
  /** The probes that answered. */
  probes: readonly ProbeResult[];
  verdict: 'absent' | 'tripped' | 'invalid';
  /** Why the record is invalid; empty otherwise. */
  problems: readonly string[];
}

/**
 * Searches the scoped targets and probes for a claim's capability.
 *
 * @param input - The tripwire.
 * @param commit - The commit searched.
 * @param targets - Every candidate file, with what it is.
 * @param probes - The probes' answers.
 */
export function buildAbsenceRecord(input: TripwireInput, commit: string, targets: readonly ScanTarget[], probes: readonly ProbeResult[]): AbsenceRecord {
  const problems: string[] = [];
  if (input.selectors.length === 0) problems.push('the tripwire names no selector');
  const scoped = targets.filter((t) => input.scope.some((prefix) => t.path.startsWith(prefix))).sort((a, b) => (a.path < b.path ? -1 : 1));
  if (scoped.length === 0 && input.noDatabaseReason === null) problems.push('the scoped manifest is empty and no reason says why');
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
    const result = probes.find((p) => p.method === spec.method && p.path === spec.path);
    if (result === undefined || result.status === null) {
      problems.push(`the probe ${spec.method} ${spec.path} reached nothing`);
      continue;
    }
    answered.push(result);
  }
  const manifest = scoped.map((t) => ({ path: t.path, sha256: sha256Hex(t.text) }));
  const trippedByProbe = answered.some((r) => !(input.probes.find((p) => p.method === r.method && p.path === r.path)?.expect ?? []).includes(r.status as number));
  const verdict = problems.length > 0 ? 'invalid' : matches.some((m) => m.classification === 'capability') || trippedByProbe ? 'tripped' : 'absent';
  return {
    claimId: input.claimId,
    commit,
    manifest,
    manifestDigest: digestOf(manifest),
    terms: input.selectors.map((s) => `${s.kind}:${s.pattern}`),
    matches,
    probes: answered,
    verdict,
    problems,
  };
}

/** The adapter for `absence` evidence: `supported` for an `absent` record of the claim, `contradicted` when tripped, `unverifiable` when invalid. */
export function absenceAdapter(): EvidenceAdapter {
  return {
    kind: 'absence',
    check: async (record, claim) => {
      const payload = record.payload as Partial<AbsenceRecord>;
      if (payload.claimId !== claim.claimId) return { verdict: 'unverifiable', basis: 'deterministic', detail: 'the record is bound to another claim' };
      if (payload.verdict === 'absent' && (payload.problems ?? []).length === 0) return { verdict: 'supported', basis: 'deterministic', detail: `absent at ${payload.commit ?? ''}` };
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
 * What the current inventory adds that the committed, classified one does not hold, and what it lost.
 *
 * @param committed - The classified inventory.
 * @param current - The inventory read from the candidate.
 */
export function inventoryDiff(committed: readonly (InventoryItem & { classification: string })[], current: readonly InventoryItem[]): { unclassified: InventoryItem[]; removed: InventoryItem[] } {
  const key = (item: InventoryItem): string => `${item.kind}\u0000${item.id}`;
  const known = new Set(committed.map(key));
  const now = new Set(current.map(key));
  return {
    unclassified: current.filter((item) => !known.has(key(item))).map(({ kind, id }) => ({ kind, id })),
    removed: committed.filter((item) => !now.has(key(item))).map(({ kind, id }) => ({ kind, id })),
  };
}
