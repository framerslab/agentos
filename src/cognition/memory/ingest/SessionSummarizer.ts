/**
 * @file SessionSummarizer.ts
 * @description Session-level contextual retrieval (Anthropic Sep 2024
 * variant, adapted to conversational memory).
 *
 * ## What this does
 *
 * For each session in a benchmark case (e.g. a `conv-26` chat thread in
 * LOCOMO or a `haystack_sessions[i]` entry in LongMemEval), an LLM
 * generates a dense 50–100 token summary that captures the topic,
 * key user-stated facts (names, numbers, dates, preferences), and key
 * assistant-stated facts. That summary is then prepended to *every*
 * chunk produced from that session before embedding — giving the
 * embedding vector global session context it would otherwise lack.
 *
 * ## Why session-granularity (not per-chunk)
 *
 * Anthropic's canonical
 * {@link https://www.anthropic.com/news/contextual-retrieval Contextual Retrieval}
 * prepends context *per chunk*. That's right for heterogeneous documents
 * where each chunk might cover a different topic. Conversational data is
 * different: a session is a topically-coherent thread. Adjacent chunks in
 * the same session share context, so per-chunk contextualization would
 * fire ~10× as many LLM calls at the *same* summarization model for the
 * same downstream embedding benefit — this is a same-model
 * granularity comparison, not a cross-reader pricing claim.
 *
 * The closest industry analog is Mastra Observational Memory's Observer
 * phase (rewrites full messages into dense observations). Ours is a
 * lighter variant — we *prepend* a summary to preserve the original
 * chunk text verbatim, rather than rewriting it.
 *
 * ## Caching
 *
 * Summaries are cached to disk under `<cacheDir>/<sha256-hex>.txt`. The
 * cache key hashes the session text, model id, and template version so
 * any of those three changing invalidates the cache cleanly. Mirrors
 * the {@link CachedEmbedder} pattern for consistency.
 *
 * ## Cost
 *
 * Single LLM call per unique session. For LongMemEval-S (~50 sessions
 * per case × 500 cases) with gpt-5-mini / Haiku pricing:
 *   ~25,000 calls × 50–100 output tokens × 2,000 input tokens (session)
 *   ≈ $50–90 one-time across all cases. Cached thereafter.
 *
 * ## Expected lift
 *
 * Anthropic's published numbers: −49% retrieval failure with contextual
 * embeddings alone, −67% when combined with reranking. We already have
 * Cohere rerank-v3.5 wired, so the upper bound applies. Our Phase A
 * multi-session ceiling of 50% is the main target; expected lift
 * +8–15pp on multi-session categories across LongMemEval and LOCOMO.
 *
 * @module agentos-bench/cognitive/SessionSummarizer
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * Callable that invokes a chat LLM given a system + user prompt and
 * returns the generated text. The bench constructs one from the
 * existing {@link IReader} so summarization reuses the same pricing +
 * timeout plumbing as the benchmark's reader.
 */
export type SessionSummarizerInvoker = (
  system: string,
  user: string,
) => Promise<{
  text: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
}>;

/**
 * Options for constructing a {@link SessionSummarizer}.
 */
export interface SessionSummarizerOptions {
  /** LLM invoker — produces the summary text. */
  invoker: SessionSummarizerInvoker;
  /**
   * Optional directory for persistent disk cache. When set, summaries
   * survive across process restarts and re-runs. Mirrors the
   * {@link CachedEmbedder} cache layout.
   */
  cacheDir?: string;
  /**
   * Model identifier baked into the cache key so switching models
   * invalidates the cache automatically. Should match the invoker's
   * underlying model.
   */
  modelId: string;
  /**
   * Maximum tokens to ask the LLM to emit. Default 140 (generous headroom
   * over the 50–100 target; truncate post-hoc if needed).
   */
  maxTokens?: number;
  /**
   * Template version. Bump whenever the summarization prompt changes so
   * disk caches from prior versions are invalidated.
   * Current: `'v1-2026-04-19'`.
   */
  templateVersion?: string;
  /** Optional cost-tracker hook. Called after every uncached call. */
  onCallCost?: (tokensIn: number, tokensOut: number, model: string) => void;
}

/**
 * Summary cache stats for diagnostics / budget tracking.
 */
export interface SummarizerStats {
  hits: number;
  misses: number;
  writes: number;
  /** Total tokens consumed on uncached LLM calls. */
  tokensIn: number;
  tokensOut: number;
}

