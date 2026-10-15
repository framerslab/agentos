#!/usr/bin/env node
// Example: text statistics with StatisticalUtilityAI, with no model and no key.
//
// StatisticalUtilityAI measures and classifies text with the `natural` package and the
// package's trigram language profiles. Docs: docs/text/TEXT_STATISTICS.md.
//
// This script demonstrates:
//   - words, sentences, Porter and Lancaster stems, and n-grams
//   - keywords, normalization and a first-sentences summary
//   - Flesch-Kincaid reading ease and grade level
//   - similarity by TF-IDF cosine, Jaccard and Levenshtein
//   - language detection for English, French and Japanese text
//   - keyword classification against candidate class names
//
// analyzeSentiment() is left out: it answers a neutral result for every text, because
// its lexicon does not load (docs/text/TEXT_STATISTICS.md, "Sentiment"). initialize()
// logs that as a warning, and the class logs its other steps too.
//
// Usage:
//   pnpm install && pnpm run build
//   node examples/text-statistics.mjs

import { StatisticalUtilityAI } from '@framers/agentos/cognition/nlp';

const stats = new StatisticalUtilityAI('text-statistics-example');
await stats.initialize({ defaultLanguage: 'en' });

const report =
  'The city council approved the new transit plan on Tuesday. The plan adds three bus lines ' +
  'and extends the light rail to the airport. Construction starts next spring, and the council ' +
  'expects the first line to open within two years. Residents who spoke at the meeting asked ' +
  'for more bike lanes.';

console.log('\n=== words and sentences ===\n');
const words = await stats.tokenize(report);
const sentences = await stats.tokenize(report, { type: 'sentence' });
console.log(`${words.length} words in ${sentences.length} sentences`);
sentences.forEach((sentence, i) => console.log(`  ${i + 1}. ${sentence}`));

console.log('\n=== stems ===\n');
const sample = ['approved', 'extends', 'construction', 'residents', 'meeting'];
console.log('porter:   ', (await stats.stemTokens(sample)).join(' '));
console.log('lancaster:', (await stats.stemTokens(sample, { algorithm: 'lancaster' })).join(' '));

console.log('\n=== n-grams of the first six words ===\n');
const grams = await stats.generateNGrams(words.slice(0, 6), { n: [2, 3] });
console.log('2:', grams[2].map((gram) => gram.join(' ')).join(' | '));
console.log('3:', grams[3].map((gram) => gram.join(' ')).join(' | '));

console.log('\n=== keywords, normalization, summary ===\n');
console.log('keywords:  ', await stats.extractKeywords(report, { maxKeywords: 5 }));
console.log('normalized:', await stats.normalizeText(sentences[0], { removeStopWords: true, stem: true }));
console.log('summary:   ', await stats.summarize(report, { method: 'first_n_sentences', desiredLength: 'short' }));

console.log('\n=== readability ===\n');
for (const formula of ['flesch_kincaid_reading_ease', 'flesch_kincaid_grade_level']) {
  const { score, gradeLevel } = await stats.calculateReadability(report, { formula });
  console.log(`${formula}: ${score} (${gradeLevel})`);
}

console.log('\n=== similarity ===\n');
const first = 'The council approved a plan for new bus lines.';
const second = 'New bus lines were approved by the city council.';
console.log(`a: ${first}\nb: ${second}`);
for (const method of ['cosine_tfidf', 'jaccard', 'levenshtein']) {
  const similarity = await stats.calculateSimilarity(first, second, { method });
  console.log(`${method.padEnd(12)} ${similarity.toFixed(3)}`);
}

console.log('\n=== language ===\n');
const passages = {
  english: report,
  french:
    'Tous les êtres humains naissent libres et égaux en dignité et en droits. ' +
    'Ils sont doués de raison et de conscience et doivent agir les uns envers les autres.',
  japanese: '古い灯台の下で、少女は毎晩ひとりで海の音を聞いていた。嵐が近づくと、彼女は窓を閉めて静かに祈った。',
};
for (const [name, text] of Object.entries(passages)) {
  const ranked = await stats.detectLanguage(text, { maxCandidates: 3 });
  console.log(`${name.padEnd(9)}`, ranked.map(({ language, confidence }) => `${language} ${confidence}`).join(', '));
}

console.log('\n=== keyword classification ===\n');
// With no trained model, classifyText() logs a warning and scores each class by the words of
// its name found in the text.
const ticket = 'My card was charged twice for the same order and I want a refund.';
const classified = await stats.classifyText(ticket, {
  candidateClasses: ['billing refund', 'shipping delay', 'account login'],
});
console.log(classified);

await stats.shutdown();
