/**
 * @fileoverview A lemma stage over the `natural` package's Lancaster stemmer. Passes tokens through unchanged when
 * `natural` cannot be loaded.
 *
 * It looks nothing up in WordNet: `natural` reads WordNet asynchronously only, and a pipeline stage is synchronous,
 * so the lemma is the Lancaster stem, not the dictionary form: `better` never becomes `good`, nor `mice` `mouse`.
 *
 * @module agentos/nlp/lemmatizers/WordNetLemmatizer
 */

import type { Token } from '../types';
import type { ITextProcessor } from '../ITextProcessor';
import { getNaturalModule } from '../naturalInterop';

/** Lazy-loaded lemmatize function from the `natural` package. */
let lemmatizeFn: ((word: string) => string) | null | undefined;

function loadLemmatizer(): void {
  if (lemmatizeFn !== undefined) return;

  const natural = getNaturalModule();
  const lancasterStemmer = natural?.LancasterStemmer;
  if (lancasterStemmer && typeof lancasterStemmer.stem === 'function') {
    lemmatizeFn = (word: string) => {
      /* `natural` exposes async WordNet lookup only, so keep the sync contract by
         using Lancaster stemming as a pragmatic lemma approximation. */
      try {
        return lancasterStemmer.stem(word);
      } catch {
        return word;
      }
    };
    return;
  }

  lemmatizeFn = null;
}

/**
 * Sets `token.lemma`, and `token.text`, to the Lancaster stem of the token's text. Despite its name it does not look
 * words up in WordNet, so it gives no dictionary forms; see the module comment.
 */
export class WordNetLemmatizer implements ITextProcessor {
  readonly name = 'WordNetLemmatizer';

  process(tokens: Token[]): Token[] {
    loadLemmatizer();
    if (!lemmatizeFn) return tokens;

    return tokens.map(t => {
      const lemma = lemmatizeFn!(t.text);
      return { ...t, text: lemma, lemma };
    });
  }

  async initialize(): Promise<void> {
    loadLemmatizer();
  }
}
