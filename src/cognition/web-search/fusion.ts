/**
 * @module web-search/fusion
 *
 * URL normalization and Reciprocal Rank Fusion (RRF) scoring.
 * Pure functions, no IO.
 */
import type { RRFCandidate } from './types';

/** Default RRF constant — prevents top-ranked results from dominating. */
const DEFAULT_K = 60;

/** A query parameter that tracks the click rather than naming the page: `utm_*`, `ref`, `source`, `fbclid`, `gclid`. */
const TRACKING_PARAMETER = /^(?:utm_\w+|ref|source|fbclid|gclid)=/;

/**
 * A URL in the form dedup compares: without its `http://` or `https://`, a leading `www.`, the slashes its path ends
 * with and its tracking parameters. The query parameters that stay keep their order behind one `?`, and a fragment
 * stays: `https://www.example.com/a/?utm_source=x&id=5#top` is `example.com/a?id=5#top`.
 */
export function normalizeUrl(url: string): string {
  const address = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const hashAt = address.indexOf('#');
  const fragment = hashAt === -1 ? '' : address.slice(hashAt);
  const beforeFragment = hashAt === -1 ? address : address.slice(0, hashAt);
  const queryAt = beforeFragment.indexOf('?');
  const path = (queryAt === -1 ? beforeFragment : beforeFragment.slice(0, queryAt)).replace(/\/+$/, '');
  const kept =
    queryAt === -1
      ? []
      : beforeFragment
          .slice(queryAt + 1)
          .split('&')
          .filter((parameter) => parameter !== '' && !TRACKING_PARAMETER.test(parameter));
  return `${path}${kept.length > 0 ? `?${kept.join('&')}` : ''}${fragment}`;
}

/**
 * Compute RRF scores for candidates.
 *
 * Formula: score(d) = Σ 1 / (k + rank_in_provider), over the providers that returned d, with no provider weight
 * ({@link computeWeightedRRF} applies one). Results appearing in multiple providers get naturally boosted.
 *
 * @param candidates - Candidates with providerRanks populated
 * @param k - RRF constant (default 60)
 * @returns Same candidates with rrfScore computed, sorted descending
 */
export function computeRRF(candidates: RRFCandidate[], k: number = DEFAULT_K): RRFCandidate[] {
  for (const candidate of candidates) {
    let score = 0;
    for (const [, rank] of candidate.providerRanks) {
      score += 1 / (k + rank);
    }
    candidate.rrfScore = score;
  }

  return candidates.sort((a, b) => b.rrfScore - a.rrfScore);
}

/**
 * Compute weighted RRF scores using per-provider weights.
 *
 * @param candidates - Candidates with providerRanks populated
 * @param weights - Provider ID → weight multiplier map; a provider without one weighs 1
 * @param k - RRF constant (default 60)
 */
export function computeWeightedRRF(
  candidates: RRFCandidate[],
  weights: Record<string, number>,
  k: number = DEFAULT_K
): RRFCandidate[] {
  for (const candidate of candidates) {
    let score = 0;
    for (const [provider, rank] of candidate.providerRanks) {
      score += (weights[provider] ?? 1.0) / (k + rank);
    }
    candidate.rrfScore = score;
  }

  return candidates.sort((a, b) => b.rrfScore - a.rrfScore);
}
