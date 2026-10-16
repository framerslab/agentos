#!/usr/bin/env node
// Example: the text processing pipeline: tokenize, normalize, drop stop words, stem.
//
// A pipeline turns raw text into the tokens a search index stores and a query is
// matched with. Docs: docs/text/TEXT_PROCESSING.md.
//
// This script demonstrates:
//   - createProsePipeline(), createRagPipeline() and createCodePipeline(), and their stages
//   - each token's original text, position and stem
//   - identifiers split at dots, underscores and camelCase by the code preset
//   - a pipeline built stage by stage, with a stage of its own
//   - the sizes of the stop-word lists the package ships
//
// Usage (no API key; the package's `natural` dependency does the stemming):
//   pnpm install && pnpm run build
//   node examples/text-processing-pipeline.mjs

import {
  CODE_STOP_WORDS,
  ENGLISH_STOP_WORDS,
  LowercaseNormalizer,
  PorterStemmer,
  StandardTokenizer,
  StopWordFilter,
  TextProcessingPipeline,
  createCodePipeline,
  createProsePipeline,
  createRagPipeline,
  getNaturalStopWords,
} from '@framers/agentos/cognition/nlp';

const paragraph =
  'The engineers were running the migrations overnight. Their café stand-up covered ' +
  'the failing builds, and the runners recovered before the naïve retries ran out.';

const prose = createProsePipeline();
const rag = createRagPipeline();
const code = createCodePipeline();

console.log('\n=== stages ===\n');
for (const [name, pipeline] of [['prose', prose], ['rag', rag], ['code', code]]) {
  console.log(`${name.padEnd(5)} ${pipeline.getStageNames().join(' -> ')}`);
}

console.log('\n=== the paragraph through the prose and RAG presets ===\n');
console.log('prose:', prose.processToStrings(paragraph).join(' '));
console.log('rag:  ', rag.processToStrings(paragraph).join(' '));

console.log('\n=== tokens with positions and stems (RAG preset) ===\n');
for (const token of rag.process('Running runners ran')) {
  console.log(`${token.original.padEnd(8)} at ${String(token.position).padStart(2)} -> ${token.text} (stem ${token.stem})`);
}

console.log('\n=== a line of code (code preset) ===\n');
const line = 'const maxRetryCount = parseHTTPResponse(user_session.lastLoginAt);';
console.log(line);
console.log('->', code.processToStrings(line).join(' '));

console.log('\n=== a pipeline built stage by stage ===\n');
// A stage is any object with a name and process(tokens): this one drops numbers.
const dropNumbers = {
  name: 'DropNumbers',
  process: (tokens) => tokens.filter((token) => !/^\d+$/.test(token.text)),
};
const custom = new TextProcessingPipeline(new StandardTokenizer(3))
  .add(new LowercaseNormalizer())
  .add(new StopWordFilter(ENGLISH_STOP_WORDS))
  .add(dropNumbers)
  .add(new PorterStemmer());
console.log(custom.getStageNames().join(' -> '));
console.log(custom.processToStrings('The 2024 budget grew by 120 percent across 14 regions'));

console.log('\n=== stop-word lists ===\n');
console.log(`getNaturalStopWords() ${getNaturalStopWords().size} entries`);
console.log(`ENGLISH_STOP_WORDS    ${ENGLISH_STOP_WORDS.size} words`);
console.log(`CODE_STOP_WORDS       ${CODE_STOP_WORDS.size} words`);
