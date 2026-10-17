/**
 * @fileoverview Defines the comprehensive interface for a Utility AI service in AgentOS.
 * This service provides a wide array of common AI-driven and statistical NLP utility functions
 * such as text summarization, classification, keyword extraction, sentiment analysis,
 * language detection, text normalization, JSON parsing, similarity calculation, n-gram generation,
 * and readability assessment. The interface allows for diverse underlying implementations
 * (e.g., LLM-based, statistical NLP libraries, or other machine learning models).
 * @module backend/agentos/nlp/ai_utilities/IUtilityAI
 */

import { JSONSchemaObject } from '../../../core/tools/ITool'; // Re-using from ITool for schema definition

// --- Configuration for Implementations ---
/**
 * Base configuration for any IUtilityAI implementation.
 */
export interface UtilityAIConfigBase {
  /** Unique identifier for this specific utility AI service instance. */
  utilityId?: string;
  /** Default language for processing if not specified in method options (e.g., 'en', 'es'). BCP-47 format preferred. */
  defaultLanguage?: string;
  /** Path to a directory containing resource files (e.g., stop word lists, lexicons, trained models for statistical utilities). */
  resourcePath?: string;
}

// --- Summarization Types ---
/** Options for text summarization. */
export interface SummarizationOptions {
  desiredLength?: 'short' | 'medium' | 'long' | number; // number as % (0-1) or target sentences/tokens (>1)
  method?: 'extractive_sentence_rank' | 'first_n_sentences' | 'abstractive_llm' | 'key_points_llm' | string; // Allow custom methods
  modelId?: string; // For LLM-based methods
  providerId?: string; // For LLM-based methods
  methodOptions?: Record<string, any>; // e.g., { lexRank: { similarityThreshold: 0.1 } } or LLM completion params
  maxInputLength?: number; // Characters or tokens
  language?: string; // BCP-47
}

// --- Classification Types ---
/** Options for text classification. */
export interface ClassificationOptions {
  candidateClasses: string[];
  multiLabel?: boolean; // Default false
  method?: 'naive_bayes' | 'llm_zeroshot' | 'keyword_matching' | string;
  modelId?: string; // For LLM or trained statistical models
  providerId?: string; // For LLM-based methods
  methodOptions?: Record<string, any>;
  language?: string; // BCP-47
}
export interface ClassificationScore { classLabel: string; score: number; }
export interface ClassificationResult {
  bestClass: string | string[];
  confidence: number | number[]; // Confidence for the bestClass(es)
  allScores: ClassificationScore[];
}

// --- Keyword Extraction Types ---
export interface KeywordExtractionOptions {
  maxKeywords?: number; // Default 5
  method?: 'tf_idf' | 'rake' | 'frequency_based' | 'llm' | string;
  modelId?: string; // For LLM-based methods
  providerId?: string; // For LLM-based methods
  methodOptions?: Record<string, any>;
  language?: string; // BCP-47 for stop words
}

// --- Tokenization Types ---
export interface TokenizationOptions {
  type?: 'word' | 'sentence' | 'subword_bpe'; // Default 'word'
  /** Default true. StatisticalUtilityAI keeps a sentence's case unless it is true. */
  toLowerCase?: boolean;
  /** LLMUtilityAI: default true for words, false for sentences. StatisticalUtilityAI's words never hold punctuation. */
  removePunctuation?: boolean;
  language?: string; // BCP-47
  modelId?: string; // For subword tokenizers like BPE
}

// --- Stemming Types ---
export interface StemmingOptions {
  algorithm?: 'porter' | 'lancaster' | string; // Default 'porter'
  language?: string; // BCP-47
}

// --- Similarity Calculation Types ---
export interface SimilarityOptions {
  method?: 'cosine_tfidf' | 'cosine_embedding' | 'jaccard' | 'levenshtein' | 'llm_semantic' | string; // Default 'cosine_tfidf'
  stem?: boolean; // Default true for TF-IDF/Jaccard
  removeStopWords?: boolean; // Default true for TF-IDF/Jaccard
  language?: string; // BCP-47
  embeddingModelId?: string; // For 'cosine_embedding' method
  embeddingProviderId?: string; // For 'cosine_embedding' method
  llmModelId?: string; // For 'llm_semantic' method
  llmProviderId?: string; // For 'llm_semantic' method
  corpusForIDF?: string[]; // For TF-IDF based cosine similarity
}

// --- Sentiment Analysis Types ---
export interface SentimentAnalysisOptions {
  method?: 'lexicon_based' | 'llm' | 'trained_classifier' | string;
  modelId?: string; // For LLM or trained classifier
  /** The provider LLMUtilityAI calls: this, else `methodOptions.providerId`, else its `defaultProviderId`. */
  providerId?: string;
  /**
   * StatisticalUtilityAI: a lexicon `natural` ships, by name (`afinn`, `afinnFinancialMarketNews`, `pattern`,
   * `senticon`), or the path of a lexicon file, which is then the lexicon alone.
   */
  lexiconNameOrPath?: string;
  language?: string; // BCP-47
  methodOptions?: Record<string, any>;
}
export interface SentimentResult {
  score: number; // Overall sentiment score (interpretation depends on method, e.g., -1 to 1)
  polarity: 'positive' | 'negative' | 'neutral';
  comparative?: number; // StatisticalUtilityAI: the sum of the word values over the number of words
  intensity?: number; // Estimated intensity (0-1)
  positiveTokens?: Array<{ token: string; score?: number }>;
  negativeTokens?: Array<{ token: string; score?: number }>;
  neutralTokens?: Array<{ token: string; score?: number }>; // Tokens considered neutral or not matched
}

