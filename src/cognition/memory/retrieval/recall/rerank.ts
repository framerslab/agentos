/**
 * @fileoverview Memory recall's reranker: the one provider `recall.rerank` names, with the bounds a turn needs. It
 * loads its model when the manager starts, scores at most `maxCandidates` memories inside `timeoutMs`, and never fails
 * a turn: a load in progress, an unavailable model, a timeout, an error, a substituted score and a back-off each leave
 * the order as it was, with the reason.
 *
 * @module agentos/cognition/memory/retrieval/recall/rerank
 */
import type { IRerankerProvider } from '../../../rag/reranking/IRerankerService.js';
import { RerankerService } from '../../../rag/reranking/RerankerService.js';
import { LlmJudgeReranker } from '../../../rag/reranking/providers/LlmJudgeReranker.js';
import type { MemoryRecallConfig } from '../../core/config.js';
import type { MemoryRecallReranker, RerankSkipReason } from './capture.js';
import { oncePerProcess, recallLog } from './log.js';

/**
 * The memory rerank's bounds and blend. `localTimeoutMs` and `llmTimeoutMs` are the defaults of `timeoutMs` (the judge
 * makes two phases of model calls, so it gets longer); `maxCandidates` is how many memories reach the provider, the
 * recall's best; after `failuresToBackOff` failures or timeouts in a row the rerank is skipped for `backoffMs`; and a
 * reranked candidate's place is `blendScore × its recall score + blendRerank × its rerank score`.
 */
export const RERANK_DEFAULTS = {
  localTimeoutMs: 1500,
  llmTimeoutMs: 10_000,
  maxCandidates: 20,
  failuresToBackOff: 3,
  backoffMs: 60_000,
  blendScore: 0.7,
  blendRerank: 0.3,
} as const;

/** A `recall.rerank` setting that names a provider. */
export type RerankSetting = Exclude<NonNullable<MemoryRecallConfig['rerank']>, 'none'>;

/** What one rerank call answers. */
export interface RerankOutcome {
  /** The provider that scored, with its model, the candidates it was sent and its time; or `none` with the reason. */
  record: MemoryRecallReranker;
  /** The rerank score of each candidate scored, by id; empty when the order stands. */
  scores: Map<string, number>;
}

/** A provider the memory reranker can drive: the local cross-encoder's `initialize` and `dispose` are optional. */
export type RecallRerankProvider = IRerankerProvider & {
  initialize?: (modelId?: string) => Promise<void>;
  dispose?: () => Promise<void>;
};

/** What a {@link RecallReranker} is built over, beside its setting. */
export interface RecallRerankerDeps {
  /** Builds the provider in place of the one the setting names. For tests. */
  createProvider?: () => RecallRerankProvider;
  /** The folder the local model's files are cached in (default: Transformers.js's own cache). */
  cacheDir?: string;
  /** Load the local model from the cache alone, never the network. */
  localFilesOnly?: boolean;
}

/**
 * The LLM judge as memory rerank's provider: one `LlmJudgeReranker` per rerank over the host's `invoke`, scoring every
 * candidate it is sent. The judge makes its model calls one after another; once the rerank's `signal` (the request's
 * `params.signal`) has aborted, `invoke` is not called again, so a rerank the turn stopped waiting for starts no
 * further model call. A call already made runs to its end: `invoke` takes no abort signal.
 */
function judgeProvider(setting: Extract<RerankSetting, { kind: 'llm' }>): RecallRerankProvider {
  return {
    providerId: 'llm-judge',
    isAvailable: async () => typeof setting.invoke === 'function',
    rerank: (input, config) => {
      const signal: unknown = config.params?.signal;
      const stopped = (): boolean => signal instanceof AbortSignal && signal.aborted;
      return new LlmJudgeReranker({
        llmCallFn: (system, user, model) =>
          stopped() ? Promise.reject(new Error('Memory rerank: the turn stopped waiting for this rerank.')) : setting.invoke(system, user, model),
        scoringModel: setting.model,
        rankingModel: setting.model,
        maxPointwiseDocuments: input.documents.length,
        timeoutMs: config.timeoutMs ?? RERANK_DEFAULTS.llmTimeoutMs,
      }).rerank(input, config);
    },
  };
}

/**
 * The local cross-encoder as memory rerank's provider. Its module is imported the first time the reranker asks for it
 * (the load `start()` begins), not when this module loads, so a host that never names `{ kind: 'local' }` does not
 * load it at run time. A bundler still takes that module in, since the specifier is a literal; what keeps
 * Transformers.js out of a host's bundle is the provider loading it by a specifier that is not a literal
 * (`importOptional`). Each call is the provider's own.
 */
