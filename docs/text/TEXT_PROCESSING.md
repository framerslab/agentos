---
description: "The text processing pipeline: tokenizers for prose and code, lower-casing and accent stripping, stop-word lists, Porter and Lancaster stemming, the three preset pipelines, and how a pipeline feeds a BM25 index."
---

# Text Processing Pipeline

A pipeline turns raw text into the tokens an index stores and a query is matched with. A tokenizer splits the text, and each stage after it changes, drops or annotates the tokens.

```typescript
import { createCodePipeline, createRagPipeline } from '@framers/agentos/cognition/nlp';

const rag = createRagPipeline();
rag.processToStrings('Running runs'); // ['run', 'run']
rag.getStageNames(); // ['StandardTokenizer', 'LowercaseNormalizer', 'StopWordFilter', 'PorterStemmer']

const code = createCodePipeline();
code.processToStrings('getUserName XMLParser path.to.module');
// ['get', 'user', 'name', 'xml', 'parser', 'path', 'module']
```

The module is `@framers/agentos/cognition/nlp`; `@framers/agentos/nlp` is the same module under a shorter name. The package root does not export the pipeline classes. The module also exports the [text statistics classes](./TEXT_STATISTICS.md).

## The pipeline

[`TextProcessingPipeline`](../../src/cognition/nlp/TextProcessingPipeline.ts) holds one tokenizer and an ordered list of stages.

| Member | What it does |
|---|---|
| `new TextProcessingPipeline(tokenizer)` | A pipeline with the tokenizer and no stages. |
| `add(stage)` | Appends a stage and answers the pipeline, so calls chain. |
| `process(text)` | Runs the tokenizer, then each stage in the order added, and answers the tokens. |
| `processToStrings(text)` | `process(text)` mapped to each token's `text`: the form an index stores. |
| `getStageNames()` | The tokenizer's `name`, then each stage's. |

Each token is a [`Token`](../../src/cognition/nlp/types.ts):

| Field | Value |
|---|---|
| `text` | The token as the stages left it. |
| `original` | The text the tokenizer cut, before any stage ran; for `CodeTokenizer`, the whole identifier the part came from. |
| `position` | Where the token starts in the input, in UTF-16 code units. |
| `stem` | Set by `PorterStemmer`. |
| `lemma` | Set by `WordNetLemmatizer`. |

`rag.process('Running runs')` answers `[{ text: 'run', original: 'Running', position: 0, stem: 'run' }, { text: 'run', original: 'runs', position: 8, stem: 'run' }]`.

## Tokenizers

| Class | What it cuts |
|---|---|
| `StandardTokenizer(minLength = 2)` | Runs of letters, digits and underscores in any script (`/[\p{L}\p{N}_]+/u`), case kept. A run shorter than `minLength` is dropped. |
| `CodeTokenizer(minLength = 2)` | Identifiers: it takes runs of letters, digits, underscores and dots, then splits them at dots, at underscores, between an ASCII lower-case letter or digit and an ASCII capital (`getUserName` to `get`, `User`, `Name`), and before the last capital of a run of capitals followed by a lower-case letter (`XMLParser` to `XML`, `Parser`). Case is kept; `original` is the whole identifier. A part shorter than `minLength` is dropped. |

A tokenizer is any object with a `name` and `tokenize(text): Token[]` ([`ITokenizer`](../../src/cognition/nlp/ITextProcessor.ts)).

## Stages

| Class | What it does |
|---|---|
| `LowercaseNormalizer` | Lower-cases `text`. |
| `AccentStripper` | Decomposes `text` (Unicode NFD) and removes the combining marks U+0300 to U+036F: `café` becomes `cafe`. |
| `StopWordFilter(stopWords?)` | Drops each token whose `text` is in the set, compared as written: put it after `LowercaseNormalizer`. With no set it uses `getNaturalStopWords()`. |
| `PorterStemmer` | Replaces `text` with its Porter stem from the `natural` package and sets `stem`: `running` to `run`, `foxes` to `fox`, `connected` to `connect`. `natural`'s stemmer lower-cases tokens of three or more characters. |
| `NoOpStemmer` | Passes tokens through. `createCodePipeline()` ends with it, so identifiers are not stemmed. |
| `WordNetLemmatizer` | Replaces `text` with the stem from `natural`'s Lancaster stemmer and sets `lemma` to it. It does not look words up in WordNet, so `better` does not become `good`. |
| `NoOpLemmatizer` | Passes tokens through. |

