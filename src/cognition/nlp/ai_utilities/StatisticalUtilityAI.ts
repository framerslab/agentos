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
import * as naturalModule from 'natural';
import { GMIError, GMIErrorCode } from '../../../core/utils/errors.js';
import type { SchemaCheck } from '../../../core/utils/schemaChecks';
import { detectLanguageTrigram } from './trigram-language-profiles';
import { targetSchemaChecks } from './targetSchemaChecks';

/**
 * The `natural` library's runtime members.
 *
 * `natural` is CommonJS and builds its exports at run time
 * (`module.exports = buildExportMap([...])`), so Node's ESM loader cannot name
 * them: under plain Node, where this package's built ESM runs (a consumer that
 * keeps `@framers/agentos` external to its bundle), a namespace import holds
 * only `default`, and `new naturalModule.WordTokenizer()` throws
 * "is not a constructor". Bundlers and Vitest hand the members over on the
 * namespace itself. Read them from `default` when that is where they are; the
 * namespace import stays the source of the types.
 */
const natural: typeof naturalModule =
  (naturalModule as unknown as { default?: typeof naturalModule }).default ?? naturalModule;

/** A sentiment lexicon `natural` ships. AFINN scores a word from -5 to 5; pattern and senticon from -1 to 1. */
export type SentimentLexiconName = 'afinn' | 'afinnFinancialMarketNews' | 'pattern' | 'senticon';

/** The largest value a word takes in each lexicon `natural` ships. */
const SENTIMENT_LEXICON_SCALE: Record<SentimentLexiconName, number> = {
  afinn: 5,
  afinnFinancialMarketNews: 5,
  pattern: 1,
  senticon: 1,
};

/**
 * The languages `natural` holds a sentiment lexicon for, by language code: `natural`'s name for the language and
 * its lexicons there, the first one the lexicon a call scores with unless it names another.
 */
const SENTIMENT_LANGUAGES: Record<string, { name: string; lexicons: readonly SentimentLexiconName[] }> = {
  en: { name: 'English', lexicons: ['afinn', 'senticon', 'pattern', 'afinnFinancialMarketNews'] },
  es: { name: 'Spanish', lexicons: ['afinn', 'senticon'] },
  pt: { name: 'Portuguese', lexicons: ['afinn'] },
  fr: { name: 'French', lexicons: ['pattern'] },
  de: { name: 'German', lexicons: ['pattern'] },
  it: { name: 'Italian', lexicons: ['pattern'] },
  nl: { name: 'Dutch', lexicons: ['pattern'] },
  ca: { name: 'Catalan', lexicons: ['senticon'] },
  eu: { name: 'Basque', lexicons: ['senticon'] },
  gl: { name: 'Galician', lexicons: ['senticon'] },
};

/**
 * The normalization VADER gives its compound score: a sum `s` of word values maps into -1 to 1 as
 * `s / sqrt(s * s + 15)` (Hutto and Gilbert, 2014; `normalize()` in vaderSentiment, alpha 15). Here `s` is on AFINN's
 * scale, -5 to 5 a word, where VADER's own lexicon runs from -4 to 4.
 */
const SENTIMENT_NORMALIZATION_ALPHA = 15;
/** The largest value of a word in AFINN: pattern and senticon values, -1 to 1, are multiplied by it before the sum. */
const AFINN_SCALE = 5;
/**
 * A negation flips the sign of the lexicon entries that start among the next this many words of its clause. VADER
 * looks as far back for a negation; it scales the value by -0.74 where this flips it whole.
 */
const NEGATION_REACH = 3;
/** The marks that end a clause, and with it the reach of a negation. */
const CLAUSE_END = /[.,;:!?…]+/u;
/** A word for sentiment: letters, combining marks and digits, an apostrophe inside it kept, as in `don't`. */
const SENTIMENT_WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:'[\p{L}\p{M}\p{N}]+)*/gu;

/**
 * A sentiment lexicon ready to score with. A word scores only in a form the lexicon lists: AFINN and pattern list
 * inflected forms, senticon lists lemmas, and no word is stemmed, since a stem shared with a listed word (`lives`
 * and `lively`) carries none of its meaning.
 */
interface SentimentLexicon {
  /** Each listed entry of one word, in the form {@link sentimentKey} gives, with its value. */
  words: Map<string, number>;
  /**
   * Each listed entry of two words or more (`can't stand`, `well-being`), its words in the form {@link sentimentKey}
   * gives joined by one space, with its value.
   */
  phrases: Map<string, number>;
  /** The most words an entry of {@link SentimentLexicon.phrases} holds; 0 when there is none. */
  longestPhrase: number;
  /** The language's negation words. */
  negations: ReadonlySet<string>;
  /** Whether a word ending in `n't` negates, as in English. */
  contractedNegation: boolean;
  /** The largest value a word can take on the lexicon's scale: 5 for AFINN and a lexicon file, 1 for pattern and senticon. */
  scale: number;
}

/** A lexicon word or entry in the form the scorer compares: NFC, lower case, a curly apostrophe made straight. */
function sentimentKey(word: string): string {
  return word.normalize('NFC').toLowerCase().replace(/’/g, "'").trim();
}

/** The text's clauses, each as its words in the form {@link sentimentKey} gives. */
function sentimentClauses(text: string): string[][] {
  return sentimentKey(text)
    .split(CLAUSE_END)
    .map((clause) => clause.match(SENTIMENT_WORD) ?? [])
    .filter((words) => words.length > 0);
}

