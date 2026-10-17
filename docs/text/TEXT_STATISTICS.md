---
description: "The utility classes that measure and classify text: StatisticalUtilityAI (word and sentence splits, stems, n-grams, keywords, readability, similarity, language, summaries, lexicon sentiment, keyword and naive Bayes classification), LLMUtilityAI for the same tasks by a model call, and HybridUtilityAI, which routes each task to one of them."
---

# Text Statistics and Classification

Three classes implement one interface, [`IUtilityAI`](../../src/cognition/nlp/ai_utilities/IUtilityAI.ts): `StatisticalUtilityAI` computes with the `natural` package and built-in language profiles, `LLMUtilityAI` asks a model, and `HybridUtilityAI` sends each method to one of the two.

```typescript
import { StatisticalUtilityAI } from '@framers/agentos';

const stats = new StatisticalUtilityAI();
await stats.initialize({});

const text = 'The river rose overnight. Crews closed the bridge before dawn. Traffic moved to the north road.';

await stats.tokenize(text, { type: 'sentence' });
// ['The river rose overnight.', 'Crews closed the bridge before dawn.', 'Traffic moved to the north road.']
await stats.summarize(text, { method: 'first_n_sentences', desiredLength: 'short' });
// 'The river rose overnight. Crews closed the bridge before dawn.'
await stats.generateNGrams(['north', 'road', 'closed'], { n: 2 }); // { 2: [['north', 'road'], ['road', 'closed']] }
await stats.calculateSimilarity('Crews closed the bridge', 'The bridge was closed by crews');
// ≈ 1: without stop words, both texts stem to crew, close and bridg
await stats.calculateReadability(text, { formula: 'flesch_kincaid_grade_level' }); // { score, interpretation, gradeLevel }
```

The classes are exported from the package root, from `@framers/agentos/cognition/nlp` and from `@framers/agentos/cognition/nlp/ai_utilities` (`@framers/agentos/nlp/ai_utilities` is the same module).

## The three classes

| Class | How it answers | Needs |
|---|---|---|
| [`StatisticalUtilityAI`](../../src/cognition/nlp/ai_utilities/StatisticalUtilityAI.ts) | Its own word rule; the sentence tokenizer, stemmers, TF-IDF, n-grams, sentiment lexicons and Bayes classifier of `natural`; the package's trigram language profiles; readability formulas. No model call. | Node |
| [`LLMUtilityAI`](../../src/cognition/nlp/ai_utilities/LLMUtilityAI.ts) | One model call per summary, classification, keyword list, sentiment, language, similarity, readability estimate and normalization; plain JavaScript for tokens and n-grams. | An initialized `AIModelProviderManager` with a provider: an API key, or a local server such as Ollama |
| [`HybridUtilityAI`](../../src/cognition/nlp/ai_utilities/HybridUtilityAI.ts) | Sends each method to the LLM-backed or the statistical class it holds. | What its classes need |

`StatisticalUtilityAI` and `LLMUtilityAI` take an optional id (`utilityId`, generated when left out) and are initialized with `await initialize(config)` before use. Until then their text methods throw a `GMIError` with code `NOT_INITIALIZED`.

## StatisticalUtilityAI

`initialize(config)` takes `defaultLanguage` (`'en'` unless given), `resourcePath`, `customStopWordsPaths` (a file per language code, one stop word a line), `classifierConfig.naiveBayes` (`modelStoragePath`, `defaultModelId`, `defaultAlpha` 0.05) and `sentimentConfig` (`lexiconPath`, and `defaultLexiconLanguage`, which is `defaultLanguage` unless given). A relative path in `customStopWordsPaths` or `sentimentConfig.lexiconPath` is read under `resourcePath` when it is set; an absolute one is read as given. The config type's other fields, `defaultStopWordsLanguage`, `summarizerConfig`, `languageDetectionConfig` and `readabilitySyllableAlgorithm`, are not read. The class logs its progress with `console`.

