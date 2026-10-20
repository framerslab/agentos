/**
 * @fileoverview Hybrid IUtilityAI that delegates to LLM-based or statistical
 * implementations depending on the task. LLM methods are preferred for
 * summarization, classification, and keyword extraction; statistical methods
 * for tokenization, normalization, stemming, n-grams, readability, similarity,
 * sentiment and language detection. A call whose `method` only one of the two
 * has goes to that one.
 *
 * A hybrid that holds one class sends every call to it. An error from the class
 * a call went to reaches the caller; the call is not retried on the other.
 */

import type {
  IUtilityAI,
  UtilityAIConfigBase,
  ParseJsonOptions,
  SummarizationOptions,
  ClassificationOptions,
  ClassificationResult,
  KeywordExtractionOptions,
  TokenizationOptions,
  StemmingOptions,
  SimilarityOptions,
  SentimentAnalysisOptions,
  SentimentResult,
  LanguageDetectionOptions,
  LanguageDetectionResult,
  TextNormalizationOptions,
  NGramOptions,
  ReadabilityOptions,
  ReadabilityResult,
} from './IUtilityAI';

export interface HybridUtilityAIConfig extends UtilityAIConfigBase {
  /** LLM-based implementation (used for generative tasks). */
  llm?: IUtilityAI;
  /** Statistical/NLP implementation (used for deterministic tasks). */
  statistical?: IUtilityAI;
}

/** A task whose `method` option can name a method only one of the two classes has. */
type MethodTask = 'summarize' | 'classifyText' | 'extractKeywords' | 'calculateSimilarity' | 'analyzeSentiment';

/** The methods, by task, that the statistical class has and the LLM-backed one refuses or sends to a provider. */
const STATISTICAL_METHODS: Record<MethodTask, readonly string[]> = {
  summarize: ['first_n_sentences', 'extractive_sentence_rank'],
  classifyText: ['naive_bayes', 'keyword_matching'],
  extractKeywords: ['tf_idf', 'frequency_based'],
  calculateSimilarity: ['cosine_tfidf', 'jaccard', 'levenshtein'],
  analyzeSentiment: ['lexicon_based'],
};

/** The methods, by task, that only the LLM-backed class has: the statistical one refuses them or scores without them. */
const LLM_METHODS: Record<MethodTask, readonly string[]> = {
  summarize: ['abstractive_llm', 'key_points_llm'],
  classifyText: ['llm_zeroshot'],
  extractKeywords: ['llm'],
  calculateSimilarity: ['llm_semantic'],
  analyzeSentiment: ['llm'],
};

/**
 * Routes each utility method to the most appropriate backend:
 * - **LLM**: summarization, classification, keyword extraction, JSON repair
 * - **Statistical**: tokenization, stemming, n-grams, readability, similarity
 * - **Either with preference**: sentiment, language detection
 *
 * A summary, classification, keyword list, similarity or sentiment whose `method` names a method only one class has
 * goes to that class when the hybrid holds it. The statistical class takes `first_n_sentences` and
 * `extractive_sentence_rank` summaries, `naive_bayes` and `keyword_matching` classification, `tf_idf` and
 * `frequency_based` keywords, `cosine_tfidf`, `jaccard` and `levenshtein` similarity and `lexicon_based` sentiment;
 * the LLM-backed class takes `abstractive_llm` and `key_points_llm` summaries, `llm_zeroshot` classification, `llm`
 * keywords, `llm_semantic` similarity and `llm` sentiment. If the preferred backend is not held, the other one takes
 * the call.
 */
export class HybridUtilityAI implements IUtilityAI {
  public readonly utilityId: string;
  private readonly llm: IUtilityAI | undefined;
  private readonly stat: IUtilityAI | undefined;

  constructor(config: HybridUtilityAIConfig) {
    this.llm = config.llm;
    this.stat = config.statistical;
    if (!this.llm && !this.stat) {
      throw new Error('HybridUtilityAI requires at least one backend (llm or statistical)');
    }
    this.utilityId = config.utilityId ?? `hybrid-${this.llm?.utilityId ?? 'none'}-${this.stat?.utilityId ?? 'none'}`;
  }

  async initialize(config: UtilityAIConfigBase & Record<string, any>): Promise<void> {
    await Promise.all([
      this.llm?.initialize?.(config),
      this.stat?.initialize?.(config),
    ]);
  }