/**
 * Builds a lexicon from its entries and values, a later entry replacing an earlier one with the same words. An entry
 * is read into words as a text is, so `well-being` and `well being` are one phrase. A value that is not a finite number
 * is left out. `scale` is AFINN's, 5, unless given.
 */
function buildSentimentLexicon(
  entries: Iterable<[string, unknown]>,
  options: { negations?: Iterable<string>; contractedNegation: boolean; scale?: number },
): SentimentLexicon {
  const words = new Map<string, number>();
  const phrases = new Map<string, number>();
  let longestPhrase = 0;
  for (const [entry, value] of entries) {
    const number =
      typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
    if (!Number.isFinite(number)) continue;
    const parts = sentimentKey(entry).match(SENTIMENT_WORD) ?? [];
    if (parts.length === 1) {
      words.set(parts[0], number);
    } else if (parts.length > 1) {
      phrases.set(parts.join(' '), number);
      longestPhrase = Math.max(longestPhrase, parts.length);
    }
  }
  return {
    words,
    phrases,
    longestPhrase,
    negations: new Set(Array.from(options.negations ?? [], sentimentKey)),
    contractedNegation: options.contractedNegation,
    scale: options.scale ?? AFINN_SCALE,
  };
}

/** The phrase of the lexicon that starts at `at` in a clause, the longest when several do, or undefined. */
function sentimentPhraseAt(
  lexicon: SentimentLexicon,
  clause: readonly string[],
  at: number,
): { text: string; length: number; value: number } | undefined {
  for (let length = Math.min(lexicon.longestPhrase, clause.length - at); length >= 2; length -= 1) {
    const text = clause.slice(at, at + length).join(' ');
    const value = lexicon.phrases.get(text);
    if (value !== undefined) return { text, length, value };
  }
  return undefined;
}

/**
 * Reads a sentiment lexicon file: a JSON object of word to value, or one entry a line, the word, white space (a tab
 * in an AFINN file) and the value. Empty lines, lines that start with `#` and lines that end in no number are passed
 * over.
 *
 * @throws {SyntaxError} When a text that starts with `{` is not a JSON object.
 */
function parseSentimentLexicon(text: string): Array<[string, unknown]> {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SyntaxError('A sentiment lexicon in JSON must be an object of word to value.');
    }
    return Object.entries(parsed as Record<string, unknown>);
  }
  const entries: Array<[string, unknown]> = [];
  for (const line of text.split(/\r?\n/)) {
    const entry = /^\s*([^#\s].*?)\s+([-+]?\d+(?:\.\d+)?)\s*$/.exec(line);
    if (entry) entries.push([entry[1], Number(entry[2])]);
  }
  return entries;
}

/** Whether a value names one of the lexicons `natural` ships rather than a file. */
function isSentimentLexiconName(value: string): value is SentimentLexiconName {
  return Object.prototype.hasOwnProperty.call(SENTIMENT_LEXICON_SCALE, value);
}

/** The id `trainModel()` keeps a model under, and `classifyText()` asks for, unless the config or a call names one. */
const DEFAULT_BAYES_MODEL_ID = 'default_bayes_classifier';

/**
 * The class's word rule: a letter, a digit or an underscore, then letters, combining marks, digits and underscores, in
 * any script. It is the rule of `natural`'s word tokenizer (runs of `A-Z`, `a-z`, `0-9` and `_`, and the Cyrillic
 * `А-я`) for every script, so `café`, `straße` and `привет` stay whole words. An apostrophe or a hyphen ends a word,
 * as it does there: `don't` is `don` and `t`.
 */
const WORD = /[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*/gu;

/** A word made of decimal digits, in any script: `42`, and `٤٢` in Arabic-Indic digits. */
const DIGITS_WORD = /^\p{Nd}+$/u;

/** The words of a text by {@link WORD}, read in NFC so a letter and its accent are one either way they came. */
function wordsOf(text: string): string[] {
  return text.normalize('NFC').match(WORD) ?? [];
}

/** `natural`'s English stop words: `extractKeywords()` leaves them out, as `natural`'s TF-IDF does. */
const NATURAL_STOP_WORDS: ReadonlySet<string> = new Set(Array.isArray(natural.stopwords) ? natural.stopwords : []);

/**
 * The words a Naive Bayes model learns from an example, and reads in a text it classifies: the class's words (any
 * script) in lower case, less `natural`'s English stop words, each stemmed with the model's stemmer. `natural`'s own
 * reading keeps ASCII letters alone, so a text in another script would teach a model nothing.
 */
function bayesWords(text: string, stemmer: naturalModule.Stemmer): string[] {
  return wordsOf(text.toLowerCase())
    .filter((word) => !NATURAL_STOP_WORDS.has(word))
    .map((word) => stemmer.stem(word));
}

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
  /**
   * The folder a relative path in `customStopWordsPaths`, `sentimentConfig.lexiconPath` or a call's
   * `lexiconNameOrPath` is read under. Naive Bayes models are kept under `classifierConfig.naiveBayes.modelStoragePath`.
   */
  resourcePath?: string;

  /** Not read: stop words follow a call's `language`, else `defaultLanguage`. */
  defaultStopWordsLanguage?: string;
  /** A stop-word file for each language code, one word a line. */
  customStopWordsPaths?: Record<string, string>;

  /** Not read: `summarize()` answers the first sentences of a text. */
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
      defaultModelId?: string;   // Loaded at initialize() when saved; the id trainModel() and classifyText() use when a call names none
      defaultAlpha?: number;     // Laplace smoothing, default 0.05
    }
  };
  sentimentConfig?: {
    /**
     * A sentiment lexicon of your own: a JSON object of word to value, or one entry a line, the word, white space
     * and the value (an AFINN file). Its entries join the lexicon of `defaultLexiconLanguage`, each replacing the
     * built-in value of its word, and are read on that lexicon's scale: -5 to 5 where it is AFINN, -1 to 1 where it
     * is pattern or senticon. In a language `natural` has no lexicon for, they are the lexicon, read on AFINN's
     * scale. A relative path is read under `resourcePath`. A file that cannot be read or parsed logs a warning and
     * adds nothing.
     */
    lexiconPath?: string;
    /** The language a call that names none is scored in, and the language `lexiconPath` adds to. `defaultLanguage` unless given. */
    defaultLexiconLanguage?: string;
  };
  /** Not read: `detectLanguage()` uses the package's built-in profiles. */
  languageDetectionConfig?: {
    nGramProfilePath?: string;
  };
  /** Not read: syllables are counted by vowel groups. */
  readabilitySyllableAlgorithm?: 'regex_approx' | 'dictionary_lookup';
}