function localProvider(setting: Extract<RerankSetting, { kind: 'local' }>, deps: RecallRerankerDeps): RecallRerankProvider {
  let loaded: Promise<RecallRerankProvider> | undefined;
  const provider = (): Promise<RecallRerankProvider> =>
    (loaded ??= import('../../../rag/reranking/providers/LocalCrossEncoderReranker.js').then(
      ({ LocalCrossEncoderReranker }) =>
        new LocalCrossEncoderReranker({
          providerId: 'local',
          defaultModelId: setting.model,
          revision: setting.revision,
          ...(deps.cacheDir ? { cacheDir: deps.cacheDir } : {}),
          ...(deps.localFilesOnly ? { localFilesOnly: true } : {}),
        }),
    ));
  return {
    providerId: 'local',
    isAvailable: async () => (await provider()).isAvailable(),
    initialize: async (modelId) => (await provider()).initialize?.(modelId),
    rerank: async (input, config) => (await provider()).rerank(input, config),
    // Nothing to release when the provider was never loaded.
    dispose: async () => {
      if (loaded) await (await loaded).dispose?.();
    },
  };
}

/** Whether a load failed because Transformers.js is missing or too old to load a model. */
function isMissingDependency(error: unknown): boolean {
  return error instanceof Error && /Transformers\.js is not installed|installed Transformers\.js has no/.test(error.message);
}

/**
 * Memory recall's reranker: one provider, the one `recall.rerank` names, in a `RerankerService` of its own, so no
 * other provider is ever reached.
 *
 * `{ kind: 'local' }` is a cross-encoder run in this process (`LocalCrossEncoderReranker`) at the pinned `revision`:
 * the query and the memories never leave the process. `{ kind: 'llm' }` is the LLM judge (`LlmJudgeReranker`) over
 * the host's `invoke`, which sends the query and the first 200 characters of each candidate to whatever model the
 * host calls.
 *
 * `start()` begins the local model's load; turns before it settles run unreranked (`loading`). A load that fails, or
 * a missing Transformers.js, marks the reranker unavailable for good: no retry and no second download. A call is
 * bounded by `timeoutMs`; one that runs past it is dropped when it arrives, and the judge starts no further model call
 * for it. A provider that put a score in for one it
 * could not compute (`providerMetrics.scoringFailures`, `listwiseFailed`) is read as failed. After
 * {@link RERANK_DEFAULTS}`.failuresToBackOff` failures or timeouts in a row the provider is not called for
 * `backoffMs`. `rerank()` never throws.
 */
export class RecallReranker {
  private readonly kind: 'local' | 'llm';
  private readonly service: RerankerService;
  private readonly provider: RecallRerankProvider;
  private state: 'idle' | 'loading' | 'ready' | 'unavailable' = 'idle';
  private settled: Promise<void> = Promise.resolve();
  private disposed = false;
  private failures = 0;
  private backoffUntil = 0;
  /**
   * The reranks running now: each one's signal, aborted at its deadline or when the reranker is stopped, and what
   * settles it when the reranker is stopped.
   */
  private readonly running = new Map<AbortController, () => void>();

  /**
   * @param setting - The `recall.rerank` setting, already checked (`assertRecallConfig`).
   * @param deps - The local model's cache folder, or a provider to use in the named one's place.
   */
  constructor(
    private readonly setting: RerankSetting,
    deps: RecallRerankerDeps = {},
  ) {
    this.kind = setting.kind;
    this.provider =
      deps.createProvider?.() ??
      (setting.kind === 'local' ? localProvider(setting, deps) : judgeProvider(setting));
    this.service = new RerankerService({
      config: { providers: [{ providerId: this.provider.providerId, defaultModelId: setting.model }], defaultProviderId: this.provider.providerId },
    });
    this.service.registerProvider(this.provider);
  }

  /**
   * Starts the local model's load; the judge has nothing to load and is ready at once. Called when the manager
   * initialises, never inside a turn, and a turn never waits for it. Never throws, and its load never rejects.
   */
  start(): void {
    if (this.state !== 'idle' || this.disposed) return;
    if (this.kind === 'llm') {
      this.state = 'ready';
      return;
    }
    this.state = 'loading';
    const unavailable = (reason: 'missing_dependency' | 'load_failed'): void => {
      if (this.disposed) return;
      this.state = 'unavailable';
      oncePerProcess(`rerank_unavailable:${reason}`, () => recallLog.warn('memory.recall.rerank_unavailable', { provider: 'local', reason }));
    };
    this.settled = (async () => {
      try {
        if (!(await this.provider.isAvailable())) {
          unavailable('missing_dependency');
          return;
        }
        await this.provider.initialize?.(this.setting.model);
        if (this.state === 'loading') this.state = 'ready';
      } catch (error) {
        unavailable(isMissingDependency(error) ? 'missing_dependency' : 'load_failed');
      }
    })();
  }

  /** Resolves when the load has settled, loaded or not. For a deploy step that warms the model, and for tests. */
  ready(): Promise<void> {
    return this.settled;
  }