// --- Language Detection Types ---
export interface LanguageDetectionOptions {
  maxCandidates?: number; // Default 3 for StatisticalUtilityAI, 1 for LLMUtilityAI
  method?: 'n_gram' | 'llm' | 'heuristic' | string;
  modelId?: string; // For LLM-based methods
  providerId?: string; // For LLM-based methods
  methodOptions?: Record<string, any>;
}
export interface LanguageDetectionResult {
  language: string; // BCP-47 language code (e.g., 'en', 'es', 'fra')
  confidence: number; // 0-1
}

// --- Text Normalization Types ---
export interface TextNormalizationOptions {
  toLowerCase?: boolean; // Default true
  removePunctuation?: boolean; // Default false; StatisticalUtilityAI joins words, so its output never holds punctuation
  removeStopWords?: boolean; // Default false
  stem?: boolean; // Default false
  stemAlgorithm?: StemmingOptions['algorithm'];
  expandContractions?: boolean; // Default false; StatisticalUtilityAI expands English contractions only
  replaceNumbersWith?: string | null; // null to remove, string to replace (e.g., "<NUM>")
  stripHtml?: boolean; // Default false
  language?: string; // BCP-47
}

// --- N-gram Generation Types ---
export interface NGramOptions {
  n: number | number[]; // Size(s) of N-grams
  includePartial?: boolean; // Default false
}

// --- Readability Assessment Types ---
export interface ReadabilityOptions {
  formula:
    | 'flesch_kincaid_reading_ease'
    | 'flesch_kincaid_grade_level'
    | 'gunning_fog'
    | 'smog_index'
    | 'coleman_liau_index'
    | 'automated_readability_index'
    | string; // Allow custom formula names
}
export interface ReadabilityResult {
  score: number;
  interpretation?: string;
  gradeLevel?: string; // Estimated U.S. school grade level
}

// --- JSON Parsing Types ---
/** Options for safe JSON parsing. */
export interface ParseJsonOptions<_T = any> {
  /** If true, attempts to use an LLM to fix or extract JSON if standard parsing fails. */
  attemptFixWithLLM?: boolean;
  /** The model a repair calls. LLMUtilityAI: else its `jsonFixerModelId`, else its `defaultModelId`. */
  llmModelIdForFix?: string;
  /** The provider a repair calls. LLMUtilityAI: else its `defaultProviderId`. */
  llmProviderIdForFix?: string;
  /**
   * Optional JSON schema to validate the parsed object against. LLMUtilityAI sends a value that fails it for repair
   * as it sends a text that does not parse, and answers `null` when no repair passes it.
   */
  targetSchema?: JSONSchemaObject; // Using the type from ITool.ts for consistency
  /**
   * LLMUtilityAI: how many repairs to try, each on the text the last one answered, while a repair does not parse or
   * fails `targetSchema`. 1 unless given.
   */
  maxRepairAttempts?: number;
}


/**
 * @interface IUtilityAI
 * Defines the contract for a comprehensive Utility AI service.
 */
export interface IUtilityAI {
  readonly utilityId: string;

  initialize(config: UtilityAIConfigBase & Record<string, any>): Promise<void>;

  // NLP & Text Processing Methods
  summarize(textToSummarize: string, options?: SummarizationOptions): Promise<string>;
  classifyText(textToClassify: string, options: ClassificationOptions): Promise<ClassificationResult>;
  extractKeywords(textToAnalyze: string, options?: KeywordExtractionOptions): Promise<string[]>;
  tokenize(text: string, options?: TokenizationOptions): Promise<string[]>;
  stemTokens(tokens: string[], options?: StemmingOptions): Promise<string[]>;
  calculateSimilarity(text1: string, text2: string, options?: SimilarityOptions): Promise<number>;
  analyzeSentiment(text: string, options?: SentimentAnalysisOptions): Promise<SentimentResult>;
  detectLanguage(text: string, options?: LanguageDetectionOptions): Promise<LanguageDetectionResult[]>;
  normalizeText(text: string, options?: TextNormalizationOptions): Promise<string>;
  generateNGrams(tokens: string[], options: NGramOptions): Promise<Record<number, string[][]>>; // N -> list of N-grams
  calculateReadability(text: string, options: ReadabilityOptions): Promise<ReadabilityResult>;

  // JSON Processing
  /**
   * Safely parses a string that is expected to be JSON, potentially using an LLM to fix common issues.
   * @template T - The expected type of the parsed JSON object.
   * @param {string} jsonString - The string to parse.
   * @param {ParseJsonOptions<T>} [options] - Options for parsing and fixing.
   * @returns {Promise<T | null>} The parsed object, or null if parsing and fixing fail.
   */
  parseJsonSafe<T = any>(jsonString: string, options?: ParseJsonOptions<T>): Promise<T | null>;

  // Health & Model Management
  checkHealth(): Promise<{ isHealthy: boolean; details?: any; dependencies?: Array<{name: string; isHealthy: boolean; details?: any}> }>;
  shutdown?(): Promise<void>; // Optional shutdown for releasing resources

  // Optional training/management methods (more relevant for StatisticalUtilityAI)
  trainModel?(
    trainingData: Array<{text: string, label: string} | any>,
    modelType: string, // e.g., 'text_classifier_naive_bayes', 'sentiment_analyzer_vader_custom'
    trainingOptions?: Record<string, any>
  ): Promise<{success: boolean; message?: string; modelId?: string}>;

  saveTrainedModel?(modelTypeOrId: string, pathOrStoreId?: string): Promise<{success: boolean; pathOrStoreId?: string; message?: string}>;
  loadTrainedModel?(modelTypeOrId: string, pathOrStoreId?: string): Promise<{success: boolean; message?: string}>;
}