/** Default summarization prompt — see file docstring for rationale. */
const DEFAULT_SYSTEM_PROMPT = [
  'You produce a concise search-retrieval summary of a conversation session.',
  'Your output will be prepended to individual turn-level chunks before vector embedding, so the embedding captures the session-wide context each chunk alone would miss.',
  'Target length: 50–100 tokens. No preamble, no sign-off — emit only the summary.',
  'Structure the summary as dense prose:',
  '  1. The topic or theme of the session (one short clause).',
  '  2. The specific facts the user stated — names, numbers, dates, preferences, decisions, named items (e.g. "Wells Fargo mortgage", "turbinado sugar", "mid-century dresser").',
  '  3. The specific facts the assistant stated, suggested, or provided (numbers, recommendations, named entities).',
  'Be concrete. Use exact nouns and numbers from the conversation. Do not generalize. Do not editorialize.',
].join(' ');

const DEFAULT_TEMPLATE_VERSION = 'v1-2026-04-19';

/**
 * LLM-backed session summarizer with a persistent on-disk cache.
 *
 * @example
 * ```ts
 * const summarizer = new SessionSummarizer({
 *   invoker: async (system, user) => {
 *     const resp = await reader.invoke({ system, user, maxTokens: 140, temperature: 0 });
 *     return { text: resp.text, tokensIn: resp.tokensIn, tokensOut: resp.tokensOut, model: resp.model };
 *   },
 *   cacheDir: '/path/to/data/.session-summary-cache',
 *   modelId: 'gpt-5-mini',
 * });
 *
 * const summary = await summarizer.summarize('conv-26-session-3', sessionText);
 * // => "User discussed adopting a new rescue dog from a Portland shelter..."
 * ```
 */
export class SessionSummarizer {
  /** Running stats for diagnostics. */
  readonly stats: SummarizerStats = {
    hits: 0,
    misses: 0,
    writes: 0,
    tokensIn: 0,
    tokensOut: 0,
  };

  private readonly systemPrompt: string;
  private readonly templateVersion: string;
  private readonly maxTokens: number;

  constructor(private readonly opts: SessionSummarizerOptions) {
    this.systemPrompt = DEFAULT_SYSTEM_PROMPT;
    this.templateVersion = opts.templateVersion ?? DEFAULT_TEMPLATE_VERSION;
    this.maxTokens = opts.maxTokens ?? 140;
  }

  /**
   * Summarize a single session. Returns cached result if available,
   * otherwise calls the LLM and writes to cache.
   *
   * @param _sessionKey — a stable identifier for the session (e.g. `${caseId}:${sessionId}`).
   *                     Used only for logging; the cache key is content-addressed.
   * @param sessionText — the raw text of the session (all turns concatenated).
   */
  async summarize(_sessionKey: string, sessionText: string): Promise<string> {
    const trimmed = sessionText.trim();
    if (!trimmed) return '';

    const cacheKey = this.computeCacheKey(trimmed);

    // Try disk cache
    if (this.opts.cacheDir) {
      const cachePath = path.join(this.opts.cacheDir, `${cacheKey}.txt`);
      try {
        const cached = await fs.readFile(cachePath, 'utf8');
        this.stats.hits += 1;
        return cached;
      } catch {
        // File doesn't exist or can't be read — fall through to LLM call.
      }
    }

    this.stats.misses += 1;
    const response = await this.opts.invoker(this.systemPrompt, trimmed);
    const summary = response.text.trim();
    this.stats.tokensIn += response.tokensIn;
    this.stats.tokensOut += response.tokensOut;

    if (this.opts.onCallCost) {
      this.opts.onCallCost(response.tokensIn, response.tokensOut, response.model);
    }

    // Persist to disk cache (best-effort; exclusive create so concurrent
    // writers don't tear). Non-fatal on write failure — caller still
    // gets the summary for this call.
    if (this.opts.cacheDir) {
      try {
        await fs.mkdir(this.opts.cacheDir, { recursive: true });
        const cachePath = path.join(this.opts.cacheDir, `${cacheKey}.txt`);
        await fs.writeFile(cachePath, summary, { encoding: 'utf8', flag: 'wx' });
        this.stats.writes += 1;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        // EEXIST means another writer got there first — their content is
        // valid. Any other error is logged but non-fatal.
        if (code !== 'EEXIST') {
          // eslint-disable-next-line no-console
          console.warn(
            `[SessionSummarizer] Failed to write cache for key ${cacheKey.slice(0, 8)}...: ${String(err)}`,
          );
        }
      }
    }

    return summary;
  }

  /**
   * Build the SHA-256 cache key from session content + model + template.
   * Exposed for tests; callers should use {@link summarize}.
   */
  computeCacheKey(sessionText: string): string {
    return createHash('sha256')
      .update(this.opts.modelId)
      .update('\n')
      .update(this.templateVersion)
      .update('\n')
      .update(sessionText)
      .digest('hex');
  }

  /** Expose the resolved template version — useful for cache-key fingerprints in other layers. */
  getTemplateVersion(): string {
    return this.templateVersion;
  }
}