| Method | What it answers |
|---|---|
| `tokenize(text, { type, toLowerCase, removePunctuation })` | Words: a letter, digit or underscore, then letters, combining marks, digits and underscores, in any script, read in NFC, so `café`, `straße` and `привет` stay whole and a letter written with a separate accent reads as one. An apostrophe or a hyphen ends a word: `don't` is `don` and `t`. Lower-cased unless `toLowerCase: false`. A word holds no punctuation, so `removePunctuation` changes nothing. With `type: 'sentence'`, the sentences from `natural`'s sentence tokenizer, case kept unless `toLowerCase: true`. |
| `stemTokens(tokens, { algorithm, language })` | Each token's stem: Porter (`'porter'`, the default) or Lancaster (`'lancaster'`). With `language` set to `de`, `es`, `fa`, `fr`, `it`, `nl`, `no`, `pt`, `ru`, `sv` or `uk`, Porter uses `natural`'s stemmer for that language; `id` and `ja` use `natural`'s Indonesian and Japanese stemmers; `algorithm: 'carry'` with `language: 'fr'` uses the Carry stemmer. Any other pair uses the English algorithm, and an unknown algorithm uses Porter. |
| `normalizeText(text, options)` | The text's words joined by single spaces, so punctuation never survives. In order: `stripHtml` turns tags into spaces; the text is lower-cased unless `toLowerCase: false`; `expandContractions`, when the language (`language`, else `defaultLanguage`) is English (`en` or `en-*`), reads a curly apostrophe as a straight one and rewrites `won't`, `can't`, `ain't` and the endings `n't`, `'re`, `'s`, `'d`, `'ll`, `'ve` and `'m` (`don't` becomes `do not`; `'s` is read as `is` and `'d` as `would`); `removePunctuation` turns common ASCII punctuation into spaces; the text is split into words by the rule `tokenize()` uses; `removeStopWords` drops the class's stop words for the language; `stem` stems with `stemAlgorithm`; `replaceNumbersWith` replaces each word made of digits with the string given, or removes it when given `null`. Only lower-casing is on unless asked for. |
| `generateNGrams(tokens, { n })` | For each `n` (a number or a list of numbers), the runs of `n` consecutive tokens, keyed by `n`. There is no padding: fewer than `n` tokens give none, and an `n` of 0 or less gives an empty list. `includePartial` is not supported and logs a warning. |
| `extractKeywords(text, { maxKeywords, language })` | The text's most frequent words, most frequent first, a tie in the order the words first appear; 5 unless `maxKeywords` says otherwise. The words are `tokenize()`'s, in lower case, less `natural`'s stop words and the class's stop words for `language` (else `defaultLanguage`). A TF-IDF over the one text would rank them the same, since every word of a single text has the same inverse document frequency. |
| `calculateSimilarity(a, b, options)` | A number from 0 to 1. `'cosine_tfidf'` (the default) and `'jaccard'` compare the texts' words: `tokenize()`'s words in lower case, the class's stop words for `language` (else `defaultLanguage`) dropped (`removeStopWords`, on unless `false`) and Porter-stemmed for that language (`stem`, on unless `false`). `'cosine_tfidf'` is the cosine of the two texts' TF-IDF vectors in a `natural` model of the two texts, plus the `corpusForIDF` texts when given, which are read the same way; `'jaccard'` is the shared distinct words over all distinct words, 1 when both texts have none. `'levenshtein'` is `1 - distance / length of the longer text` on the raw texts, 1 when both are empty. Any other method throws a `GMIError` with code `NOT_SUPPORTED`. |
| `detectLanguage(text, { maxCandidates })` | Ranked `{ language, confidence }` pairs: see [Language of a text](#language-of-a-text). |
| `summarize(text, { method, desiredLength })` | The first sentences of the text, joined by spaces: 3 unless `desiredLength` says otherwise. `'short'` is 2; `'medium'` is 30 percent of the sentences, at least 3; `'long'` is half of them, at least 4; a number of 1 or less is a fraction of them, rounded, so 0 asks for none and gets the one sentence every summary keeps; a larger number is a count; `NaN` keeps the default. At least 1 sentence and at most all of them. `method: 'first_n_sentences'` does this; the default, `'extractive_sentence_rank'`, logs a warning and does the same. Any other method throws `NOT_SUPPORTED`. |
| `classifyText(text, options)` | See [Classification](#classification). |
| `calculateReadability(text, { formula })` | `'flesch_kincaid_reading_ease'`: 206.835 - 1.015 × words per sentence - 84.6 × syllables per word, with `gradeLevel` `N/A`. `'flesch_kincaid_grade_level'`: 0.39 × words per sentence + 11.8 × syllables per word - 15.59, with `gradeLevel` `Approx. Grade N`. Words are the tokens made of ASCII letters alone; syllables are counted by vowel groups, adjusted for endings such as a silent `e`. `score` is rounded to two decimals, and `interpretation` is a fixed placeholder text, not a reading of the score. Any other formula throws `NOT_SUPPORTED`. |
| `analyzeSentiment(text, options)` | See [Sentiment](#sentiment). |
| `parseJsonSafe(text)` | `JSON.parse(text)`, or `null` when the text is empty or does not parse. It repairs nothing. |
| `trainModel()`, `saveTrainedModel()`, `loadTrainedModel()` | See [Classification](#classification). |
| `checkHealth()`, `shutdown()` | Whether the class is initialized, with the languages and models it holds; `shutdown()` drops them and makes the class uninitialized. |

### Sentiment

```typescript
await stats.analyzeSentiment('Thank you, this is wonderful and I love it.');
// score ≈ 0.92: thank 2 + wonderful 4 + love 3 = 9, and 9 / √(9² + 15); polarity 'positive'
await stats.analyzeSentiment('This is not good'); // 'not good' is an AFINN entry of its own, -2: ≈ -0.46, 'negative'
await stats.analyzeSentiment('No problem, this is great'); // 'no' flips problem (-2) to 2, great adds 3: ≈ 0.79
await stats.analyzeSentiment('The table is in the room next to the door.'); // 0, 'neutral'
```

`analyzeSentiment(text, { language, lexiconNameOrPath })` scores a text with a word lexicon, with no model call, and answers a `SentimentResult`. The lexicon is the first one `natural` ships for the language: `language`, else `sentimentConfig.defaultLexiconLanguage`, else `defaultLanguage`, with `en-GB` read as `en`.

| Language | Lexicon | A word's value |
|---|---|---|
| English (`en`), Spanish (`es`), Portuguese (`pt`) | AFINN | -5 to 5 |
| French (`fr`), German (`de`), Italian (`it`), Dutch (`nl`) | pattern | -1 to 1 |
| Catalan (`ca`), Basque (`eu`), Galician (`gl`) | senticon | -1 to 1 |

`sentimentConfig.lexiconPath` adds a lexicon of your own: a JSON object of word to value, or one entry a line, the word, white space (a tab in an AFINN file) and the value, with empty lines and lines that start with `#` passed over. Its entries join the lexicon of `defaultLexiconLanguage`, each replacing the built-in value of its word, on that lexicon's scale; in a language `natural` has no lexicon for, they are the lexicon, on AFINN's scale. A file that cannot be read or parsed logs a warning at `initialize()` and adds nothing. `lexiconNameOrPath` picks the lexicon of one call: a lexicon `natural` ships, by name (`afinn`, `afinnFinancialMarketNews`, `pattern` or `senticon`), which throws `NOT_SUPPORTED` when `natural` has no version of it in the language (English has all four, Spanish AFINN and senticon); or a lexicon file, which is then the lexicon alone, on AFINN's scale, and throws `RESOURCE_NOT_FOUND` when it cannot be read or parsed.