`PorterStemmer` and `WordNetLemmatizer` load `natural` on their first `process()` call; `await stage.initialize()` loads it ahead of time. When `natural` cannot be loaded they pass tokens through unchanged.

A stage is any object with a `name` and `process(tokens): Token[]` ([`ITextProcessor`](../../src/cognition/nlp/ITextProcessor.ts)):

```typescript
import {
  ENGLISH_STOP_WORDS,
  LowercaseNormalizer,
  StandardTokenizer,
  StopWordFilter,
  TextProcessingPipeline,
  type ITextProcessor,
} from '@framers/agentos/cognition/nlp';

const dropNumbers: ITextProcessor = {
  name: 'DropNumbers',
  process: (tokens) => tokens.filter((token) => !/^\d+$/.test(token.text)),
};

const pipeline = new TextProcessingPipeline(new StandardTokenizer(3))
  .add(new LowercaseNormalizer())
  .add(new StopWordFilter(ENGLISH_STOP_WORDS))
  .add(dropNumbers);

pipeline.processToStrings('The 2024 budget grew by 120 percent'); // ['budget', 'grew', 'percent']
```

## Stop words

| List | Words | Used by |
|---|---|---|
| `getNaturalStopWords()` | `natural`'s English list, 170 entries: 132 words, the 26 single letters, the 10 digits, `$` and `_`. When `natural` cannot be loaded it answers `ENGLISH_STOP_WORDS`. | `new StopWordFilter()`, `createProsePipeline()`, `createRagPipeline()` and the built-in tokenizer of [`BM25Index`](./LEXICAL_AND_HYBRID_SEARCH.md#bm25index) |
| `ENGLISH_STOP_WORDS` | 129 common English words. | Pass it to `StopWordFilter`. |
| `CODE_STOP_WORDS` | 88 English function words. It leaves out `class`, `function`, `import`, `const`, `let`, `var`, `return` and `this`, which carry meaning in code. | `createCodePipeline()` |

`natural`'s list holds neither `no` nor `not`, so the default filter keeps negations; `ENGLISH_STOP_WORDS` drops `no`, `nor` and `not`. The [text statistics classes](./TEXT_STATISTICS.md) keep a list of their own.

## Presets

| Function | Stages |
|---|---|
| `createProsePipeline()` | `StandardTokenizer`, `LowercaseNormalizer`, `AccentStripper`, `StopWordFilter` (`natural`'s list), `PorterStemmer` |
| `createRagPipeline()` | `StandardTokenizer`, `LowercaseNormalizer`, `StopWordFilter` (`natural`'s list), `PorterStemmer` |
| `createCodePipeline()` | `CodeTokenizer`, `LowercaseNormalizer`, `StopWordFilter` (`CODE_STOP_WORDS`), `NoOpStemmer` |

Each call builds a new pipeline. `createProsePipeline()` turns `The café serves naïve résumé writers` into tokens that include `cafe`, `naiv` and `resum`, and not `the`.

## In a search index

`BM25Index` tokenizes with a pipeline given as `pipeline`, so a query for `run` finds a passage with `running`:

```typescript
import { createRagPipeline } from '@framers/agentos/cognition/nlp';
import { BM25Index } from '@framers/agentos/cognition/rag';

const index = new BM25Index({ pipeline: createRagPipeline() });
index.addDocument('a', 'The developers are running integration tests');
index.addDocument('b', 'She runs the application every morning');
index.search('run').map((hit) => hit.id); // both 'a' and 'b'
```

A saved index holds stemmed terms, so it is restored with the same pipeline: see [Lexical and Hybrid Search](./LEXICAL_AND_HYBRID_SEARCH.md).

## Where it runs

`@framers/agentos/cognition/nlp` runs in Node. `StopWordFilter`, `PorterStemmer` and `WordNetLemmatizer` load the CommonJS `natural` package, a dependency of `@framers/agentos`, through `createRequire` from `node:module`, and the module also loads the text statistics classes, which import `fs/promises` and `natural`. The pipeline classes call no model and need no key.

A page in a browser tokenizes with `lexicalTokens` from `@framers/agentos/cognition/library/browser`: lower-case runs of letters and digits in any script, nothing stemmed ([Words and snippets](../features/LIBRARY_INDEX.md#words-and-snippets)).

## Examples

- [`examples/text-processing-pipeline.mjs`](../../examples/text-processing-pipeline.mjs): the three presets over a paragraph and a line of code, the tokens with their positions and stems, and a pipeline built stage by stage.
- [`examples/text-search-bm25.mjs`](../../examples/text-search-bm25.mjs): a `BM25Index` that tokenizes with `createRagPipeline()`.
