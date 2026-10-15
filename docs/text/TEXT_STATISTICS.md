---
description: "The utility classes that measure and classify text: StatisticalUtilityAI (word and sentence splits, stems, n-grams, keywords, readability, similarity, language, summaries, keyword and naive Bayes classification), LLMUtilityAI for the same tasks by a model call, and HybridUtilityAI, which routes each task to one of them."
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
| [`StatisticalUtilityAI`](../../src/cognition/nlp/ai_utilities/StatisticalUtilityAI.ts) | Tokenizers, stemmers, TF-IDF, n-grams and the Bayes classifier of `natural`, the package's trigram language profiles, and readability formulas. No model call. | Node |
| [`LLMUtilityAI`](../../src/cognition/nlp/ai_utilities/LLMUtilityAI.ts) | One model call per summary, classification, keyword list, sentiment, language, similarity, readability estimate and normalization; plain JavaScript for tokens and n-grams. | An initialized `AIModelProviderManager` with a provider: an API key, or a local server such as Ollama |
| [`HybridUtilityAI`](../../src/cognition/nlp/ai_utilities/HybridUtilityAI.ts) | Sends each method to the LLM-backed or the statistical class it holds. | What its classes need |

`StatisticalUtilityAI` and `LLMUtilityAI` take an optional id (`utilityId`, generated when left out) and are initialized with `await initialize(config)` before use. Until then their text methods throw; `StatisticalUtilityAI`'s throw a `GMIError` with code `NOT_INITIALIZED`.

## StatisticalUtilityAI

`initialize(config)` takes `defaultLanguage` (`'en'` unless given), `customStopWordsPaths` (a file per language code, one stop word a line, read from `resourcePath` when it is set), `classifierConfig.naiveBayes` (`modelStoragePath`, `defaultModelId`, `defaultAlpha` 0.05) and `sentimentConfig.defaultLexiconLanguage` (`'en'`). The class logs its progress with `console`.