The text is read in clauses, which end at `.`, `,`, `;`, `:`, `!`, `?` or `…`, as words: letters, combining marks and digits, an apostrophe inside a word kept (`don't`), in lower case, a curly apostrophe read as a straight one. At each word:

1. An entry of two words or more that starts there takes its value (`can't stand`, `not good`; the longest when several do).
2. Else a negation word of the language flips the value of every entry that starts among the next three words of its clause. The negation words are `natural`'s: in English `not`, `no`, `never`, `neither` and any word that ends in `n't`; in Spanish `no`, `nunca`, `jamás` and `ni`; German, Dutch and Portuguese have lists of their own, and French, Italian, Catalan, Basque and Galician none.
3. Else a word the lexicon lists takes its value.

Nothing is stemmed: a word scores only in a form the lexicon lists, so `lives` takes nothing from `lively`. An entry that holds no letter or digit, such as an emoji of the Spanish and Portuguese AFINN files, is never matched, since a text's emoji are not words.

`score` is the sum of the values, on AFINN's scale (pattern and senticon values times 5), mapped into -1 to 1 as VADER maps its compound score: `s / √(s² + 15)`. `polarity` is `positive` from 0.05 up, `negative` from -0.05 down, else `neutral`; `intensity` is the size of the score, and `comparative` the sum over the number of words, as `natural` computes it. `positiveTokens` and `negativeTokens` hold each scored word or entry with its signed value, and `neutralTokens` the other words. A language with no lexicon and no `lexiconPath` scores every text 0, and logs a warning when its lexicon is first built: at `initialize()` for the default lexicon language, at its first call for another.

A score from a model comes from `LLMUtilityAI.analyzeSentiment()`; a `HybridUtilityAI` that holds a statistical class sends sentiment to it. A GMI's sentiment tracking calls this method on the GMI's utility class, a `StatisticalUtilityAI` on `gmi()`. With the default thresholds a turn raises `USER_FRUSTRATED` when it scores below -0.3 with an intensity above 0.6, and `USER_SATISFIED` when it scores above 0.3 with an intensity above 0.5; since this class's intensity is the size of its score, one turn raises them below -0.6 and above 0.5, and runs of turns past -0.3 or 0.3 raise them too ([Adaptive Prompt Intelligence](../ADAPTIVE_PROMPT_INTELLIGENCE.md#three-trigger-types) lists every event and its rule).

### Classification

`classifyText(text, { candidateClasses, method, modelId, multiLabel })` answers `{ bestClass, confidence, allScores }`.

- With `method: 'naive_bayes'` and a model trained or loaded under `modelId` (else `classifierConfig.naiveBayes.defaultModelId`, else `'default_bayes_classifier'`, the id `trainModel()` keeps a model under), it answers the model's classes, best first, with their scores. With `multiLabel`, `bestClass` and `confidence` list every class above 0.1, or the best one when none is.
- Otherwise it logs a warning and matches keywords. Each class scores a point for each word of its name (split at spaces) that appears anywhere in the lower-cased text, inside a longer word too; `allScores` holds each class's share of the points, `confidence` the best class's share, or 0.1 when no class scored, and with no points `bestClass` is the first candidate.

```typescript
await stats.trainModel(
  [
    { text: 'invoices overdue, payments failed', label: 'billing' },
    { text: 'parcels delayed, boxes missing', label: 'shipping' },
  ],
  'text_classifier_naive_bayes',
);
await stats.classifyText('boxes crushed, parcels delayed', { candidateClasses: ['billing', 'shipping'], method: 'naive_bayes' });
// bestClass 'shipping': the text and the examples share the stems box, parcel and delai
```

`trainModel(examples, 'text_classifier_naive_bayes', { modelId, stemmer, alpha })` trains `natural`'s Bayes classifier on `[{ text, label }]` and keeps it under `modelId` (else `defaultModelId`, else `'default_bayes_classifier'`). `stemmer` is `'porter'` (the default) or `'lancaster'`, and `alpha` the smoothing, 0.05 unless given. Another model type answers `{ success: false }`. The model reads each example as `classifyText()` reads a text: `tokenize()`'s words in lower case, in any script, `natural`'s stop words left out, each stemmed with the model's stemmer; `language` is not read. An example left with no word teaches nothing.

`saveTrainedModel(modelId, modelType, path)` and `loadTrainedModel(modelId, modelType, path)` write and read the model as JSON at `path`, else at `<modelStoragePath>/<modelId>.nbc.json`, else at `<modelId>.nbc.json` in the working directory. The file records the stemmer the model learned with, and a load restores it (Porter for a file that records none). `initialize()` loads `defaultModelId` from where `loadTrainedModel(defaultModelId)` reads it when the file is there, and logs a warning when it is not: train the model, or load it with `loadTrainedModel()`.

### Language of a text

`detectLanguage(text, { maxCandidates })` reads the text's letters first and takes the script that holds more than half of them. A script decides the answer when one profiled language alone writes it, or when the text's letters show which of the languages that share it the text is in. The answer is then that language alone, with the share of the text's letters in that script as its confidence:

| Script | Language |
|---|---|
| Hangul | Korean (`ko`) |
| Han and kana, when kana are at least a tenth of those letters | Japanese (`ja`) |
| Han with fewer kana | Chinese (`zh`) |
| Arabic, with no letter outside the Arabic alphabet | Arabic (`ar`) |
| Devanagari, without the Marathi letter ळ | Hindi (`hi`) |
| Bengali, without the Assamese letters ৰ and ৱ | Bengali (`bn`) |
| Cyrillic with a letter only Russian writes (ы, э, ё), or only Ukrainian (і, ї, є, ґ) | Russian (`ru`) or Ukrainian (`uk`) |

Latin-script text is compared with 13 trigram profiles: English, Spanish, French, German, Portuguese, Italian, Dutch, Turkish, Vietnamese, Polish, Swedish, Danish and Norwegian. The comparison is Cavnar and Trenkle's out-of-place distance between the text's 300 most frequent trigrams and each profile, where a trigram the profile lacks adds 300; the candidates come back best first, at most `maxCandidates` (3 unless given), each with its share of the inverse distances, `1 / (1 + distance)`, over the 13 profiles, rounded to four decimals. Codes are ISO 639-1.

A text shorter than 10 characters after trimming, a text with fewer than five letters in its main script or no covered script holding more than half its letters, and a text in a shared script its letters do not decide answer `[{ language: defaultLanguage, confidence: 0.1 }]`. The undecided texts are Cyrillic with letters only Russian writes and letters only Ukrainian writes, with neither, or with a letter of another Cyrillic alphabet; Arabic script with a letter outside the Arabic alphabet, as Persian and Urdu write; Devanagari with ळ (Marathi), and Bengali script with ৰ or ৱ (Assamese). Marathi text without ळ reads as Hindi.

`LanguageService`, the runtime's language negotiation (`AgentOSConfig.languageConfig`), has a detector of its own. After `initialize()` and with `autoDetect: true`, `detectLanguages(text)` marks English, Spanish, French, German, Italian or Portuguese when one of a handful of that language's common words appears, Japanese when kana or a Han character does, Chinese when a Han character does and Korean when a Hangul syllable does, each with confidence 0.6, so one text can mark several; with no match it answers the default language with 0.5. The runtime negotiates a request's language from the `languageHint` and `detectedLanguages` the request carries, and runs no detector on the text.

### Stop words

`normalizeText()` and `calculateSimilarity()` drop the class's own English list of 136 words, which adds `com`, `edu`, `gov`, `org`, `www`, `http`, `https`, `eg` and `ie` to the common function words, or the list `customStopWordsPaths` gives for the language. `extractKeywords()` drops that list and `natural`'s as well, and a Naive Bayes model drops `natural`'s alone ([Stop words](./TEXT_PROCESSING.md#stop-words)).

## LLMUtilityAI

```typescript
import { AIModelProviderManager, LLMUtilityAI } from '@framers/agentos';

