/**
 * @module voice-pipeline/TranscriptDedupe
 *
 * Duplicate-transcript detector used by StreamingSTTChain after a mid-
 * utterance failover. The backup provider replays the ring buffer and
 * re-transcribes audio the primary already saw; without dedupe the session
 * sees "hello world" twice.
 *
 * Dedupe signal: audio-clock overlap (primary fact) + fuzzy string match
 * (tie-breaker). Two transcripts overlap if their [audioStartMs, audioEndMs]
 * ranges intersect; when they do, we compare normalized text.
 *
 * Same-provider observations are never considered duplicates — interim
 * transcripts from a single streaming provider are part of its protocol.
 */

export interface TranscriptObservation {
  provider: string;
  text: string;
  audioStartMs: number;
  audioEndMs: number;
  isFinal: boolean;
}

export interface DedupeResult {
  isDuplicate: boolean;
  reason?: 'exact' | 'fuzzy' | 'superset';
  against?: { provider: string; text: string };
}

const PUNCT_RE = /[.,!?;:"'()[\]{}]/g;
const WS_RE = /\s+/g;

/**
 * A transcript's text as it is compared: in lower case, with the marks `. , ! ? ; : " ' ( ) [ ] { }` removed, every
 * run of white space made one space, and no space at either end. `'Hello, World!  Again.'` becomes
 * `'hello world again'`. Every other character is kept, a hyphen among them.
 *
 * {@link TranscriptDedupe} compares two providers' transcripts by it; a caller that joins texts of its own can
 * compare their words by the same rule.
 *
 * @param text - The text as a provider returned it.
 * @returns The text to compare.
 */
export function normalizeTranscriptText(text: string): string {
  return text.toLowerCase().replace(PUNCT_RE, '').replace(WS_RE, ' ').trim();
}

const normalize = normalizeTranscriptText;

function tokenSet(text: string): Set<string> {
  return new Set(normalize(text).split(' ').filter(Boolean));
}

function tokenSetSimilarity(a: string, b: string): number {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersect = 0;
  for (const t of ta) if (tb.has(t)) intersect++;
  return intersect / Math.max(ta.size, tb.size);
}

function rangesOverlap(a: TranscriptObservation, b: TranscriptObservation): boolean {
  return a.audioStartMs < b.audioEndMs && b.audioStartMs < a.audioEndMs;
}

export class TranscriptDedupe {
  private recent: TranscriptObservation[] = [];
  private readonly fuzzyThreshold: number;
  private readonly retainMs: number;

  constructor(opts: { fuzzyThreshold?: number; retainMs?: number } = {}) {
    this.fuzzyThreshold = opts.fuzzyThreshold ?? 0.85;
    this.retainMs = opts.retainMs ?? 10_000;
  }

  evaluate(obs: TranscriptObservation): DedupeResult {
    this.prune(obs.audioEndMs);

    for (const prev of this.recent) {
      if (prev.provider === obs.provider) continue;
      if (!rangesOverlap(prev, obs)) continue;

      const na = normalize(prev.text);
      const nb = normalize(obs.text);

      if (na === nb) {
        this.recent.push(obs);
        return {
          isDuplicate: true,
          reason: 'exact',
          against: { provider: prev.provider, text: prev.text },
        };
      }

      // Longer transcript subsumes shorter one (primary saw more audio by
      // the time backup caught up — suppress the backup's shorter view).
      if (na.includes(nb) || nb.includes(na)) {
        if (na.length >= nb.length) {
          this.recent.push(obs);
          return {
            isDuplicate: true,
            reason: 'superset',
            against: { provider: prev.provider, text: prev.text },
          };
        }
      }

      const sim = tokenSetSimilarity(prev.text, obs.text);
      if (sim >= this.fuzzyThreshold) {
        this.recent.push(obs);
        return {
          isDuplicate: true,
          reason: 'fuzzy',
          against: { provider: prev.provider, text: prev.text },
        };
      }
    }

    this.recent.push(obs);
    return { isDuplicate: false };
  }

  reset(): void {
    this.recent = [];
  }

  private prune(upToMs: number): void {
    const cutoff = upToMs - this.retainMs;
    this.recent = this.recent.filter((o) => o.audioEndMs >= cutoff);
  }
}