  private preferLLM(): IUtilityAI {
    return this.llm ?? this.stat!;
  }

  private preferStat(): IUtilityAI {
    return this.stat ?? this.llm!;
  }

  /** The class a task's call goes to: the one that alone has the method it names, when the hybrid holds it, else `usual`. */
  private byMethod(task: MethodTask, method: string | undefined, usual: IUtilityAI): IUtilityAI {
    if (method && this.stat && STATISTICAL_METHODS[task].includes(method)) return this.stat;
    if (method && this.llm && LLM_METHODS[task].includes(method)) return this.llm;
    return usual;
  }

  // --- LLM-preferred methods ---

  async summarize(textToSummarize: string, options?: SummarizationOptions): Promise<string> {
    return this.byMethod('summarize', options?.method, this.preferLLM()).summarize(textToSummarize, options);
  }

  async classifyText(textToClassify: string, options: ClassificationOptions): Promise<ClassificationResult> {
    return this.byMethod('classifyText', options?.method, this.preferLLM()).classifyText(textToClassify, options);
  }

  async extractKeywords(textToAnalyze: string, options?: KeywordExtractionOptions): Promise<string[]> {
    return this.byMethod('extractKeywords', options?.method, this.preferLLM()).extractKeywords(textToAnalyze, options);
  }

  async parseJsonSafe<T = any>(jsonString: string, options?: ParseJsonOptions<T>): Promise<T | null> {
    // Try statistical (fast parsing) first, fall back to LLM (repair)
    try {
      const result = await this.preferStat().parseJsonSafe<T>(jsonString, options);
      if (result !== null) return result;
    } catch { /* fall through */ }
    if (this.llm && this.stat) {
      return this.llm.parseJsonSafe<T>(jsonString, options);
    }
    return null;
  }

  // --- Statistical-preferred methods ---

  async tokenize(text: string, options?: TokenizationOptions): Promise<string[]> {
    return this.preferStat().tokenize(text, options);
  }

  async stemTokens(tokens: string[], options?: StemmingOptions): Promise<string[]> {
    return this.preferStat().stemTokens(tokens, options);
  }

  async normalizeText(text: string, options?: TextNormalizationOptions): Promise<string> {
    return this.preferStat().normalizeText(text, options);
  }

  async generateNGrams(tokens: string[], options: NGramOptions): Promise<Record<number, string[][]>> {
    return this.preferStat().generateNGrams(tokens, options);
  }

  async calculateReadability(text: string, options: ReadabilityOptions): Promise<ReadabilityResult> {
    return this.preferStat().calculateReadability(text, options);
  }

  async calculateSimilarity(text1: string, text2: string, options?: SimilarityOptions): Promise<number> {
    return this.byMethod('calculateSimilarity', options?.method, this.preferStat()).calculateSimilarity(text1, text2, options);
  }

  // --- Either with preference ---

  async analyzeSentiment(text: string, options?: SentimentAnalysisOptions): Promise<SentimentResult> {
    return this.byMethod('analyzeSentiment', options?.method, this.preferStat()).analyzeSentiment(text, options);
  }

  async detectLanguage(text: string, options?: LanguageDetectionOptions): Promise<LanguageDetectionResult[]> {
    return this.preferStat().detectLanguage(text, options);
  }

  // --- Health & lifecycle ---

  async checkHealth(): Promise<{ isHealthy: boolean; details?: any; dependencies?: Array<{ name: string; isHealthy: boolean; details?: any }> }> {
    const deps: Array<{ name: string; isHealthy: boolean; details?: any }> = [];
    if (this.llm) {
      try {
        const h = await this.llm.checkHealth();
        deps.push({ name: `llm:${this.llm.utilityId}`, ...h });
      } catch (e) {
        deps.push({ name: `llm:${this.llm.utilityId}`, isHealthy: false, details: (e as Error).message });
      }
    }
    if (this.stat) {
      try {
        const h = await this.stat.checkHealth();
        deps.push({ name: `stat:${this.stat.utilityId}`, ...h });
      } catch (e) {
        deps.push({ name: `stat:${this.stat.utilityId}`, isHealthy: false, details: (e as Error).message });
      }
    }
    return {
      isHealthy: deps.every((d) => d.isHealthy),
      dependencies: deps,
    };
  }

  async shutdown(): Promise<void> {
    await Promise.all([
      this.llm?.shutdown?.(),
      this.stat?.shutdown?.(),
    ]);
  }
}