const providers = new AIModelProviderManager();
await providers.initialize({
  providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: process.env.OPENAI_API_KEY } }],
});

const llm = new LLMUtilityAI();
await llm.initialize({ llmProviderManager: providers, defaultProviderId: 'openai', defaultModelId: 'gpt-4o-mini' });

await llm.analyzeSentiment('The update fixed every crash I reported.'); // { score, polarity, intensity, ... }
await llm.classifyText('Where is my refund?', { candidateClasses: ['billing', 'shipping', 'login'] });
```

`initialize(config)` requires `llmProviderManager` and throws a `GMIError` with code `CONFIG_ERROR` without it.

A call uses the model it is given (`options.modelId`, or `llmModelId` for similarity), else the task's model from the config (`summarizationModelId`, `classificationModelId`, `keywordModelId`, `sentimentModelId`, `languageDetectionModelId`, `semanticSimilarityModelId`, `readabilityEstimationModelId`, and `textNormalizationModelId` for a normalization in any language), else `defaultModelId`. It uses the provider it is given, `options.providerId`, else `options.methodOptions.providerId` (`llmProviderId` for similarity; normalization and readability take none), else `defaultProviderId`, else the part of a `provider/model` id before the slash. With no model, or no provider, it throws `CONFIG_ERROR`; a provider the manager does not hold throws `PROVIDER_NOT_FOUND`, and a reply with no text throws `PROVIDER_ERROR`. Calls run at temperature 0.3 with at most 1,024 tokens unless the method sets its own, and the `methodOptions` of summaries, classification, keywords, sentiment and language go to the provider with the completion options.

| Method | What it does |
|---|---|
| `summarize(text, { method, desiredLength, maxInputLength })` | `'abstractive_llm'` (the default) asks for a paragraph and `'key_points_llm'` for bullet points; `desiredLength` becomes an instruction. The text is cut to `maxInputLength` characters, 8,000 unless given, and the reply is held to 500 tokens, or to three quarters of a `desiredLength` above 100. Any other method throws `NOT_SUPPORTED`. |
| `classifyText()`, `analyzeSentiment()`, `extractKeywords()`, `detectLanguage()`, `calculateReadability()` | Ask the model for a JSON object, with `responseFormat: { type: 'json_object' }`: keywords as `{ "keywords": [...] }` and languages as `{ "languages": [{ "language", "confidence" }] }`, a bare array read too. A reply that does not parse goes back once for repair, to the model and provider the call ran on. When it still does not parse, or lacks the fields asked for, classification, sentiment and readability throw a `GMIError` with code `PARSING_ERROR`, and a reply with no list answers `[]` for keywords and `[{ language: 'und', confidence: 0.1 }]` for language. A keyword that is not a string is dropped, and so is a language entry without a code or with a confidence that is not a number; a number written as a string is read as one. `detectLanguage()` sends the text's first 1,000 characters and answers at most `maxCandidates`, 1 unless given. |
| `calculateSimilarity(a, b, { method })` | `'llm_semantic'` (the default) asks the model for a score, repairs a reply that does not parse on the call's own model and provider, clamps the score to 0 to 1, and throws `PARSING_ERROR` when the reply holds no number; any other method throws `NOT_SUPPORTED`. |
| `normalizeText(text, options)` | One model call on `textNormalizationModelId`, else `defaultModelId`, in any language, whose instructions follow the options; stop words and stemming are not asked for. |
| `tokenize()`, `generateNGrams()` | Plain JavaScript: words split at white space after common ASCII punctuation is turned into spaces, sentences split after `.`, `!` and `?`, both lower-cased unless `toLowerCase: false`; n-grams with `includePartial` supported. |
| `stemTokens(tokens)` | Answers the tokens unchanged and logs a warning. |
| `parseJsonSafe(text, { targetSchema, attemptFixWithLLM, maxRepairAttempts, llmModelIdForFix, llmProviderIdForFix })` | `JSON.parse`, then validation against `targetSchema` with Ajv when given. With `attemptFixWithLLM`, a text that fails either is sent for repair up to `maxRepairAttempts` times (1 unless given), each repair on the text the last one answered, to `llmModelIdForFix` (else `jsonFixerModelId`, else `defaultModelId`) on `llmProviderIdForFix` (else `defaultProviderId`). The answer is `null` when no repair parses and passes the schema, when a repair call fails, and without `attemptFixWithLLM`. |
| `trainModel()`, `saveTrainedModel()`, `loadTrainedModel()` | Answer `{ success: false }`. |

It also implements the prompt engine's two summaries, `summarizeConversationHistory()` and `summarizeRAGContext()`, which `StatisticalUtilityAI` does not.

## HybridUtilityAI

```typescript
import { HybridUtilityAI } from '@framers/agentos';