export class StatisticalUtilityAI implements IUtilityAI {
  public readonly utilityId: string;
  private config!: StatisticalUtilityAIConfig; // Make it fully required internally
  private isInitialized: boolean = false;

  private tokenizers: { word: naturalModule.WordTokenizer, sentence: naturalModule.SentenceTokenizer };
  private stemmers: Record<string, naturalModule.Stemmer>; // algorithm_name -> stemmer_instance
  private stopWords: Map<string, Set<string>>; // language -> Set<string>

  // For Naive Bayes classifier instances: modelId -> classifier
  private classifiers: Map<string, naturalModule.BayesClassifier>;
  /** The sentiment lexicons built so far: a language code, with a lexicon name or file after a colon when a call named one. */
  private sentimentLexicons: Map<string, SentimentLexicon>;
  /** The entries of `sentimentConfig.lexiconPath`, read by `initialize()`. */
  private customSentimentEntries: Array<[string, unknown]> = [];

  private createStemmerRegistry(): Record<string, naturalModule.Stemmer> {
    const registry: Record<string, naturalModule.Stemmer> = {
      porter: natural.PorterStemmer,
      lancaster: natural.LancasterStemmer,
    };

    const naturalWithVariants = natural as unknown as Record<string, unknown>;
    for (const [suffix, langCode] of Object.entries(NATURAL_STEMMER_LANGUAGE_KEYS)) {
      const porterVariant = naturalWithVariants[`PorterStemmer${suffix}`];
      if (porterVariant && typeof (porterVariant as naturalModule.Stemmer).stem === 'function') {
        registry[`porter_${langCode}`] = porterVariant as naturalModule.Stemmer;
      }
    }

    const carryFrench = naturalWithVariants.CarryStemmerFr;
    if (carryFrench && typeof (carryFrench as naturalModule.Stemmer).stem === 'function') {
      registry.carry_fr = carryFrench as naturalModule.Stemmer;
    }

    const stemmerId = naturalWithVariants.StemmerId;
    if (stemmerId && typeof (stemmerId as naturalModule.Stemmer).stem === 'function') {
      registry.default_id = stemmerId as naturalModule.Stemmer;
    }

    const stemmerJa = naturalWithVariants.StemmerJa;
    if (stemmerJa && typeof (stemmerJa as naturalModule.Stemmer).stem === 'function') {
      registry.default_ja = stemmerJa as naturalModule.Stemmer;
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
    this.sentimentLexicons = new Map();
  }

  public async initialize(config: StatisticalUtilityAIConfig): Promise<void> {
    if (this.isInitialized) {
      console.warn(`StatisticalUtilityAI (ID: ${this.utilityId}) already initialized. Re-initializing.`);
      // Clear any loaded resources before re-initializing if necessary
      this.stopWords.clear();
      this.stopWords.set('en', DEFAULT_ENGLISH_STOP_WORDS);
      this.classifiers.clear();
      this.sentimentLexicons.clear();
      this.customSentimentEntries = [];
    }
    const defaultLanguage = config.defaultLanguage || 'en';
    this.config = {
        ...config,
        defaultLanguage, // Default language for the utility itself
        summarizerConfig: { lexRank: { similarityThreshold: 0.1, dampingFactor: 0.85, maxIterations:100, epsilon:1e-4, ...config.summarizerConfig?.lexRank } },
        classifierConfig: { naiveBayes: { defaultAlpha: 0.05, ...config.classifierConfig?.naiveBayes } },
        sentimentConfig: { ...config.sentimentConfig, defaultLexiconLanguage: config.sentimentConfig?.defaultLexiconLanguage || defaultLanguage },
    };


    // Load custom stop words if configured
    if (this.config.customStopWordsPaths) {
      for (const [lang, filePath] of Object.entries(this.config.customStopWordsPaths)) {
        try {
          const stopWordsStr = await fs.readFile(this.resourceFile(filePath), 'utf-8');
          this.stopWords.set(lang.toLowerCase(), new Set(stopWordsStr.split(/\r?\n/).map(sw => sw.trim().toLowerCase()).filter(Boolean)));
          console.log(`StatisticalUtilityAI (ID: ${this.utilityId}): Loaded custom stop words for '${lang}' from ${filePath}.`);
        } catch (error: any) {
          console.warn(`StatisticalUtilityAI (ID: ${this.utilityId}): Failed to load custom stop words for '${lang}' from '${filePath}': ${error.message}. Using default if 'en'.`);
        }
      }
    }

    // Read the custom sentiment lexicon, then build the lexicon a call that names no language scores with.
    const lexiconPath = this.config.sentimentConfig?.lexiconPath;
    if (lexiconPath) {
      try {
        this.customSentimentEntries = parseSentimentLexicon(await fs.readFile(this.resourceFile(lexiconPath), 'utf-8'));
        console.log(`StatisticalUtilityAI (ID: ${this.utilityId}): Read ${this.customSentimentEntries.length} sentiment lexicon entries from ${lexiconPath}.`);
      } catch (error: any) {
        console.warn(`StatisticalUtilityAI (ID: ${this.utilityId}): Failed to read the sentiment lexicon '${lexiconPath}': ${error?.message}. It adds nothing.`);
      }
    }
    try {
      this.sentimentLexiconFor(this.config.sentimentConfig?.defaultLexiconLanguage || defaultLanguage);
    } catch (error: any) {
      console.warn(`StatisticalUtilityAI (ID: ${this.utilityId}): Failed to build the default sentiment lexicon: ${error?.message}.`);
    }

    // Load the default Naive Bayes model when the config names one and it was saved where the config says.
    const defaultModelId = this.config.classifierConfig?.naiveBayes?.defaultModelId;
    if (defaultModelId) {
      const loaded = await this.loadBayesModel(defaultModelId, this.bayesModelPath(defaultModelId));
      if (!loaded.success) {
        console.warn(`StatisticalUtilityAI (ID: ${this.utilityId}): Did not load the default Naive Bayes model '${defaultModelId}': ${loaded.message} Train it, or load it with loadTrainedModel().`);
      }
    }


    this.isInitialized = true;
    console.log(`StatisticalUtilityAI (ID: ${this.utilityId}) initialized.`);
  }

  /** A resource file's path: a relative one under `resourcePath` when it is set, an absolute one as given. */
  private resourceFile(filePath: string): string {
    return this.config.resourcePath && !path.isAbsolute(filePath) ? path.join(this.config.resourcePath, filePath) : filePath;
  }

  /** Where a Naive Bayes model is saved and loaded: the path given, else under `modelStoragePath`, else the working directory. */
  private bayesModelPath(modelId: string, storagePath?: string): string {
    if (storagePath) return storagePath;
    const folder = this.config.classifierConfig?.naiveBayes?.modelStoragePath;
    return folder ? path.join(folder, `${modelId}.nbc.json`) : `${modelId}.nbc.json`;
  }

  /** The id `trainModel()` keeps a model under and `classifyText()` asks for when a call names none. */
  private defaultBayesModelId(): string {
    return this.config.classifierConfig?.naiveBayes?.defaultModelId || DEFAULT_BAYES_MODEL_ID;
  }

  /**
   * Loads a saved Naive Bayes model under `modelId`, with the stemmer it was trained with (Porter for a model that
   * does not record one). The file is read and parsed here rather than by `natural`'s `load()`, which parses inside
   * a callback, where a file that is not JSON would throw past every caller.
   */
  private async loadBayesModel(modelId: string, loadPath: string): Promise<{ success: boolean; message?: string }> {
    let saved: unknown;
    try {
      saved = JSON.parse(await fs.readFile(loadPath, 'utf-8'));
    } catch (error: any) {
      return { success: false, message: `Failed to load model: ${error?.message || 'the file could not be read.'}` };
    }
    try {
      const stemmer = this.getStemmer((saved as { stemmerAlgorithm?: unknown })?.stemmerAlgorithm === 'lancaster' ? 'lancaster' : 'porter');
      const classifier: naturalModule.BayesClassifier = (natural.BayesClassifier as any).restore(saved, stemmer);
      this.classifiers.set(modelId, classifier);
      return { success: true, message: 'Model loaded successfully.' };
    } catch (error: any) {
      return { success: false, message: `Failed to load model: the file holds no Naive Bayes model (${error?.message}).` };
    }
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

  private getStemmer(algorithm?: string, language?: string): naturalModule.Stemmer {
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

  /** The language code of a BCP-47 tag: `en` for `en-GB`. */
  private static languageCode(language: string): string {
    return language.toLowerCase().split('-')[0];
  }

  /** A lexicon `natural` ships, as its words and values and the language's negation words. */
  private naturalSentimentLexicon(code: string, name: SentimentLexiconName): { entries: Array<[string, unknown]>; negations: string[] } {
    const language = SENTIMENT_LANGUAGES[code];
    // natural reads a language by its English name ('English'), never by its code ('en').
    const SentimentAnalyzer = natural.SentimentAnalyzer as unknown as new (
      language: string,
      stemmer: undefined,
      type: string,
    ) => { vocabulary: Record<string, unknown>; negations?: string[] };
    const analyzer = new SentimentAnalyzer(language.name, undefined, name);
    return { entries: Object.entries(analyzer.vocabulary), negations: analyzer.negations ?? [] };
  }

  /** The negation words `natural` lists for a language, none for a language it has no lexicon for. */
  private sentimentNegations(code: string): string[] {
    const language = SENTIMENT_LANGUAGES[code];
    return language ? this.naturalSentimentLexicon(code, language.lexicons[0]).negations : [];
  }

  /**
   * The lexicon a call scores with when it names none: the first lexicon `natural` holds for the language, with the
   * entries of `sentimentConfig.lexiconPath` in the language `defaultLexiconLanguage` names. A language with neither
   * scores every text 0, and its first call logs a warning.
   */
  private sentimentLexiconFor(language: string): SentimentLexicon {
    const code = StatisticalUtilityAI.languageCode(language);
    const cached = this.sentimentLexicons.get(code);
    if (cached) return cached;
    const support = SENTIMENT_LANGUAGES[code];
    const custom =
      code === StatisticalUtilityAI.languageCode(this.config.sentimentConfig?.defaultLexiconLanguage || this.config.defaultLanguage || 'en')
        ? this.customSentimentEntries
        : [];
    const builtIn = support ? this.naturalSentimentLexicon(code, support.lexicons[0]) : { entries: [], negations: [] };
    const lexicon = buildSentimentLexicon([...builtIn.entries, ...custom], {
      negations: builtIn.negations,
      contractedNegation: code === 'en',
      scale: support ? SENTIMENT_LEXICON_SCALE[support.lexicons[0]] : undefined,
    });
    if (lexicon.words.size === 0) {
      console.warn(`StatisticalUtilityAI (ID: ${this.utilityId}): No sentiment lexicon for '${code}'; its texts score 0.`);
    } else {
      console.log(
        `StatisticalUtilityAI (ID: ${this.utilityId}): Built the sentiment lexicon for '${code}' (${support ? support.lexicons[0] : 'custom'}, ${lexicon.words.size} words).`,
      );
    }
    this.sentimentLexicons.set(code, lexicon);
    return lexicon;
  }

  /** The lexicon a call names: one `natural` ships, or a file, read under `resourcePath` when relative, which is the lexicon alone. */
  private async namedSentimentLexicon(language: string, nameOrPath: string): Promise<SentimentLexicon> {
    const code = StatisticalUtilityAI.languageCode(language);
    if (isSentimentLexiconName(nameOrPath)) {
      const key = `${code}:${nameOrPath}`;
      const cached = this.sentimentLexicons.get(key);
      if (cached) return cached;
      if (!SENTIMENT_LANGUAGES[code]?.lexicons.includes(nameOrPath)) {
        throw new GMIError(
          `The sentiment lexicon '${nameOrPath}' has no '${code}' version.`,
          GMIErrorCode.NOT_SUPPORTED,
          { language: code, lexicon: nameOrPath },
        );
      }
      const builtIn = this.naturalSentimentLexicon(code, nameOrPath);
      const lexicon = buildSentimentLexicon(builtIn.entries, {
        negations: builtIn.negations,
        contractedNegation: code === 'en',
        scale: SENTIMENT_LEXICON_SCALE[nameOrPath],
      });
      this.sentimentLexicons.set(key, lexicon);
      return lexicon;
    }
    const file = this.resourceFile(nameOrPath);
    const key = `${code}:${file}`;
    const cached = this.sentimentLexicons.get(key);
    if (cached) return cached;
    let entries: Array<[string, unknown]>;
    try {
      entries = parseSentimentLexicon(await fs.readFile(file, 'utf-8'));
    } catch (error: any) {
      throw new GMIError(
        `Could not read the sentiment lexicon '${nameOrPath}': ${error?.message}`,
        GMIErrorCode.RESOURCE_NOT_FOUND,
        { lexicon: nameOrPath },
      );
    }
    const lexicon = buildSentimentLexicon(entries, {
      negations: this.sentimentNegations(code),
      contractedNegation: code === 'en',
    });
    this.sentimentLexicons.set(key, lexicon);
    return lexicon;
  }


  /**
   * The first sentences of the text, joined by spaces.
   *
   * How many: 3 unless `desiredLength` says otherwise. `'short'` is 2, `'medium'` 30 percent of the sentences and at
   * least 3, `'long'` half of them and at least 4. A number of 1 or less is a fraction of the sentences, rounded, so
   * 0 asks for none; a larger number is a count; a number that is not a number (`NaN`) keeps the default. At least
   * 1 sentence and at most all of them.
   *
   * `method: 'first_n_sentences'` does this, and so does the default, `'extractive_sentence_rank'`, after a warning.
   *
   * @throws {GMIError} `NOT_SUPPORTED` for any other method.
   */
  public async summarize(textToSummarize: string, options?: SummarizationOptions): Promise<string> {
    this.ensureInitialized();
    const method = options?.method || 'extractive_sentence_rank'; // 'natural' does not have built-in LexRank.

    if (method === 'first_n_sentences') {
      const sentences = this.tokenizers.sentence.tokenize(textToSummarize);
      if (!sentences || sentences.length === 0) return "";
      let numSentences = 3; // Default
      const desiredLength = options?.desiredLength;
      if (desiredLength === 'short') numSentences = 2;
      else if (desiredLength === 'medium') numSentences = Math.max(3, Math.floor(sentences.length * 0.3));
      else if (desiredLength === 'long') numSentences = Math.max(4, Math.floor(sentences.length * 0.5));
      else if (typeof desiredLength === 'number' && !Number.isNaN(desiredLength)) {
        // 0 is a fraction too: none of the sentences, held to the one sentence a summary keeps.
        numSentences = desiredLength <= 1 ? Math.round(desiredLength * sentences.length) : desiredLength;
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

  /**
   * Classifies a text. With `method: 'naive_bayes'` and a model trained or loaded under `modelId` (else
   * `classifierConfig.naiveBayes.defaultModelId`, else `'default_bayes_classifier'`, the id `trainModel()` uses), the
   * model reads the text as it read its examples (the class's words in any script, lower case, `natural`'s English
   * stop words left out, each stemmed with the stemmer the model learned with; `language` is not read) and answers
   * its classes, best first. Otherwise it logs a warning and scores each candidate class by the words of its name
   * (split at white space) found in the lower-cased text, inside a longer word too.
   */
  public async classifyText(textToClassify: string, options: ClassificationOptions): Promise<ClassificationResult> {
    this.ensureInitialized();
    const modelId = options.modelId || this.defaultBayesModelId();
    const classifier = this.classifiers.get(modelId);

    if (options.method === 'naive_bayes' && classifier) {
      try {
        // The reading trainModel() taught the model with, so the text and the examples share words.
        const classifications = classifier.getClassifications(bayesWords(textToClassify, classifier.stemmer));

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
          // Split at white space, so a doubled or trailing space adds no empty keyword, which every text holds.
          className.toLowerCase().split(/\s+/).filter(Boolean).forEach(keyword => {
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

  /**
   * The text's most frequent words, most frequent first, a tie in the order the words first appear: 5 unless
   * `maxKeywords` says otherwise. The words are the class's (any script, lower case), less `natural`'s English stop
   * words and the class's stop words for `language` (else `defaultLanguage`): the built-in English list, or the list
   * `customStopWordsPaths` gave the language. A TF-IDF over the one text would rank them the same, since every word
   * of a single text has the same inverse document frequency.
   */
  public async extractKeywords(textToAnalyze: string, options?: KeywordExtractionOptions): Promise<string[]> {
    this.ensureInitialized();
    const maxKeywords = options?.maxKeywords || 5;
    const stopWords = this.getStopWords(options?.language);
    const counts = new Map<string, number>();
    for (const word of wordsOf(textToAnalyze.toLowerCase())) {
      if (NATURAL_STOP_WORDS.has(word) || stopWords.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    // A stable sort keeps the first-appearance order among words with the same count.
    return Array.from(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxKeywords)
      .map(([word]) => word);
  }

  /**
   * Words by the class's word rule (a letter, digit or underscore, then letters, marks, digits and underscores, in any
   * script), lower-cased unless `toLowerCase: false`. A word never holds punctuation, so `removePunctuation` changes
   * nothing. With `type: 'sentence'`, the sentences from `natural`'s sentence tokenizer, case kept unless
   * `toLowerCase: true`.
   */
  public async tokenize(text: string, options?: TokenizationOptions): Promise<string[]> {
    this.ensureInitialized();
    if (options?.type === 'sentence') {
      const sentences = this.tokenizers.sentence.tokenize(options.toLowerCase === true ? text.toLowerCase() : text) || [];
      return sentences;
    }
    return wordsOf(options?.toLowerCase === false ? text : text.toLowerCase());
  }

  public async stemTokens(tokens: string[], options?: StemmingOptions): Promise<string[]> {
    this.ensureInitialized();
    const stemmer = this.getStemmer(options?.algorithm, options?.language);
    return tokens.map(token => stemmer.stem(token));
  }

  /**
   * A similarity from 0 to 1. `'jaccard'` and `'cosine_tfidf'` (the default) compare the texts' words: the class's
   * words in lower case, the stop words of `language` dropped (`removeStopWords`, on unless `false`) and Porter-stemmed
   * for the language (`stem`, on unless `false`). The `corpusForIDF` texts are read the same way. `'levenshtein'`
   * compares the raw texts.
   */
  public async calculateSimilarity(text1: string, text2: string, options?: SimilarityOptions): Promise<number> {
    this.ensureInitialized();
    const method = options?.method || 'cosine_tfidf';
    const lang = options?.language || this.config.defaultLanguage || 'en';
    const stopWordsSet = this.getStopWords(lang);
    const stemmer = this.getStemmer('porter', lang);
    /** A text's words as the methods compare them. */
    const read = (text: string): string[] => {
      let tokens = wordsOf(text.toLowerCase());
      if (options?.removeStopWords !== false) tokens = tokens.filter((t) => !stopWordsSet.has(t));
      if (options?.stem !== false) tokens = tokens.map((t) => stemmer.stem(t));
      return tokens;
    };
    const tokens1 = read(text1);
    const tokens2 = read(text2);

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
      // natural counts a list of words as given; a string it would split again with its ASCII word rule.
      const tfidf = new natural.TfIdf();
      const corpus = options?.corpusForIDF ?? [];
      corpus.forEach((doc) => tfidf.addDocument(read(doc)));
      tfidf.addDocument(tokens1);
      tfidf.addDocument(tokens2);
      // The two texts are the last two documents, after the corpus.
      const docIndex1 = corpus.length;
      const docIndex2 = corpus.length + 1;

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

  /**
   * Scores a text's sentiment with a word lexicon, with no model call.
   *
   * The lexicon is the first one `natural` ships for the language (`options.language`, else
   * `sentimentConfig.defaultLexiconLanguage`, else `defaultLanguage`): AFINN for English, Spanish and Portuguese,
   * pattern for French, German, Italian and Dutch, senticon for Catalan, Basque and Galician. The entries of
   * `sentimentConfig.lexiconPath` join it in the default lexicon language. `options.lexiconNameOrPath` picks another
   * of `natural`'s lexicons by name (`'afinn'`, `'afinnFinancialMarketNews'`, `'pattern'`, `'senticon'`), or a file
   * that is then the lexicon alone. Another language scores 0 unless `lexiconPath` gives it words.
   *
   * The text is read as words (letters, marks and digits, an apostrophe inside a word kept, lower case) in clauses
   * that end at `. , ; : ! ?` or `…`. At each word, a phrase the lexicon lists that starts there (`can't stand`,
   * `not good`, `well-being`; the longest when several do) takes its value; else a negation word of the language (in
   * English `not`, `no`, `never`, `neither` and any word ending in `n't`) flips the value of the lexicon entries that
   * start among the next three words of its clause; else a word the lexicon lists takes its value. A word scores only
   * in a form the lexicon lists: nothing is stemmed. `score` is the sum of the values put on AFINN's scale (pattern
   * and senticon values times 5) and mapped into -1 to 1 as VADER maps its compound score: `s / sqrt(s * s + 15)`.
   * `polarity` is `positive` from 0.05, `negative` from -0.05, else `neutral`; `intensity` is the score's size;
   * `comparative` is the sum over the number of words, as `natural` computes it. `positiveTokens` and
   * `negativeTokens` hold each scored word or phrase with its signed value, and `neutralTokens` the other words.
   *
   * @throws {GMIError} `NOT_SUPPORTED` when `lexiconNameOrPath` names a lexicon `natural` has no version of in the
   * language, and `RESOURCE_NOT_FOUND` when it names a file that cannot be read.
   */
  public async analyzeSentiment(text: string, options?: SentimentAnalysisOptions): Promise<SentimentResult> {
    this.ensureInitialized();
    const lang = options?.language || this.config.sentimentConfig?.defaultLexiconLanguage || this.config.defaultLanguage || 'en';
    const lexicon = options?.lexiconNameOrPath
      ? await this.namedSentimentLexicon(lang, options.lexiconNameOrPath)
      : this.sentimentLexiconFor(lang);

    const positiveTokens: Array<{ token: string; score: number }> = [];
    const negativeTokens: Array<{ token: string; score: number }> = [];
    const neutralTokens: Array<{ token: string }> = [];
    let sum = 0;
    let wordCount = 0;
    for (const clause of sentimentClauses(text ?? '')) {
      let lastNegation = Number.NEGATIVE_INFINITY;
      /** Adds an entry's value, flipped when a negation stands among the three words before it. */
      const count = (token: string, at: number, value: number | undefined): void => {
        if (value === undefined || value === 0) {
          neutralTokens.push({ token });
          return;
        }
        const signed = at - lastNegation <= NEGATION_REACH ? -value : value;
        sum += signed;
        (signed > 0 ? positiveTokens : negativeTokens).push({ token, score: signed });
      };
      let at = 0;
      while (at < clause.length) {
        // A phrase of the lexicon first, so `not good` and `can't stand` count as the lexicon scores them.
        const phrase = sentimentPhraseAt(lexicon, clause, at);
        if (phrase) {
          wordCount += phrase.length;
          count(phrase.text, at, phrase.value);
          at += phrase.length;
          continue;
        }
        const word = clause[at];
        wordCount += 1;
        if (lexicon.negations.has(word) || (lexicon.contractedNegation && word.endsWith("n't"))) {
          lastNegation = at;
          neutralTokens.push({ token: word });
        } else {
          count(word, at, lexicon.words.get(word));
        }
        at += 1;
      }
    }

    const onAfinnScale = sum * (AFINN_SCALE / lexicon.scale);
    const score = onAfinnScale === 0 ? 0 : onAfinnScale / Math.sqrt(onAfinnScale * onAfinnScale + SENTIMENT_NORMALIZATION_ALPHA);
    const polarity: SentimentResult['polarity'] = score >= 0.05 ? 'positive' : score <= -0.05 ? 'negative' : 'neutral';
    return {
      score,
      polarity,
      comparative: wordCount > 0 ? sum / wordCount : 0,
      intensity: Math.abs(score),
      positiveTokens,
      negativeTokens,
      neutralTokens,
    };
  }

  /**
   * Detect the language of a text with the package's 21 language profiles.
   *
   * The script that holds more than half of the text's letters decides first: Hangul is Korean, Han with kana that
   * make up a tenth of those letters or more is Japanese and with fewer Chinese, and Arabic, Devanagari, Bengali and
   * Cyrillic text is Arabic, Hindi, Bengali, Russian or Ukrainian when its letters show which; that language comes back
   * alone. Latin-script text is ranked against 13 trigram profiles (English, Spanish, French, German, Portuguese,
   * Italian, Dutch, Turkish, Vietnamese, Polish, Swedish, Danish, Norwegian) by Cavnar and Trenkle's out-of-place
   * distance.
   *
   * A text shorter than 10 characters after trimming, and one the profiles do not decide, answers
   * `[{ language: defaultLanguage, confidence: 0.1 }]`, never `'und'`.
   *
   * @param text    - The input text to analyse.
   * @param options - `maxCandidates` caps the ranked list (3 unless given). `method` is not read.
   * @returns Ranked `{ language, confidence }` pairs: ISO 639-1 codes (`'en'`, `'fr'`), confidences from 0 to 1.
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
    if (options?.expandContractions && StatisticalUtilityAI.languageCode(lang) === 'en') {
      // English only, in any letter case (with toLowerCase: false a text keeps its capitals). A curly apostrophe
      // counts as a straight one; `'s` and `'d` are read as `is` and `would`.
      normalizedText = normalizedText
        .replace(/’/g, "'")
        .replace(/\bwon't\b/gi, 'will not')
        .replace(/\bcan't\b/gi, 'cannot')
        .replace(/\bain't\b/gi, 'am not')
        .replace(/n't\b/gi, ' not')
        .replace(/\b're\b/gi, ' are')
        .replace(/\b's\b/gi, ' is')
        .replace(/\b'd\b/gi, ' would')
        .replace(/\b'll\b/gi, ' will')
        .replace(/\b've\b/gi, ' have')
        .replace(/\b'm\b/gi, ' am');
    }
    if (options?.removePunctuation) {
      normalizedText = normalizedText.replace(/[.,/#!$%^&*;:{}=\-_`~()?"]/g, " ");
    }

    // The class's words, for stop word removal and stemming.
    let tokens = wordsOf(normalizedText);

    if (options?.removeStopWords) {
      tokens = tokens.filter(token => !this.getStopWords(lang).has(token));
    }
    if (options?.stem) {
      const stemmer = this.getStemmer(options.stemAlgorithm, lang);
      tokens = tokens.map(token => stemmer.stem(token));
    }
    if (options?.replaceNumbersWith !== undefined) {
        const replacement = options.replaceNumbersWith;
        // A word of decimal digits in any script (`42`, `٤٢`); a word never holds a point, so `3.14` is two words.
        tokens = tokens.map(token => DIGITS_WORD.test(token) ? (replacement === null ? "" : replacement) : token).filter(t => replacement !== null || t !== "");
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
        loadedSentimentAnalyzers: Array.from(this.sentimentLexicons.keys()),
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

    const modelId = trainingOptions?.modelId || this.defaultBayesModelId();
    const stemmerAlgo = trainingOptions?.stemmer === 'lancaster' ? 'lancaster' : 'porter';
    const stemmer = this.getStemmer(stemmerAlgo);
    const alpha = trainingOptions?.alpha || this.config.classifierConfig?.naiveBayes?.defaultAlpha || 0.05;

    const classifier = new (natural.BayesClassifier as any)(stemmer, alpha);
    // Saved with the model, so loadTrainedModel() restores the stemmer it learned with.
    classifier.stemmerAlgorithm = stemmerAlgo;
    console.log(`StatisticalUtilityAI (ID: ${this.utilityId}): Training Naive Bayes classifier '${modelId}' with ${trainingData.length} samples.`);

    for (const item of trainingData) {
      // Each example is read as classifyText() reads a text, so the two share words. natural passes over an example
      // left with no word (stop words alone), which then teaches nothing.
      classifier.addDocument(bayesWords(item.text, stemmer), item.label);
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

    const savePath = this.bayesModelPath(modelId, storagePath);

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

    const loadPath = this.bayesModelPath(modelId, storagePath);
    const loaded = await this.loadBayesModel(modelId, loadPath);
    if (loaded.success) {
      console.log(`StatisticalUtilityAI (ID: ${this.utilityId}): Naive Bayes model '${modelId}' loaded from '${loadPath}'.`);
    } else {
      console.error(`StatisticalUtilityAI (ID: ${this.utilityId}): Error loading Naive Bayes model '${modelId}' from '${loadPath}': ${loaded.message}`);
    }
    return loaded;
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

  /**
   * `JSON.parse`, then a check against `targetSchema` with Ajv when given, as LLMUtilityAI checks it: the standard
   * formats checked, a keyword or a format Ajv does not know passed over, and a value coerced to the type its schema
   * names where it can (`targetSchemaChecks`). Answers `null` when the text is empty or does not parse, when the value
   * fails the schema, and when Ajv cannot compile the schema. It repairs nothing: a HybridUtilityAI that holds an
   * LLM-backed class sends a text this answers `null` for on to it.
   */
  public async parseJsonSafe<T = any>(jsonString: string, options?: ParseJsonOptions<T>): Promise<T | null> {
    this.ensureInitialized();
    if (typeof jsonString !== 'string' || jsonString.trim().length === 0) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonString);
    } catch (error: any) {
      console.warn(`StatisticalUtilityAI (ID: ${this.utilityId}): JSON parse failed.`, error?.message || error);
      if (options?.attemptFixWithLLM) {
        console.warn(`StatisticalUtilityAI: attemptFixWithLLM=true but LLM-based repair is not supported in this implementation.`);
      }
      return null;
    }
    if (options?.targetSchema) {
      let validate: SchemaCheck;
      try {
        validate = targetSchemaChecks.check(options.targetSchema);
      } catch (schemaError: any) {
        console.warn(`StatisticalUtilityAI (ID: ${this.utilityId}): targetSchema does not compile (${schemaError?.message ?? schemaError}); no text can pass it.`);
        return null;
      }
      if (!validate(parsed)) {
        console.warn(`StatisticalUtilityAI (ID: ${this.utilityId}): Parsed JSON failed schema validation.`, validate.errors ?? []);
        return null;
      }
    }
    return parsed as T;
  }
  
  public async shutdown(): Promise<void> {
    this.isInitialized = false;
    // Clear any resources, though 'natural' instances are mostly self-contained.
    this.classifiers.clear();
    this.sentimentLexicons.clear();
    this.customSentimentEntries = [];
    this.stopWords.clear();
    console.log(`StatisticalUtilityAI (ID: ${this.utilityId}) shut down.`);
  }
}
