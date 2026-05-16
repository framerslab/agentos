/**
 * @fileoverview Implementation of IUtilityAI using statistical and
 * conventional NLP methods, primarily leveraging the 'natural' library.
 * This utility is suited for tasks where deterministic, fast, and often offline
 * processing is preferred over LLM-based approaches.
 *
 * @module backend/agentos/nlp/ai_utilities/StatisticalUtilityAI
 * @see ./IUtilityAI.ts
 * @see 'natural' library documentation
 */

import * as fs from 'fs/promises'; // For loading resources
import * as path from 'path';     // For path manipulation
import { uuidv4 } from '../../../core/utils/uuid';
import {
  IUtilityAI, UtilityAIConfigBase, ParseJsonOptions,
  SummarizationOptions, ClassificationOptions, ClassificationResult, ClassificationScore,
  KeywordExtractionOptions, TokenizationOptions, StemmingOptions,
  SimilarityOptions, SentimentAnalysisOptions, SentimentResult,
  LanguageDetectionOptions, LanguageDetectionResult,
  TextNormalizationOptions, NGramOptions, ReadabilityOptions, ReadabilityResult,
} from './IUtilityAI';
import * as natural from 'natural';
import { GMIError, GMIErrorCode } from '../../../core/utils/errors.js';
import { detectLanguageTrigram } from './trigram-language-profiles';

const NATURAL_STEMMER_LANGUAGE_KEYS: Record<string, string> = {
  De: 'de',
  Es: 'es',
  Fa: 'fa',
  Fr: 'fr',
  It: 'it',
  Nl: 'nl',
  No: 'no',
  Pt: 'pt',
  Ru: 'ru',
  Sv: 'sv',
  Uk: 'uk',
};

// Default English stop words list (can be expanded or loaded from file)
const DEFAULT_ENGLISH_STOP_WORDS = new Set([
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours', 'yourself', 'yourselves',
  'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their',
  'theirs', 'themselves', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing', 'a', 'an',
  'the', 'and', 'but', 'if', 'or', 'because', 'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with', 'about',
  'against', 'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up',
  'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don',
  'should', 'now', 'com', 'edu', 'gov', 'org', 'www', 'http', 'https', 'eg', 'ie',
  // Consider language-specific stop word lists.
]);

export interface StatisticalUtilityAIConfig extends UtilityAIConfigBase {
  // Path to directory for models, lexicons, stop words etc. Default language is from UtilityAIConfigBase.
  resourcePath?: string;

  defaultStopWordsLanguage?: string; // e.g., 'en'
  customStopWordsPaths?: Record<string, string>; // lang_code -> file_path

  summarizerConfig?: {
    lexRank?: { // Parameters for LexRank-like summarization
      similarityThreshold?: number; // Default 0.1
      dampingFactor?: number;       // Default 0.85
      maxIterations?: number;       // Default 100
      epsilon?: number;             // Convergence threshold, default 1e-4
    }
  };
  classifierConfig?: {
    naiveBayes?: {
      modelStoragePath?: string; // Directory to save/load trained Naive Bayes models
      defaultModelId?: string;   // Default model ID to load/use if not specified in classifyText options
      defaultAlpha?: number;     // Laplace smoothing, default 0.05
    }
  };
  sentimentConfig?: {
    lexiconPath?: string; // Path to a custom sentiment lexicon file (e.g., AFINN format: word\tscore)
    defaultLexiconLanguage?: string; // Language of the default or loaded lexicon
  };
  languageDetectionConfig?: {
    // Config for n-gram profiles or other statistical language detection models
    nGramProfilePath?: string;
  };
  readabilitySyllableAlgorithm?: 'regex_approx' | 'dictionary_lookup'; // For more precise syllable counting
}

export class StatisticalUtilityAI implements IUtilityAI {
  public readonly utilityId: string;
  private config!: StatisticalUtilityAIConfig; // Make it fully required internally
  private isInitialized: boolean = false;

  private tokenizers: { word: natural.WordTokenizer, sentence: natural.SentenceTokenizer };
  private stemmers: Record<string, natural.Stemmer>; // algorithm_name -> stemmer_instance
  private stopWords: Map<string, Set<string>>; // language -> Set<string>

  // For Naive Bayes classifier instances: modelId -> classifier
  private classifiers: Map<string, natural.BayesClassifier>;
  // For sentiment analysis
  private sentimentAnalyzers: Map<string, natural.SentimentAnalyzer>; // language -> analyzer