// `llm` and `stats` from the examples above, each already initialized.
const hybrid = new HybridUtilityAI({ llm, statistical: stats });

await hybrid.summarize(text); // the LLM-backed class
await hybrid.extractKeywords(text); // the LLM-backed class
await hybrid.calculateSimilarity('a text', 'another text'); // the statistical class
```

`new HybridUtilityAI({ llm, statistical, utilityId })` needs at least one of the two and throws without either. Its id is `hybrid-<llm id>-<statistical id>` unless given, with `none` for a class it does not hold.

| Method | Goes to |
|---|---|
| `summarize()`, `classifyText()`, `extractKeywords()` | The LLM-backed class, or the statistical one when the hybrid holds no LLM-backed class |
| `tokenize()`, `stemTokens()`, `normalizeText()`, `generateNGrams()`, `calculateReadability()`, `calculateSimilarity()`, `analyzeSentiment()`, `detectLanguage()` | The statistical class, or the LLM-backed one when the hybrid holds no statistical class |
| `parseJsonSafe()` | The statistical class first; when it answers `null` or throws and the hybrid holds both, the LLM-backed class, which can repair the text with `attemptFixWithLLM` |

A method goes to its second class only when the hybrid does not hold its first. An error from the class a method went to reaches the caller; the hybrid does not retry on the other class. `checkHealth()` is healthy when every class it holds is, and `shutdown()` shuts both down. The hybrid has no `trainModel()`, `saveTrainedModel()` or `loadTrainedModel()`, and not the prompt engine's two summaries: train, save and load a model on the statistical class itself.

`hybrid.initialize(config)` passes one config to both classes, and `LLMUtilityAI` throws on a config without `llmProviderManager`: initialize each class with its own config before building the hybrid, as above.

## Which one the runtime uses

| Where | Utility class |
|---|---|
| `agent({ runtime: 'gmi' })` and `gmi()` | One `StatisticalUtilityAI` per agent, which the agent initializes and its sessions share ([GMIs](../GMI.md)) |
| `AgentOS`, the full runtime | `AgentOSConfig.utilityAIService` as given; the runtime does not call its `initialize()`. Without one, an `LLMUtilityAI` on the runtime's provider manager, with the provider `gmiManagerConfig.defaultGMIBaseConfigDefaults.defaultLlmProviderId` (else the first configured provider, else `openai`) and the model `defaultLlmModelId` (else `gpt-4o`). |

With the environment variable `ENABLE_UTILITY_AI=true`, `createAgentOSConfig()` puts a `StatisticalUtilityAI` in `utilityAIService`, initialized in English. It has neither of the prompt engine's two summaries: the runtime logs a warning when it starts, and the prompt engine, whose summary calls then fail into a `HISTORY_SUMMARIZATION_FAILED` or `RAG_SUMMARIZATION_FAILED` warning, cuts history and retrieved context to fit instead.

A GMI calls its utility class for sentiment tracking, for the JSON of metaprompt replies and, when the persona's RAG config turns it on, for the turn summary it ingests after a turn. The turn summary's method is `abstractive_llm` unless `ingestionProcessing.summarization.method` names another, so a `StatisticalUtilityAI` throws `NOT_SUPPORTED` on it unless that method is `first_n_sentences` or `extractive_sentence_rank`; the GMI logs the error and does not ingest the turn.

The full runtime hands its utility class to the prompt engine, which calls `summarizeConversationHistory()` and `summarizeRAGContext()` on it, and to the `ConversationManager`, which gives it to every conversation it opens. A conversation with `enableAutomaticSummarization` set summarizes the middle of a history that grows past `maxHistoryLengthMessages` with `summarize(text, summarizationOptions)`, `{ desiredLength: 'medium', method: 'abstractive_llm' }` unless set, and cuts the history instead when the call throws, as a `StatisticalUtilityAI` does on that method. The `MemoryLifecycleManager`, which a host builds with a utility class of its own, summarizes for its `summarize_*` actions with `abstractive_llm`.

## Helpers that are not exported

[`src/core/utils/text-utils.ts`](../../src/core/utils/text-utils.ts) holds six small text helpers; inside the package only `estimateTokens` is called, by the session history. Neither the package root nor a named entry of the `exports` map exports them; the map's catch-all `./*` entry resolves `@framers/agentos/core/utils/text-utils` to the built file, outside the documented surface. The table names the exported counterpart of each where there is one.

| Helper | What it does | The exported counterpart |
|---|---|---|
| `tokenize(text)` | Lower-case runs of ASCII letters and digits; any other character, an accented letter included, splits words. | `lexicalTokens()` (any script), or a [pipeline](./TEXT_PROCESSING.md) |
| `normalizeText(text)` | The same words joined by single spaces. | `normalizeText()` of a utility class |
| `estimateTokens(text)` | `Math.ceil(text.length / 4)`, 0 for an empty string. | |
| `cosineSimilarity(a, b)` | The cosine of two number arrays; 0 for empty arrays, different lengths or a zero vector. | `cosineSimilarity()` from the package root and `@framers/agentos/cognition/rag`, which also takes `Float32Array` and `Float64Array` |
| `parseJsonResponse(text)` | `JSON.parse` after removing a Markdown code fence around the JSON; `null` when it does not parse. | `parseJsonSafe()` of a utility class |
| `clamp(value, min, max)` | `value` held within `min` and `max`; `min` when `min` is greater than `max`. | |

## Where it runs

`StatisticalUtilityAI` runs in Node: it imports `natural`, `fs/promises` and `path`, reads its stop-word files and models from disk, and calls no model. `LLMUtilityAI` sends text to the model of the provider it is given. `HybridUtilityAI` runs where the classes it holds run.

## Examples

- [`examples/text-statistics.mjs`](../../examples/text-statistics.mjs): `StatisticalUtilityAI`'s measures over one text, with no key: words, sentences, stems, n-grams, keywords, normalization, readability, similarity, language, a summary, sentiment, keyword classification and a trained Naive Bayes model.
