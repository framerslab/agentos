/**
 * @fileoverview Supplied candidates of `retrieval: 'hybrid'`: the facts a caller adds to a call's recall pool (account
 * facts, attachments), sorted into the ones the pool takes and the ones it refuses, which are counted and never named.
 *
 * @module agentos/cognition/memory/retrieval/recall/supplied
 */
import type { CognitiveRetrievalOptions, ScoredMemoryTrace } from '../../core/types.js';

/** A supplied candidate the pool takes, as a trace line, with the caller's score when it gave one. */
export interface AdmittedSupplied {
  trace: ScoredMemoryTrace;
  /** The caller's own score, on its own scale; undefined when it gave none. */
  score: number | undefined;
  /** True when the caller gave no `createdAt`: the line reads as written now, and the dedupe compares no time. */
  undated: boolean;
}

/** What {@link admitSupplied} kept and how many it refused for each reason. */
export interface SuppliedOutcome {
  kept: AdmittedSupplied[];
  /** Candidates outside the call's scopes, every one on a call with no scopes among them. */
  outOfScope: number;
  /**
   * Candidates in scope that cannot be shown: on a call that sets `types`, `minConfidence` or `usableFor` (a supplied
   * candidate carries no type, confidence or trust policy), with a blank id or text, an id given twice, or a
   * `createdAt` before `timeRange.after`.
   */
  ineligible: number;
}

/**
 * Sorts a call's supplied candidates into kept and refused. The scope is checked first, against the call's `scopes` as
 * passed (`scope` and `scopeId` both): a candidate outside them is never rendered and its id is never recorded, only
 * counted. A kept candidate becomes a semantic trace of its scope, with source `external`, written nowhere.
 *
 * @param options - The call's retrieval options; `supplied` is read.
 * @param now - The call's clock, the time of a candidate with no `createdAt`.
 */
export function admitSupplied(options: CognitiveRetrievalOptions, now: number): SuppliedOutcome {
  const out: SuppliedOutcome = { kept: [], outOfScope: 0, ineligible: 0 };
  const scopes = options.scopes ?? [];
  const usableFor = options.usableFor;
  const asksWhatNoneCanShow =
    Boolean(options.types?.length) ||
    options.minConfidence != null ||
    (usableFor !== undefined && (!Array.isArray(usableFor) || usableFor.length > 0));
  const after = options.timeRange?.after;
  const seen = new Set<string>();
  for (const candidate of Array.isArray(options.supplied) ? options.supplied : []) {
    const scope = candidate && typeof candidate === 'object' ? candidate.scope : undefined;
    if (!scope || !scopes.some((s) => s.scope === scope.scope && s.scopeId === scope.scopeId)) {
      out.outOfScope += 1;
      continue;
    }
    const id = typeof candidate.id === 'string' ? candidate.id : '';
    const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';
    const dated = typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt);
    const createdAt = dated ? (candidate.createdAt as number) : now;
    if (asksWhatNoneCanShow || !id.trim() || !text || seen.has(id) || (after != null && createdAt < after)) {
      out.ineligible += 1;
      continue;
    }
    seen.add(id);
    const score = typeof candidate.score === 'number' && Number.isFinite(candidate.score) ? candidate.score : undefined;
    out.kept.push({
      score,
      undated: !dated,
      trace: {
        id,
        type: 'semantic',
        scope: scope.scope,
        scopeId: scope.scopeId,
        content: text,
        entities: [],
        tags: [],
        provenance: { sourceType: 'external', sourceTimestamp: createdAt, confidence: 1, verificationCount: 0 },
        emotionalContext: { valence: 0, arousal: 0, dominance: 0, intensity: 0, gmiMood: '' },
        encodingStrength: 0.5,
        stability: 0.5,
        retrievalCount: 0,
        lastAccessedAt: createdAt,
        accessCount: 0,
        reinforcementInterval: 0,
        associatedTraceIds: [],
        createdAt,
        updatedAt: createdAt,
        isActive: true,
        retrievalScore: Math.max(0, Math.min(1, score ?? 0)),
        scoreBreakdown: {
          strengthScore: 0,
          similarityScore: 0,
          recencyScore: 0,
          emotionalCongruenceScore: 0,
          graphActivationScore: 0,
          importanceScore: 0,
        },
      },
    });
  }
  return out;
}
