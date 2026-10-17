/**
 * @module web-search/dedup
 *
 * Semantic deduplication for web search results.
 * Uses the cosine of term-frequency vectors (no inverse document frequency) to detect near-duplicates across
 * providers.
 * Pure functions, no IO.
 */
import { cosineSimilarity } from '../rag/citation/cosine';
import type { RRFCandidate } from './types';
import { normalizeUrl } from './fusion';

/** Build vocabulary index from all texts. */
export function buildVocabulary(texts: string[]): Map<string, number> {
  const vocab = new Map<string, number>();
  for (const text of texts) {
    for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      if (!vocab.has(word)) vocab.set(word, vocab.size);
    }
  }
  return vocab;
}

/** Build a TF vector normalized by document length. */
export function buildTfVector(text: string, vocabulary: Map<string, number>): number[] {
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  const vec = new Array(vocabulary.size).fill(0);
  for (const w of words) {
    const idx = vocabulary.get(w);
    if (idx !== undefined) vec[idx]++;
  }
  const len = words.length || 1;
  return vec.map((v) => v / len);
}

/**
 * Merge a source candidate into a target candidate: the target gains the providers only the source holds, with
 * their ranks, the source's content when it has none, and the higher relevanceScore.
 */
function mergeCandidates(target: RRFCandidate, source: RRFCandidate): void {
  for (const [prov, rank] of source.providerRanks) {
    if (!target.providerRanks.has(prov)) {
      target.providerRanks.set(prov, rank);
      target.providerSources.push(prov);
    }
  }
  if (source.content && !target.content) {
    target.content = source.content;
  }
  if (
    source.relevanceScore &&
    (!target.relevanceScore || source.relevanceScore > target.relevanceScore)
  ) {
    target.relevanceScore = source.relevanceScore;
  }
}

/**
 * Semantic dedup: merge near-duplicate results across providers.
 *
 * Two-pass:
 * 1. URL normalization merge (exact match after {@link normalizeUrl}: scheme, `www.`, trailing slashes and tracking
 *    parameters dropped)
 * 2. Cosine similarity of the snippets' term-frequency vectors, each count divided by the snippet's word count
 *    (catches same article at different URLs)
 *
 * The first candidate of each group stays and gains the providers only later ones hold, with their ranks. It takes
 * a later candidate's content when it has none, and the higher relevanceScore.
 *
 * @param candidates - Raw candidates from all providers
 * @param threshold - Cosine similarity threshold for dedup (default 0.85)
 */
export function semanticDedup(
  candidates: RRFCandidate[],
  threshold: number = 0.85
): RRFCandidate[] {
  if (candidates.length <= 1) return candidates;

  // Pass 1: merge by normalized URL
  const urlMap = new Map<string, RRFCandidate>();
  for (const c of candidates) {
    const normUrl = c.normalizedUrl || normalizeUrl(c.url);
    const existing = urlMap.get(normUrl);
    if (existing) {
      mergeCandidates(existing, c);
    } else {
      urlMap.set(normUrl, { ...c, normalizedUrl: normUrl });
    }
  }

  const urlDeduped = Array.from(urlMap.values());
  if (urlDeduped.length <= 1) return urlDeduped;

  // Pass 2: semantic similarity on snippets
  const snippets = urlDeduped.map((c) => c.snippet);
  const vocab = buildVocabulary(snippets);
  if (vocab.size === 0) return urlDeduped;

  const vectors = snippets.map((s) => buildTfVector(s, vocab));
  const merged = new Set<number>();
  const result: RRFCandidate[] = [];

  for (let i = 0; i < urlDeduped.length; i++) {
    if (merged.has(i)) continue;
    const current = urlDeduped[i];

    for (let j = i + 1; j < urlDeduped.length; j++) {
      if (merged.has(j)) continue;
      const sim = cosineSimilarity(vectors[i], vectors[j]);
      if (sim >= threshold) {
        mergeCandidates(current, urlDeduped[j]);
        merged.add(j);
      }
    }

    result.push(current);
  }

  return result;
}