| Method | What it answers |
|---|---|
| `tokenize(text, { type, toLowerCase, removePunctuation })` | Words: runs of ASCII letters, digits and underscores from `natural`'s word tokenizer, so any other character, an accented `é` included, ends a word. Lower-cased unless `toLowerCase: false`. The tokenizer also keeps the Cyrillic letters А to я, which the punctuation pass then strips; `removePunctuation: false` keeps them. With `type: 'sentence'`, the sentences from `natural`'s sentence tokenizer, case kept. |
| `stemTokens(tokens, { algorithm, language })` | Each token's stem: Porter (`'porter'`, the default) or Lancaster (`'lancaster'`). With `language` set to `de`, `es`, `fa`, `fr`, `it`, `nl`, `no`, `pt`, `ru`, `sv` or `uk`, Porter uses `natural`'s stemmer for that language; `id` and `ja` use `natural`'s Indonesian and Japanese stemmers; `algorithm: 'carry'` with `language: 'fr'` uses the Carry stemmer. Any other pair uses the English algorithm, and an unknown algorithm uses Porter. |
| `normalizeText(text, options)` | The text's words joined by single spaces, so punctuation never survives. In order: `stripHtml` turns tags into spaces; the text is lower-cased unless `toLowerCase: false`; `expandContractions` (English) rewrites `won't`, `can't`, `ain't` and the endings `'re`, `'s`, `'d`, `'ll`, `'ve` and `'m`; `removePunctuation` turns common ASCII punctuation into spaces; the text is split into words by `natural`'s word tokenizer; `removeStopWords` drops the class's stop words; `stem` stems with `stemAlgorithm`; `replaceNumbersWith` replaces each word made of digits with the string given, or removes it when given `null`. Only lower-casing is on unless asked for. |
| `generateNGrams(tokens, { n })` | For each `n` (a number or a list of numbers), the runs of `n` consecutive tokens, keyed by `n`. There is no padding: fewer than `n` tokens give none, and an `n` of 0 or less gives an empty list. `includePartial` is not supported and logs a warning. |
| `extractKeywords(text, { maxKeywords })` | The words with the highest TF-IDF in a `natural` `TfIdf` model of this one text, which drops `natural`'s stop words. With a single document every word has the same IDF, so these are the most frequent words. 5 unless given. |
| `calculateSimilarity(a, b, options)` | A number from 0 to 1. `method: 'cosine_tfidf'` (the default) is the cosine of the two texts' TF-IDF vectors in a `natural` model of the two texts, plus the `corpusForIDF` texts when given; the model also drops `natural`'s stop words, and adds the corpus texts lower-cased but not stemmed, so a corpus word counts toward a stem's IDF only when the two are written the same. `'jaccard'` is the shared distinct words over all distinct words, 1 when both texts have none. Before either, the words are lower-cased, the class's stop words dropped (`removeStopWords`, on unless `false`) and Porter-stemmed (`stem`, on unless `false`). `'levenshtein'` is `1 - distance / length of the longer text` on the raw texts, 1 when both are empty. Any other method throws a `GMIError` with code `NOT_SUPPORTED`. |
| `detectLanguage(text, { maxCandidates })` | Ranked `{ language, confidence }` pairs: see [Language of a text](#language-of-a-text). |
| `summarize(text, { method, desiredLength })` | The first sentences of the text, joined by spaces: 3 unless `desiredLength` says otherwise. `'short'` is 2; `'medium'` is 30 percent of the sentences, at least 3; `'long'` is half of them, at least 4; a number of 1 or less is a fraction of them, and a larger number a count. At least 1 sentence and at most all of them. `method: 'first_n_sentences'` does this; the default, `'extractive_sentence_rank'`, logs a warning and does the same. Any other method throws `NOT_SUPPORTED`. |
| `classifyText(text, options)` | See [Classification](#classification). |
| `calculateReadability(text, { formula })` | `'flesch_kincaid_reading_ease'`: 206.835 - 1.015 × words per sentence - 84.6 × syllables per word, with `gradeLevel` `N/A`. `'flesch_kincaid_grade_level'`: 0.39 × words per sentence + 11.8 × syllables per word - 15.59, with `gradeLevel` `Approx. Grade N`. Words are the tokens made of ASCII letters alone; syllables are counted by vowel groups, adjusted for endings such as a silent `e`. `score` is rounded to two decimals, and `interpretation` is a fixed placeholder text, not a reading of the score. Any other formula throws `NOT_SUPPORTED`. |
| `analyzeSentiment(text, options)` | See [Sentiment](#sentiment). |
| `parseJsonSafe(text)` | `JSON.parse(text)`, or `null` when the text is empty or does not parse. It repairs nothing. |
| `trainModel()`, `saveTrainedModel()`, `loadTrainedModel()` | See [Classification](#classification). |
| `checkHealth()`, `shutdown()` | Whether the class is initialized, with the languages and models it holds; `shutdown()` drops them and makes the class uninitialized. |

### Sentiment

`analyzeSentiment(text, { language })` answers a `SentimentResult`: `score`, `polarity` (`positive` above 0.05, `negative` below −0.05, else `neutral`), `comparative`, `intensity`, and the positive and negative words it found.

It answers `{ score: 0, polarity: 'neutral' }` with empty word lists for every text. The class asks `natural`'s `SentimentAnalyzer` for the AFINN lexicon of the language code (`en`); `natural` names the languages of its lexicons in full (`English`, `Spanish`), refuses the code, and the class falls back to an analyzer that scores every text 0. `initialize()` logs the fallback as a warning: `Failed to initialize sentiment analyzer for 'en'`. `sentimentConfig.lexiconPath` is not read.

A score from a model comes from `LLMUtilityAI.analyzeSentiment()`. A `HybridUtilityAI` that holds a statistical class sends sentiment there, so it answers neutral too. The GMI's sentiment tracking calls this method on the runtime's utility class ([Adaptive Prompt Intelligence](../ADAPTIVE_PROMPT_INTELLIGENCE.md)).

### Classification

`classifyText(text, { candidateClasses, method, modelId, multiLabel })` answers `{ bestClass, confidence, allScores }`.

- With `method: 'naive_bayes'` and a model trained or loaded under `modelId` (else `classifierConfig.naiveBayes.defaultModelId`, else `'default_bayes'`), it answers the model's classes, best first, with their scores. With `multiLabel`, `bestClass` and `confidence` list every class above 0.1, or the best one when none is.
- Otherwise it logs a warning and matches keywords. Each class scores a point for each word of its name (split at spaces) that appears anywhere in the lower-cased text, inside a longer word too; `allScores` holds each class's share of the points, `confidence` the best class's share, or 0.1 when no class scored, and with no points `bestClass` is the first candidate.

`trainModel(examples, 'text_classifier_naive_bayes', { modelId, stemmer, alpha })` trains `natural`'s Bayes classifier on `[{ text, label }]` and keeps it under `modelId` (`'default_bayes_classifier'` unless given, which is not `classifyText()`'s default, so pass the same `modelId` to both). `alpha` is the smoothing, 0.05 unless given. Another model type answers `{ success: false }`. The model learns each example's lower-cased words as written, while `classifyText()` matches the Porter stems of the text's words, less `natural`'s stop words: a word whose stem differs from it, such as `charged` (stem `charg`), does not match what the model learned.

`saveTrainedModel(modelId, modelType, path)` and `loadTrainedModel(modelId, modelType, path)` write and read the model as JSON at `path`, else at `<modelStoragePath>/<modelId>.nbc.json`, else at `<modelId>.nbc.json` in the working directory. `initialize()` tries to load `defaultModelId`, fails and logs a warning; call `loadTrainedModel(modelId)` after it.

### Language of a text

`detectLanguage(text, { maxCandidates })` reads the text's letters first. A script that one profiled language alone writes decides the answer, which is then that language alone, with the share of the text's letters in that script as its confidence:

| Script | Language |
|---|---|
| Hangul | Korean (`ko`) |
| Han with kana, when kana are at least a tenth of those letters | Japanese (`ja`) |
| Han without enough kana | Chinese (`zh`) |
| Arabic, with no letter outside the Arabic alphabet | Arabic (`ar`) |
| Devanagari, without the Marathi letter ळ | Hindi (`hi`) |
| Bengali, without the Assamese letters ৰ and ৱ | Bengali (`bn`) |
| Cyrillic with a letter only Russian writes (ы, э, ё), or only Ukrainian (і, ї, є, ґ) | Russian (`ru`) or Ukrainian (`uk`) |

Latin-script text is compared with 13 trigram profiles: English, Spanish, French, German, Portuguese, Italian, Dutch, Turkish, Vietnamese, Polish, Swedish, Danish and Norwegian. The comparison is Cavnar and Trenkle's out-of-place distance between the text's 300 most frequent trigrams and each profile; the candidates come back best first, at most `maxCandidates` (3 unless given), each with its share of the inverse distances, `1 / (1 + distance)`, over the 13 profiles, rounded to four decimals. Codes are ISO 639-1.

A text shorter than 10 characters after trimming, a text with fewer than five letters in its main script or no covered script holding more than half its letters, and a text in a shared script its letters do not decide answer `[{ language: defaultLanguage, confidence: 0.1 }]`. The undecided texts include Cyrillic with letters only Russian writes and letters only Ukrainian writes, with neither, or with a letter of another Cyrillic alphabet; Persian or Urdu in Arabic script; Marathi; and Assamese.

`LanguageService`, the runtime's language negotiation (`AgentOSConfig.languageConfig`), has a detector of its own. After `initialize()` and with `autoDetect: true`, `detectLanguages(text)` marks English, Spanish, French, German, Italian or Portuguese when one of a handful of that language's common words appears, and Japanese, Chinese or Korean when its script does, each with confidence 0.6; with no match it answers the default language with 0.5. The runtime negotiates a request's language from the `languageHint` and `detectedLanguages` the request carries, and runs no detector on the text.

### Stop words

`normalizeText()` and `calculateSimilarity()` drop the class's own English list of 136 words, which adds `com`, `edu`, `gov`, `org`, `www`, `http`, `https`, `eg` and `ie` to the common function words, or the list `customStopWordsPaths` gives for the language. `extractKeywords()` drops `natural`'s list instead ([Stop words](./TEXT_PROCESSING.md#stop-words)).

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

`initialize(config)` requires `llmProviderManager` and throws a `GMIError` with code `CONFIG_ERROR` without it. A call uses the model it is given, else the task's model from the config (`summarizationModelId`, `classificationModelId`, `keywordModelId`, `sentimentModelId`, `languageDetectionModelId`, `semanticSimilarityModelId`, `textNormalizationModelId`, `readabilityEstimationModelId`, and `jsonFixerModelId` for repairs), else `defaultModelId`; and the provider it is given, else `defaultProviderId`, else the part of a `provider/model` id before the slash. With no model, or no provider, it throws `CONFIG_ERROR`. Calls run at temperature 0.3 with at most 1,024 tokens unless the method sets its own.

| Method | What it does |
|---|---|
| `summarize(text, { method, desiredLength, maxInputLength })` | `'abstractive_llm'` (the default) asks for a paragraph and `'key_points_llm'` for bullet points; `desiredLength` becomes an instruction. The text is cut to `maxInputLength` characters, 8,000 unless given. Any other method throws `NOT_SUPPORTED`. |
| `classifyText()`, `analyzeSentiment()`, `extractKeywords()`, `detectLanguage()`, `calculateReadability()` | Ask the model for JSON. A reply that does not parse goes back to the model once for repair. When it still does not parse, classification, sentiment and readability throw a `GMIError` with code `PARSING_ERROR`, keywords answer `[]` and language `[{ language: 'und', confidence: 0.1 }]`. |
| `calculateSimilarity(a, b, { method })` | `'llm_semantic'` (the default) asks the model for a score and clamps it to 0 to 1; any other method throws `NOT_SUPPORTED`. |
| `normalizeText(text, options)` | One model call whose instructions follow the options; stop words and stemming are not asked for. |
| `tokenize()`, `generateNGrams()` | Plain JavaScript: words split at white space after ASCII punctuation is turned into spaces, sentences split after `.`, `!` and `?`; n-grams with `includePartial` supported. |
| `stemTokens(tokens)` | Answers the tokens unchanged and logs a warning. |
| `parseJsonSafe(text, { targetSchema, attemptFixWithLLM })` | `JSON.parse`, then validation against `targetSchema` with Ajv when given. With `attemptFixWithLLM`, a text that fails either goes to the model once for repair; otherwise the answer is `null`. |
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

A method goes to its second class only when the hybrid does not hold its first. An error from the class a method went to reaches the caller; the hybrid does not retry on the other class. `checkHealth()` is healthy when every class it holds is, and `shutdown()` shuts both down.

`hybrid.initialize(config)` passes one config to both classes, and `LLMUtilityAI` throws on a config without `llmProviderManager`: initialize each class with its own config before building the hybrid, as above.

## Which one the runtime uses

| Where | Utility class |
|---|---|
| `agent({ runtime: 'gmi' })` and `gmi()` | A `StatisticalUtilityAI` for each persona, initialized by the runtime ([GMIs](../GMI.md)) |
| `AgentOS`, the full runtime | `AgentOSConfig.utilityAIService` as given; the runtime does not call its `initialize()`. Without one, an `LLMUtilityAI` on the runtime's provider manager, with the provider `gmiManagerConfig.defaultGMIBaseConfigDefaults.defaultLlmProviderId` (else the first configured provider, else `openai`) and the model `defaultLlmModelId` (else `gpt-4o`). |

A GMI calls its utility class for sentiment tracking, for the JSON of metaprompt replies and, when the persona's RAG config turns it on, for the turn summary it ingests after a turn; the full runtime's prompt engine calls `summarizeConversationHistory()` and `summarizeRAGContext()` on it.

## Helpers that are not exported

[`src/core/utils/text-utils.ts`](../../src/core/utils/text-utils.ts) holds six helpers the package uses internally. Neither the package root nor a named entry of the `exports` map exports them; the map's catch-all `./*` entry resolves `@framers/agentos/core/utils/text-utils` to the built file, outside the documented surface.

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

- [`examples/text-statistics.mjs`](../../examples/text-statistics.mjs): `StatisticalUtilityAI`'s measures over one text, with no key: words, sentences, stems, n-grams, keywords, normalization, readability, similarity, language, a summary and keyword classification.