  /**
   * Stops the reranker: later calls, and the calls running now, keep the order (`unavailable`); a call running now
   * settles at once, without waiting for its provider or its deadline. The judge starts no further model call for
   * them, and the local model is released once its load and the reranks using it have ended. Never rejects.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.state = 'unavailable';
    for (const [signal, stop] of this.running) {
      signal.abort();
      stop();
    }
    try {
      await this.settled;
      await this.provider.dispose?.();
    } catch {
      // A model that fails to release is nothing a turn can act on.
    }
  }

  /**
   * Scores `documents` (the recall's candidates, best first) against `query`. At most `maxCandidates` reach the
   * provider, the first ones.
   *
   * @param query - The turn's text.
   * @param documents - The candidates, each with the score it holds.
   * @returns The record and the scores; with the reason and no score when the order stands.
   */
  async rerank(query: string, documents: ReadonlyArray<{ id: string; content: string; score: number }>): Promise<RerankOutcome> {
    const kept = (reason: RerankSkipReason): RerankOutcome => ({ record: { provider: 'none', reason }, scores: new Map() });
    const skipped = (reason: 'loading' | 'timeout' | 'error'): RerankOutcome => {
      recallLog.info('memory.recall.rerank_skipped', { provider: this.kind, reason });
      return kept(reason);
    };
    if (this.state === 'unavailable') return kept('unavailable');
    if (this.state !== 'ready') return skipped('loading');
    // The back-off's one line was written when it began.
    if (Date.now() < this.backoffUntil) return kept('backoff');
    const answered = (candidates: number, ms: number): MemoryRecallReranker => ({
      provider: this.kind,
      model: this.setting.model,
      ...(this.setting.kind === 'local' ? { revision: this.setting.revision } : {}),
      candidates,
      ms,
    });
    if (documents.length === 0) return { record: answered(0, 0), scores: new Map() };

    const failed = (reason: 'timeout' | 'error'): RerankOutcome => {
      this.failures += 1;
      const outcome = skipped(reason);
      if (this.failures >= RERANK_DEFAULTS.failuresToBackOff) {
        this.failures = 0;
        this.backoffUntil = Date.now() + RERANK_DEFAULTS.backoffMs;
        recallLog.warn('memory.recall.rerank_skipped', { provider: this.kind, reason: 'backoff' });
      }
      return outcome;
    };

    const batch = documents.slice(0, this.setting.maxCandidates ?? RERANK_DEFAULTS.maxCandidates);
    const timeoutMs = this.setting.timeoutMs ?? (this.kind === 'local' ? RERANK_DEFAULTS.localTimeoutMs : RERANK_DEFAULTS.llmTimeoutMs);
    const started = performance.now();
    // Aborted at the deadline, or when the reranker is stopped, so the judge starts no further model call for a
    // rerank nobody waits for.
    const abandoned = new AbortController();
    // Settled when the reranker is stopped, so a rerank nobody can use waits neither for its provider nor its deadline.
    let stop!: () => void;
    const stopped = new Promise<'stopped'>((resolve) => {
      stop = () => resolve('stopped');
    });
    this.running.set(abandoned, stop);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The deadline is set before the provider is called: of two timers due together, a provider's own and this one,
      // this one runs first.
      const deadline = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          abandoned.abort();
          resolve('timeout');
        }, timeoutMs);
      });
      const call = this.service.rerank(
        { query, documents: batch.map((d) => ({ id: d.id, content: d.content, originalScore: d.score })) },
        // Every candidate of the batch is scored: the service sends a provider at most 100 documents when told no limit.
        { timeoutMs, maxDocuments: batch.length, params: { signal: abandoned.signal } },
      );
      // The loser of the race must not reject unhandled.
      call.catch(() => undefined);
      const output = await Promise.race([call, deadline, stopped]);
      // Stopped while it ran (the setting changed, or the manager shut down): its answer orders nothing, and the
      // provider is not at fault.
      if (this.disposed || output === 'stopped') return kept('unavailable');
      // The provider's work is abandoned; its late answer is dropped.
      if (output === 'timeout') return failed('timeout');

      const metrics = (output.diagnostics?.providerMetrics ?? {}) as { scoringFailures?: unknown; listwiseFailed?: unknown };
      const unscored = typeof metrics.scoringFailures === 'number' && metrics.scoringFailures > 0 ? Math.ceil(metrics.scoringFailures) : 0;
      const substituted = unscored + (metrics.listwiseFailed === true ? 1 : 0);
      if (substituted > 0) {
        recallLog.warn('memory.recall.rerank_failed_scoring', { provider: this.kind, failures: substituted });
        return failed('error');
      }
      // Every candidate sent, each with a score that can order it: an answer that leaves one out, or scores one with
      // no finite number, orders nothing.
      const sent = new Set(batch.map((d) => d.id));
      const scores = new Map<string, number>();
      for (const result of output.results) {
        if (!sent.has(result.id)) continue;
        if (typeof result.relevanceScore !== 'number' || !Number.isFinite(result.relevanceScore)) return failed('error');
        scores.set(result.id, result.relevanceScore);
      }
      if (scores.size !== sent.size) return failed('error');
      this.failures = 0;
      return { record: answered(batch.length, Math.round(performance.now() - started)), scores };
    } catch {
      return this.disposed ? kept('unavailable') : failed('error');
    } finally {
      if (timer) clearTimeout(timer);
      this.running.delete(abandoned);
    }
  }
}