  private createStemmerRegistry(): Record<string, natural.Stemmer> {
    const registry: Record<string, natural.Stemmer> = {
      porter: natural.PorterStemmer,
      lancaster: natural.LancasterStemmer,
    };

    const naturalWithVariants = natural as unknown as Record<string, unknown>;
    for (const [suffix, langCode] of Object.entries(NATURAL_STEMMER_LANGUAGE_KEYS)) {
      const porterVariant = naturalWithVariants[`PorterStemmer${suffix}`];
      if (porterVariant && typeof (porterVariant as natural.Stemmer).stem === 'function') {
        registry[`porter_${langCode}`] = porterVariant as natural.Stemmer;
      }
    }

    const carryFrench = naturalWithVariants.CarryStemmerFr;
    if (carryFrench && typeof (carryFrench as natural.Stemmer).stem === 'function') {
      registry.carry_fr = carryFrench as natural.Stemmer;
    }

    const stemmerId = naturalWithVariants.StemmerId;
    if (stemmerId && typeof (stemmerId as natural.Stemmer).stem === 'function') {
      registry.default_id = stemmerId as natural.Stemmer;
    }

    const stemmerJa = naturalWithVariants.StemmerJa;
    if (stemmerJa && typeof (stemmerJa as natural.Stemmer).stem === 'function') {
      registry.default_ja = stemmerJa as natural.Stemmer;
    }

    return registry;
  }

  constructor(utilityId?: string) {
    this.utilityId = utilityId || `stat-utility-${uuidv4()}`;
    this.tokenizers = {
      word: new natural.WordTokenizer(),
      sentence: new natural.SentenceTokenizer(),
    };
    this.stemmers = this.createStemmerRegistry();
    this.stopWords = new Map<string, Set<string>>([['en', DEFAULT_ENGLISH_STOP_WORDS]]);
    this.classifiers = new Map();
    this.sentimentAnalyzers = new Map();
  }

  public async initialize(config: StatisticalUtilityAIConfig): Promise<void> {
    if (this.isInitialized) {
      console.warn(`StatisticalUtilityAI (ID: ${this.utilityId}) already initialized. Re-initializing.`);
      // Clear any loaded resources before re-initializing if necessary
      this.stopWords.clear();
      this.stopWords.set('en', DEFAULT_ENGLISH_STOP_WORDS);
      this.classifiers.clear();
      this.sentimentAnalyzers.clear();
    }
    this.config = {
        defaultLanguage: 'en', // Default language for the utility itself
        ...config,
        summarizerConfig: { lexRank: { similarityThreshold: 0.1, dampingFactor: 0.85, maxIterations:100, epsilon:1e-4, ...config.summarizerConfig?.lexRank } },
        classifierConfig: { naiveBayes: { defaultAlpha: 0.05, ...config.classifierConfig?.naiveBayes } },
        sentimentConfig: { defaultLexiconLanguage: 'en', ...config.sentimentConfig },
    };


    // Load custom stop words if configured
    if (this.config.customStopWordsPaths) {
      for (const [lang, filePath] of Object.entries(this.config.customStopWordsPaths)) {
        try {
          const fullPath = this.config.resourcePath ? path.join(this.config.resourcePath, filePath) : filePath;
          const stopWordsStr = await fs.readFile(fullPath, 'utf-8');
          this.stopWords.set(lang.toLowerCase(), new Set(stopWordsStr.split(/\r?\n/).map(sw => sw.trim().toLowerCase()).filter(Boolean)));
          console.log(`StatisticalUtilityAI (ID: ${this.utilityId}): Loaded custom stop words for '${lang}' from ${filePath}.`);
        } catch (error: any) {
          console.warn(`StatisticalUtilityAI (ID: ${this.utilityId}): Failed to load custom stop words for '${lang}' from '${filePath}': ${error.message}. Using default if 'en'.`);
        }
      }
    }
    
    // Initialize default sentiment analyzer
    const defaultSentimentLang = this.config.sentimentConfig?.defaultLexiconLanguage || this.config.defaultLanguage || 'en';
    this.getSentimentAnalyzer(defaultSentimentLang); // Pre-initialize for default language

    // Pre-load default Naive Bayes classifier if modelId specified
    if (this.config.classifierConfig?.naiveBayes?.defaultModelId) {
        try {
            await this.loadTrainedModel(this.config.classifierConfig.naiveBayes.defaultModelId, 'naive_bayes');
        } catch {
            console.warn(`StatisticalUtilityAI (ID: ${this.utilityId}): Failed to pre-load default Naive Bayes classifier '${this.config.classifierConfig.naiveBayes.defaultModelId}'. It may need training or explicit loading.`);
        }
    }


    this.isInitialized = true;
    console.log(`StatisticalUtilityAI (ID: ${this.utilityId}) initialized.`);
  }

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new GMIError(`StatisticalUtilityAI (ID: ${this.utilityId}) not initialized.`, GMIErrorCode.NOT_INITIALIZED);
    }
  }

  private getStopWords(language?: string): Set<string> {
    const langCode = (language || this.config.defaultLanguage || 'en').toLowerCase().split('-')[0];
    return this.stopWords.get(langCode) || this.stopWords.get('en') || DEFAULT_ENGLISH_STOP_WORDS;
  }

  private getStemmer(algorithm?: string, language?: string): natural.Stemmer {
    const algo = (algorithm || 'porter').toLowerCase();
    const langCode = language?.toLowerCase().split('-')[0];
    if (langCode && langCode !== 'en' && this.stemmers[`${algo}_${langCode}`]) {
        return this.stemmers[`${algo}_${langCode}`];
    }
    if (langCode && this.stemmers[`default_${langCode}`]) {
        return this.stemmers[`default_${langCode}`];
    }
    return this.stemmers[algo] || natural.PorterStemmer; // Fallback to Porter
  }

  private getSentimentAnalyzer(language: string): natural.SentimentAnalyzer {
    const langCode = language.toLowerCase().split('-')[0];
    if (!this.sentimentAnalyzers.has(langCode)) {
      try {
        const stemmer = langCode === 'en' ? natural.PorterStemmer : undefined;
        const analyzer = new (natural.SentimentAnalyzer as any)(langCode, stemmer, 'afinn');
        const customLexicon =
          langCode === 'en' && this.config.sentimentConfig?.lexiconPath
            ? this.loadSentimentLexiconFromFile(this.config.sentimentConfig.lexiconPath)
            : undefined;
        if (customLexicon) {
          (analyzer as any).vocabulary = {
            ...(analyzer as any).vocabulary,
            ...customLexicon,
          };
        }
        this.sentimentAnalyzers.set(langCode, analyzer);
        console.log(
          `StatisticalUtilityAI (ID: ${this.utilityId}): Initialized sentiment analyzer for language '${langCode}'.`,
        );
      } catch (e: any) {
        console.warn(
          `StatisticalUtilityAI (ID: ${this.utilityId}): Failed to initialize sentiment analyzer for '${langCode}' (${e?.message}). Falling back to neutral analyzer.`,
        );
        const neutralAnalyzer = {
          getSentiment: (_tokens: string[]) => 0,
          vocabulary: {},
        } as any;
        this.sentimentAnalyzers.set(langCode, neutralAnalyzer as unknown as natural.SentimentAnalyzer);
      }
    }
    return this.sentimentAnalyzers.get(langCode)!;
  }

  // Helper to load lexicon (conceptual for now, needs actual file reading)
  private loadSentimentLexiconFromFile(filePath: string): Record<string, number> | undefined {
    // This would read a file (e.g., AFINN format: word\tscore) and parse it.
    // For this example, it's a placeholder. In initialize, a basic lexicon is hardcoded.
    console.warn(`StatisticalUtilityAI (ID: ${this.utilityId}): Custom sentiment lexicon loading from '${filePath}' is conceptual.`);
    return undefined;
  }


  public async summarize(textToSummarize: string, options?: SummarizationOptions): Promise<string> {
    this.ensureInitialized();
    const method = options?.method || 'extractive_sentence_rank'; // 'natural' does not have built-in LexRank.

    if (method === 'first_n_sentences') {
      const sentences = this.tokenizers.sentence.tokenize(textToSummarize);
      if (!sentences || sentences.length === 0) return "";
      let numSentences = 3; // Default
      if (options?.desiredLength) {
        if (options.desiredLength === 'short') numSentences = 2;
        else if (options.desiredLength === 'medium') numSentences = Math.max(3, Math.floor(sentences.length * 0.3));
        else if (options.desiredLength === 'long') numSentences = Math.max(4, Math.floor(sentences.length * 0.5));
        else if (typeof options.desiredLength === 'number') {
            numSentences = options.desiredLength <= 1 ? Math.round(options.desiredLength * sentences.length) : options.desiredLength;
        }
      }
      numSentences = Math.min(Math.max(1, numSentences), sentences.length);
      return sentences.slice(0, numSentences).join(" ").trim();
    } else if (method === 'extractive_sentence_rank') {
        // 'natural' does not have a direct LexRank or TextRank summarizer.
        // Implementing one here is complex. Falling back to first_n for now.
        console.warn(`StatisticalUtilityAI (ID: ${this.utilityId}): Method 'extractive_sentence_rank' for summarize is conceptual/not fully implemented with 'natural'. Falling back to 'first_n_sentences'.`);
        return this.summarize(textToSummarize, {...options, method: 'first_n_sentences'});
    }
    throw new GMIError(`Summarization method '${method}' not supported by StatisticalUtilityAI.`, GMIErrorCode.NOT_SUPPORTED);
  }

  public async classifyText(textToClassify: string, options: ClassificationOptions): Promise<ClassificationResult> {
    this.ensureInitialized();
    const modelId = options.modelId || this.config.classifierConfig?.naiveBayes?.defaultModelId || 'default_bayes';
    const classifier = this.classifiers.get(modelId);

    if (options.method === 'naive_bayes' && classifier) {
      try {
        const tokens = this.tokenizers.word.tokenize(textToClassify.toLowerCase());
        if (!tokens) throw new GMIError("Tokenization failed for classification.", GMIErrorCode.PROCESSING_ERROR);
        const stemmedTokens = tokens.map(t => this.getStemmer('porter', options.language).stem(t));
        const classifications = classifier.getClassifications(stemmedTokens.join(' '));
        
        if (!classifications || classifications.length === 0) {
            throw new GMIError("Naive Bayes classifier returned no classifications.", GMIErrorCode.PROCESSING_ERROR);
        }

        const best = classifications[0];
        let bestClasses: string | string[] = best.label;
        let confidences: number | number[] = best.value;

        if (options.multiLabel) {
            // For multi-label, need a threshold or to return top N. 'natural' Bayes returns sorted probabilities.
            // This is a simplification for multi-label.
            bestClasses = classifications.filter(c => c.value > 0.1).map(c => c.label); // Example threshold
            if (bestClasses.length === 0 && classifications.length > 0) bestClasses = [classifications[0].label]; // Fallback
            confidences = bestClasses.map(bc => classifications.find(c=>c.label === bc)?.value || 0);
        }

        return {
          bestClass: bestClasses,
          confidence: confidences,
          allScores: classifications.map(c => ({ classLabel: c.label, score: c.value })),
        };
      } catch (error: any) {
         throw new GMIError(`Naive Bayes classification failed for model '${modelId}': ${error.message}`, GMIErrorCode.PROCESSING_ERROR, { underlyingError: error });
      }
    } else {
      // Fallback to basic keyword matching if Naive Bayes not available/trained or other method specified
      console.warn(`StatisticalUtilityAI (ID: ${this.utilityId}): Method '${options.method}' or Naive Bayes model '${modelId}' not ready. Falling back to basic keyword matching for classification.`);
      // Simplified keyword matching
      const textLower = textToClassify.toLowerCase();
      let bestMatch = options.candidateClasses[0] || "unknown";
      let maxScore = 0;
      const allScoresRaw: ClassificationScore[] = [];

      for (const className of options.candidateClasses) {
          let score = 0;
          className.toLowerCase().split(' ').forEach(keyword => {
              if (textLower.includes(keyword)) score++;
          });
          allScoresRaw.push({classLabel: className, score});
          if (score > maxScore) {
              maxScore = score;
              bestMatch = className;
          }
      }
      const totalScores = allScoresRaw.reduce((s, item) => s + item.score, 0);
      return {
          bestClass: bestMatch,
          confidence: totalScores > 0 ? maxScore / totalScores : 0.1,
          allScores: allScoresRaw.map(s => ({...s, score: totalScores > 0 ? s.score/totalScores : 0})),
      };
    }
  }

  public async extractKeywords(textToAnalyze: string, options?: KeywordExtractionOptions): Promise<string[]> {
    this.ensureInitialized();
    const maxKeywords = options?.maxKeywords || 5;
    // 'natural' TfIdf is better with a corpus. For a single document, it's term frequency.
    const tfidf = new natural.TfIdf();
    tfidf.addDocument(textToAnalyze.toLowerCase());
    const terms = tfidf.listTerms(0) // document index 0
                   .sort((a,b) => b.tfidf - a.tfidf) // Sort by score
                   .slice(0, maxKeywords)
                   .map(item => item.term);
    return terms;
  }

  public async tokenize(text: string, options?: TokenizationOptions): Promise<string[]> {
    this.ensureInitialized();
    let processedText = text;
    const shouldLowerCase = options?.type === 'sentence' ? false : options?.toLowerCase !== false;
    if (shouldLowerCase) processedText = processedText.toLowerCase(); // Default true for word tokenization

    if (options?.type === 'sentence') {
      return this.tokenizers.sentence.tokenize(processedText) || [];
    }
    // Default to word tokenization
    let tokens = this.tokenizers.word.tokenize(processedText) || [];
    if (options?.removePunctuation !== false) { // Default true for words
        // More robust punctuation removal needed than simple regex for all cases
        tokens = tokens.map(token => token.replace(/[^\w\s'-]|(?<!\w)-(?!\w)|(?<!\w)'(?!\w)/g, "")).filter(Boolean);
    }
    return tokens;
  }

  public async stemTokens(tokens: string[], options?: StemmingOptions): Promise<string[]> {
    this.ensureInitialized();
    const stemmer = this.getStemmer(options?.algorithm, options?.language);
    return tokens.map(token => stemmer.stem(token));
  }

  public async calculateSimilarity(text1: string, text2: string, options?: SimilarityOptions): Promise<number> {
    this.ensureInitialized();
    const method = options?.method || 'cosine_tfidf';
    const lang = options?.language || this.config.defaultLanguage || 'en';
    const stemAlgo = 'porter'; // Default for 'natural' based similarity

    let tokens1 = await this.tokenize(text1, { language: lang, toLowerCase: true, removePunctuation: true });
    let tokens2 = await this.tokenize(text2, { language: lang, toLowerCase: true, removePunctuation: true });

    if (options?.removeStopWords !== false) { // Default true
        const stopWordsSet = this.getStopWords(lang);
        tokens1 = tokens1.filter(t => !stopWordsSet.has(t));
        tokens2 = tokens2.filter(t => !stopWordsSet.has(t));
    }
    if (options?.stem !== false) { // Default true
        const stemmer = this.getStemmer(stemAlgo, lang);
        tokens1 = tokens1.map(t => stemmer.stem(t));
        tokens2 = tokens2.map(t => stemmer.stem(t));
    }

    if (method === 'jaccard') {
      const set1 = new Set(tokens1);
      const set2 = new Set(tokens2);
      if (set1.size === 0 && set2.size === 0) {
        return 1;
      }
      let intersectionCount = 0;
      set1.forEach(token => {
        if (set2.has(token)) {
          intersectionCount++;
        }
      });
      const unionCount = new Set([...set1, ...set2]).size;
      return unionCount === 0 ? 0 : intersectionCount / unionCount;
    } else if (method === 'levenshtein') {
      const distance = natural.LevenshteinDistance(text1, text2);
      const maxLength = Math.max(text1.length, text2.length);
      return maxLength === 0 ? 1 : 1 - (distance / maxLength);
    } else if (method === 'cosine_tfidf') {
      const tfidf = new natural.TfIdf();
      if (options?.corpusForIDF && options.corpusForIDF.length > 0) {
          options.corpusForIDF.forEach(doc => tfidf.addDocument(doc.toLowerCase()));
      }
      tfidf.addDocument(tokens1.join(' '));
      tfidf.addDocument(tokens2.join(' '));
      // Get vectors for the last two added documents (text1, text2)
      // This requires careful indexing if a corpus was also added.
      // Assuming text1 is doc N-2 and text2 is doc N-1 if corpus added before them.
      // If no corpus, text1 is doc 0, text2 is doc 1.
      const docIndex1 = (options?.corpusForIDF?.length || 0) + 0;
      const docIndex2 = (options?.corpusForIDF?.length || 0) + 1;

      // This part is tricky with 'natural'. We need to construct vectors manually.
      const termsInDoc1 = new Map(tfidf.listTerms(docIndex1).map(t => [t.term, t.tfidf]));
      const termsInDoc2 = new Map(tfidf.listTerms(docIndex2).map(t => [t.term, t.tfidf]));
      const allTerms = new Set<string>([...termsInDoc1.keys(), ...termsInDoc2.keys()]);
      
      const vecA: number[] = [];
      const vecB: number[] = [];
      allTerms.forEach(term => {
          vecA.push(termsInDoc1.get(term) || 0);
          vecB.push(termsInDoc2.get(term) || 0);
      });
      return this.computeCosineSimilarity(vecA, vecB);
    }
    throw new GMIError(`Similarity method '${method}' not supported or fully implemented by StatisticalUtilityAI.`, GMIErrorCode.NOT_SUPPORTED);
  }

  public async analyzeSentiment(text: string, options?: SentimentAnalysisOptions): Promise<SentimentResult> {
    this.ensureInitialized();
    const lang = options?.language || this.config.sentimentConfig?.defaultLexiconLanguage || this.config.defaultLanguage || 'en';
    const analyzer = this.getSentimentAnalyzer(lang);
    const tokens = await this.tokenize(text, { language: lang, toLowerCase: true }); // Keep punctuation for sentiment context
    const stemmedTokensForSentiment = (await this.stemTokens(tokens, { algorithm: 'porter', language: lang })); // 'natural' sentiment analyzer uses stemming

    const score = analyzer.getSentiment(stemmedTokensForSentiment); // This is the 'comparative' score in 'natural'
    
    let polarity: 'positive' | 'negative' | 'neutral' = 'neutral';
    if (score > 0.05) polarity = 'positive'; // Thresholds from 'natural' are typically small
    else if (score < -0.05) polarity = 'negative';

    // 'natural' doesn't easily give positive/negative tokens or overall score.
    // This is a more manual approximation based on the lexicon if available.
    let detailedScore = 0;
    const positiveTokens: Array<{ token: string; score: number }> = [];
    const negativeTokens: Array<{ token: string; score: number }> = [];
    const analyzerEntry = this.sentimentAnalyzers.get(lang);
    const lexicon = analyzerEntry ? ((analyzerEntry as any).vocabulary as Record<string, number> | undefined) : undefined;

    if (lexicon) {
        tokens.forEach(t => {
            const tokenScore = lexicon[t.toLowerCase()];
            if (tokenScore !== undefined) {
                detailedScore += tokenScore;
                if (tokenScore > 0) positiveTokens.push({token: t, score: tokenScore});
                else if (tokenScore < 0) negativeTokens.push({token: t, score: tokenScore});
            }
        });
    }


    return {
      score: detailedScore || score, // Use detailed if available, else analyzer's overall
      polarity,
      comparative: score, // 'natural' getSentiment result is comparative
      positiveTokens,
      negativeTokens,
      neutralTokens: [], // Not easily extracted from 'natural'
      intensity: Math.abs(score),
    };
  }

  /**
   * Detect the language of a text string using trigram frequency analysis.
   *
   * Uses a Cavnar & Trenkle style algorithm that compares the input text's
   * trigram frequency profile against pre-computed reference profiles for 20+
   * languages.  Accuracy improves with longer text; passages under 10
   * characters return `'und'` (undetermined).
   *
   * @param text    - The input text to analyse.
   * @param options - `maxCandidates` controls how many ranked results to
   *                  return (default 3).  The `method` field is accepted but
   *                  only `'n_gram'` (the default) is supported by this
   *                  statistical implementation.
   * @returns Ranked array of `{ language, confidence }` where `language` is
   *          an ISO 639-1 code (e.g. `'en'`, `'fr'`) and `confidence` is
   *          in the range 0-1.
   */
  public async detectLanguage(text: string, options?: LanguageDetectionOptions): Promise<LanguageDetectionResult[]> {
    this.ensureInitialized();

    const maxCandidates = options?.maxCandidates ?? 3;

    // Short-circuit: if the text is too short for reliable detection, fall
    // back to the configured default language with low confidence.
    if (!text || text.trim().length < 10) {
      return [{ language: this.config.defaultLanguage || 'en', confidence: 0.1 }];
    }

    const results = detectLanguageTrigram(text, { maxCandidates });

    // If detection returned 'und', fall back to the default language.
    if (results.length === 1 && results[0].language === 'und') {
      return [{ language: this.config.defaultLanguage || 'en', confidence: 0.1 }];
    }

    return results;
  }

  public async normalizeText(text: string, options?: TextNormalizationOptions): Promise<string> {
    this.ensureInitialized();
    let normalizedText = text;
    const lang = options?.language || this.config.defaultLanguage || 'en';

    if (options?.stripHtml) {
        normalizedText = normalizedText.replace(/<[^>]+>/g, ' ');
    }
    if (options?.toLowerCase !== false) {
      normalizedText = normalizedText.toLowerCase();
    }
    if (options?.expandContractions) { // Basic, language-dependent
        if (lang === 'en') {
            normalizedText = normalizedText.replace(/\bwon't\b/g, "will not")
              .replace(/\bcan't\b/g, "cannot").replace(/\bain't\b/g, "am not") // Example
              .replace(/\bn't\b/g, " not").replace(/\b're\b/g, " are")
              .replace(/\b's\b/g, " is").replace(/\b'd\b/g, " would") // Ambiguous ('s, 'd)
              .replace(/\b'll\b/g, " will").replace(/\b've\b/g, " have")
              .replace(/\b'm\b/g, " am");
        }
    }
    if (options?.removePunctuation) {
      normalizedText = normalizedText.replace(/[.,/#!$%^&*;:{}=\-_`~()?"]/g, " ");
    }
    
    // Tokenize for stop word removal and stemming
    let tokens = this.tokenizers.word.tokenize(normalizedText) || [];

    if (options?.removeStopWords) {
      tokens = tokens.filter(token => !this.getStopWords(lang).has(token));
    }
    if (options?.stem) {
      const stemmer = this.getStemmer(options.stemAlgorithm, lang);
      tokens = tokens.map(token => stemmer.stem(token));
    }
     if (options?.replaceNumbersWith !== undefined) {
        const replacement = options.replaceNumbersWith;
        tokens = tokens.map(token => /^\d+(\.\d+)?$/.test(token) ? (replacement === null ? "" : replacement) : token).filter(t => replacement !== null || t !== "");
    }

    normalizedText = tokens.join(" ").replace(/\s+/g, ' ').trim(); // Consolidate spaces
    return normalizedText;
  }

  public async generateNGrams(tokens: string[], options: NGramOptions): Promise<Record<number, string[][]>> {
    this.ensureInitialized();
    const nValues = Array.isArray(options.n) ? options.n : [options.n];
    const result: Record<number, string[][]> = {};
    const Ngram = natural.NGrams; // Access Ngrams methods

    nValues.forEach(n => {
      if (n <= 0) {
        result[n] = [];
        return;
      }
      if (options.includePartial) {
          // 'natural' NGrams.ngrams doesn't directly support partials at the end in a simple way.
          // This would need custom logic if strictly required. For now, use standard n-gram generation.
          console.warn("StatisticalUtilityAI.generateNGrams: includePartial=true is not fully supported by 'natural' Ngrams, will generate full N-grams only.");
      }
      result[n] = Ngram.ngrams(tokens, n);
    });
    return result;
  }

  public async calculateReadability(text: string, options: ReadabilityOptions): Promise<ReadabilityResult> {
    this.ensureInitialized();
    // Uses Flesch-Kincaid formulas with a pattern-aware syllable counter.
    // Syllable counting handles silent-e, -es/-ed suffixes, consonant+le, and -tion/-sion.

    const sentences = (this.tokenizers.sentence.tokenize(text) || [text]).filter(s => s.trim().length > 0);
    const words = (this.tokenizers.word.tokenize(text.toLowerCase()) || []).filter(w => /^[a-z']+$/.test(w) && w.length > 0); // Basic word filter
    const numSentences = Math.max(1, sentences.length);
    const numWords = Math.max(1, words.length);

    const countSyllablesApprox = (word: string): number => {
      const w = word.toLowerCase().replace(/[^a-z]/g, '');
      if (!w) return 0;
      if (w.length <= 3) return 1;

      let count = 0;
      const vowels = 'aeiouy';
      let prevVowel = false;

      for (let i = 0; i < w.length; i++) {
        const isVowel = vowels.includes(w[i]);
        if (isVowel && !prevVowel) count++;
        prevVowel = isVowel;
      }

      // Adjust for common patterns
      if (w.endsWith('e') && !w.endsWith('le')) count--;
      if (w.endsWith('es') || w.endsWith('ed')) {
        if (w.length > 4 && !('dt'.includes(w[w.length - 3]))) count--;
      }
      if (w.endsWith('le') && w.length > 2 && !vowels.includes(w[w.length - 3])) count++;
      if (w.endsWith('tion') || w.endsWith('sion')) count--;

      return Math.max(1, count);
    };
    const numSyllables = Math.max(1, words.reduce((sum, word) => sum + countSyllablesApprox(word), 0));

    let score = 0;
    const interpretation = "Score interpretation unavailable for placeholder.";
    let gradeLevel: string | undefined = "N/A";

    switch (options.formula) {
        case 'flesch_kincaid_reading_ease':
            score = 206.835 - 1.015 * (numWords / numSentences) - 84.6 * (numSyllables / numWords);
            break;
        case 'flesch_kincaid_grade_level':
            score = 0.39 * (numWords / numSentences) + 11.8 * (numSyllables / numWords) - 15.59;
            gradeLevel = `Approx. Grade ${Math.max(0,Math.round(score))}`;
            break;
        // Add other formulas if you implement them
        default:
            throw new GMIError(`Readability formula '${options.formula}' not implemented in StatisticalUtilityAI.`, GMIErrorCode.NOT_SUPPORTED);
    }
    return { score: parseFloat(score.toFixed(2)), interpretation, gradeLevel };
  }


  public async checkHealth(): Promise<{ isHealthy: boolean; details?: any; dependencies?: Array<{name: string; isHealthy: boolean; details?: any}> }> {
    // Basic check, can be expanded (e.g., verify resource files loaded)
    return {
      isHealthy: this.isInitialized,
      details: {
        utilityId: this.utilityId,
        status: this.isInitialized ? 'Initialized' : 'Not Initialized',
        defaultLanguage: this.config?.defaultLanguage,
        loadedStopWordLanguages: Array.from(this.stopWords.keys()),
        loadedClassifierModels: Array.from(this.classifiers.keys()),
        loadedSentimentAnalyzers: Array.from(this.sentimentAnalyzers.keys()),
      }
    };
  }

  // --- Model Training/Management for Naive Bayes Classifier ---
  public async trainModel(
    trainingData: Array<{ text: string; label: string }>,
    modelType: string, // e.g., "text_classifier_naive_bayes"
    trainingOptions?: { modelId?: string; stemmer?: 'porter' | 'lancaster'; alpha?: number }
  ): Promise<{ success: boolean; message?: string; modelId?: string }> {
    this.ensureInitialized();
    if (modelType.toLowerCase() !== 'text_classifier_naive_bayes') {
      return { success: false, message: `Model type '${modelType}' not supported for training by StatisticalUtilityAI.` };
    }

    const modelId = trainingOptions?.modelId || 'default_bayes_classifier';
    const stemmerAlgo = trainingOptions?.stemmer || 'porter';
    const stemmer = this.getStemmer(stemmerAlgo);
    const alpha = trainingOptions?.alpha || this.config.classifierConfig?.naiveBayes?.defaultAlpha || 0.05;
    
    const classifier = new (natural.BayesClassifier as any)(stemmer, alpha);
    console.log(`StatisticalUtilityAI (ID: ${this.utilityId}): Training Naive Bayes classifier '${modelId}' with ${trainingData.length} samples.`);

    for (const item of trainingData) {
      // Basic tokenization for training; consider using this.tokenize for consistency if options differ
      const tokens = this.tokenizers.word.tokenize(item.text.toLowerCase());
      if (tokens) {
        classifier.addDocument(tokens, item.label);
      }
    }
    try {
        classifier.train();
        this.classifiers.set(modelId, classifier);
        console.log(`StatisticalUtilityAI (ID: ${this.utilityId}): Naive Bayes classifier '${modelId}' training complete.`);
        return { success: true, message: `Model '${modelId}' trained successfully.`, modelId };
    } catch (error: any) {
        console.error(`StatisticalUtilityAI (ID: ${this.utilityId}): Error training Naive Bayes classifier '${modelId}': ${error.message}`);
        return { success: false, message: `Training failed: ${error.message}`};
    }
  }

  public async saveTrainedModel(modelId: string, modelType?: string, storagePath?: string): Promise<{ success: boolean; pathOrStoreId?: string; message?: string }> {
    this.ensureInitialized();
    const typeToSave = modelType || 'text_classifier_naive_bayes'; // Assume default if not given
    if (typeToSave.toLowerCase() !== 'text_classifier_naive_bayes') {
        return { success: false, message: `Saving model type '${typeToSave}' not supported.` };
    }

    const classifier = this.classifiers.get(modelId);
    if (!classifier) {
      return { success: false, message: `Classifier model ID '${modelId}' not found for saving.` };
    }

    const savePath = storagePath || (this.config.classifierConfig?.naiveBayes?.modelStoragePath ? path.join(this.config.classifierConfig.naiveBayes.modelStoragePath, `${modelId}.nbc.json`) : `${modelId}.nbc.json`);

    return new Promise((resolve) => {
      // 'natural' BayesClassifier.save uses a callback
      classifier.save(savePath, (err, _savedClassifier) => {
        if (err) {
          console.error(`StatisticalUtilityAI (ID: ${this.utilityId}): Error saving Naive Bayes model '${modelId}' to '${savePath}':`, err);
          resolve({ success: false, message: `Failed to save model: ${err.message || 'Unknown error'}` });
        } else {
          console.log(`StatisticalUtilityAI (ID: ${this.utilityId}): Naive Bayes model '${modelId}' saved to '${savePath}'.`);
          resolve({ success: true, pathOrStoreId: savePath, message: 'Model saved successfully.' });
        }
      });
    });
  }

  public async loadTrainedModel(modelId: string, modelType?: string, storagePath?: string): Promise<{ success: boolean; message?: string }> {
    this.ensureInitialized();
     const typeToLoad = modelType || 'text_classifier_naive_bayes';
    if (typeToLoad.toLowerCase() !== 'text_classifier_naive_bayes') {
        return { success: false, message: `Loading model type '${typeToLoad}' not supported.` };
    }

    const loadPath = storagePath || (this.config.classifierConfig?.naiveBayes?.modelStoragePath ? path.join(this.config.classifierConfig.naiveBayes.modelStoragePath, `${modelId}.nbc.json`) : `${modelId}.nbc.json`);

    return new Promise((resolve) => {
      (natural.BayesClassifier as any).load(loadPath, this.getStemmer('porter'), (err: any, classifier: natural.BayesClassifier) => {
        if (err || !classifier) {
          console.error(`StatisticalUtilityAI (ID: ${this.utilityId}): Error loading Naive Bayes model '${modelId}' from '${loadPath}':`, err);
          resolve({ success: false, message: `Failed to load model: ${err?.message || 'Classifier could not be loaded.'}` });
        } else {
          this.classifiers.set(modelId, classifier);
          console.log(`StatisticalUtilityAI (ID: ${this.utilityId}): Naive Bayes model '${modelId}' loaded from '${loadPath}'.`);
          resolve({ success: true, message: 'Model loaded successfully.' });
        }
      });
    });
  }

  private computeCosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length === 0 || vecB.length === 0 || vecA.length !== vecB.length) {
      return 0;
    }
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < vecA.length; i++) {
      const a = vecA[i];
      const b = vecB[i];
      dot += a * b;
      magA += a * a;
      magB += b * b;
    }
    if (magA === 0 || magB === 0) {
      return 0;
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }

  public async parseJsonSafe<T = any>(jsonString: string, options?: ParseJsonOptions<T>): Promise<T | null> {
    this.ensureInitialized();
    if (typeof jsonString !== 'string' || jsonString.trim().length === 0) {
      return null;
    }
    try {
      return JSON.parse(jsonString) as T;
    } catch (error: any) {
      console.warn(`StatisticalUtilityAI (ID: ${this.utilityId}): JSON parse failed.`, error?.message || error);
      if (options?.attemptFixWithLLM) {
        console.warn(`StatisticalUtilityAI: attemptFixWithLLM=true but LLM-based repair is not supported in this implementation.`);
      }
      return null;
    }
  }
  
  public async shutdown(): Promise<void> {
    this.isInitialized = false;
    // Clear any resources, though 'natural' instances are mostly self-contained.
    this.classifiers.clear();
    this.sentimentAnalyzers.clear();
    this.stopWords.clear();
    console.log(`StatisticalUtilityAI (ID: ${this.utilityId}) shut down.`);
  }
}
