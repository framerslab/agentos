/**
 * @fileoverview The BM25 engine with no import: a sparse keyword index over a caller's tokenizer, which loads in a
 * browser, matches every word or any word, whole or by prefix, and is saved and restored as JSON.
 * {@link BM25Index} extends it with AgentOS's own tokenizer.
 *
 * @module agentos/rag/search/LexicalIndex
 */

/** Internal document representation stored in the index. */
export interface BM25Document {
  /** Unique document identifier. */
  id: string;
  /** Number of tokens in the document after tokenization. */
  length: number;
  /** Optional metadata attached to the document. */
  metadata?: Record<string, unknown>;
}

/** A single search result with its relevance score. */
export interface BM25Result {
  /** Document identifier. */
  id: string;
  /** BM25 relevance score (higher = more relevant). */
  score: number;
  /** Document metadata if available. */
  metadata?: Record<string, unknown>;
}

/** Index statistics. */
export interface BM25Stats {
  /** Total documents in the index. */
  documentCount: number;
  /** Total unique terms across all documents. */
  termCount: number;
  /** Average document length in tokens. */
  avgDocLength: number;
}

/** What a {@link LexicalIndex} is made with. */
export interface LexicalIndexConfig {
  /** Term saturation. @default 1.2 */
  k1?: number;
  /** Length normalization, 0 to 1. @default 0.75 */
  b?: number;
  /** The words of a text. The same function must be given when a saved index is restored. */
  tokenize: (text: string) => string[];
}

/** How a search matches. */
export interface LexicalSearchOptions {
  /** `'any'` ranks documents holding at least one query word (the default); `'all'` keeps those holding every one. */
  match?: 'any' | 'all';
  /** When true a stored word matches when it begins with a query word. */
  prefix?: boolean;
}

/** A saved index: version 1. */
export interface LexicalIndexJSON {
  /** The format's version. */
  v: 1;
  /** The index's term saturation. */
  k1: number;
  /** The index's length normalization. */
  b: number;
  /** Each document as its id, its length in tokens and its metadata. */
  documents: Array<[id: string, length: number, metadata?: Record<string, unknown>]>;
  /** Each term with its postings: a document's position in `documents` and the term's count in it. */
  terms: Array<[term: string, postings: Array<[document: number, count: number]>]>;
}

/**
 * What keeps a saved index from having the shape {@link LexicalIndex.toJSON} writes, or undefined when nothing does:
 * `k1` and `b` are numbers, each document is `[id, length]` or `[id, length, metadata]`, and each term is
 * `[term, postings]` whose postings are `[position, count]` with the position of one of the documents.
 */
function shapeProblem(json: LexicalIndexJSON): string | undefined {
  if (typeof json.k1 !== 'number' || typeof json.b !== 'number') return 'k1 or b is not a number';
  const documents: unknown = json.documents;
  if (!Array.isArray(documents)) return 'documents are not an array';
  for (let at = 0; at < documents.length; at += 1) {
    const entry: unknown = documents[at];
    if (
      !Array.isArray(entry) ||
      typeof entry[0] !== 'string' ||
      typeof entry[1] !== 'number' ||
      (entry[2] !== undefined && (typeof entry[2] !== 'object' || entry[2] === null))
    ) {
      return `documents[${at}] is not [id, length] or [id, length, metadata]`;
    }
  }
  const terms: unknown = json.terms;
  if (!Array.isArray(terms)) return 'terms are not an array';
  for (let at = 0; at < terms.length; at += 1) {
    const entry: unknown = terms[at];
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) {
      return `terms[${at}] is not [term, postings]`;
    }
    for (const posting of entry[1] as unknown[]) {
      if (
        !Array.isArray(posting) ||
        !Number.isInteger(posting[0]) ||
        posting[0] < 0 ||
        posting[0] >= documents.length ||
        typeof posting[1] !== 'number'
      ) {
        return `terms[${at}] holds a posting that is not [position of a document, count]`;
      }
    }
  }
  return undefined;
}

/**
 * The BM25 engine over a caller's tokenizer. It imports nothing, so a page can load it; it ranks documents holding
 * any query word (or only those holding every one), matches a stored word whole or by a query word it begins with,
 * and is saved with {@link LexicalIndex.toJSON} and restored with {@link LexicalIndex.fromJSON}.
 *
 * A document's score is the sum, over the query's words, of
 * `IDF(t) * (tf(t,D) * (k1 + 1)) / (tf(t,D) + k1 * (1 - b + b * |D| / avgdl))`, with the Robertson-Walker
 * `IDF(t) = log((N - n(t) + 0.5) / (n(t) + 0.5) + 1)`.
 *
 * @example
 * ```typescript
 * const index = new LexicalIndex({ tokenize: lexicalTokens });
 * index.addDocument('s1#0', 'The chapters on the budget review');
 * index.search('chap budg', 10, { prefix: true, match: 'all' }); // the passage s1#0
 *
 * const saved = JSON.stringify(index.toJSON());
 * const restored = LexicalIndex.fromJSON(JSON.parse(saved), { tokenize: lexicalTokens });
 * ```
 */
export class LexicalIndex {
  /** Term saturation parameter (typical range: 1.2-2.0). */
  protected k1: number;
  /** Document length normalization (0 = none, 1 = full). */
  protected b: number;
  /** Map of document ID to internal document representation. */
  protected documents: Map<string, BM25Document>;
  /** Each term's documents with the term's count in each: `term -> { docId -> termFrequency }`. */
  protected invertedIndex: Map<string, Map<string, number>>;
  /** Each term's IDF, recomputed after documents are added or removed. */
  protected idf: Map<string, number>;
  /** Average document length across the index (in tokens). */
  protected avgDocLength: number;
  /** Whether the IDF cache needs recomputation. */
  protected idfDirty: boolean;
  /** The tokenizer this index was made with. */
  protected readonly tokenizeText: (text: string) => string[];

  /** Makes an empty index with the caller's tokenizer and, unless given, k1 1.2 and b 0.75. */
  constructor(config: LexicalIndexConfig) {
    this.k1 = config.k1 ?? 1.2;
    this.b = config.b ?? 0.75;
    this.tokenizeText = config.tokenize;
    this.documents = new Map();
    this.invertedIndex = new Map();
    this.idf = new Map();
    this.avgDocLength = 0;
    this.idfDirty = false;
  }

  /** Recomputes every term's IDF (Robertson-Walker) and the average document length. */
  protected recomputeIdf(): void {
    if (!this.idfDirty) return;
    const N = this.documents.size;
    this.idf.clear();
    for (const [term, docMap] of this.invertedIndex) {
      const n = docMap.size;
      this.idf.set(term, Math.log((N - n + 0.5) / (n + 0.5) + 1));
    }
    if (N === 0) {
      this.avgDocLength = 0;
    } else {
      let totalLength = 0;
      for (const doc of this.documents.values()) totalLength += doc.length;
      this.avgDocLength = totalLength / N;
    }
    this.idfDirty = false;
  }

  /** Adds a document, replacing one of the same id. */
  addDocument(id: string, text: string, metadata?: Record<string, unknown>): void {
    if (!id) throw new Error(`${this.constructor.name}.addDocument: id must not be empty.`);
    if (!text) throw new Error(`${this.constructor.name}.addDocument: text must not be empty.`);
    if (this.documents.has(id)) this.removeDocument(id);
    const tokens = this.tokenizeText(text);
    const termFreqs = new Map<string, number>();
    for (const token of tokens) termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1);
    this.documents.set(id, { id, length: tokens.length, metadata });
    for (const [term, freq] of termFreqs) {
      let docMap = this.invertedIndex.get(term);
      if (!docMap) {
        docMap = new Map();
        this.invertedIndex.set(term, docMap);
      }
      docMap.set(id, freq);
    }
    this.idfDirty = true;
  }

  /** Adds several documents. */
  addDocuments(docs: Array<{ id: string; text: string; metadata?: Record<string, unknown> }>): void {
    for (const doc of docs) this.addDocument(doc.id, doc.text, doc.metadata);
  }

  /** The stored terms a query word matches: itself, or every term that begins with it. */
  private termsFor(word: string, prefix: boolean): string[] {
    if (!prefix) return this.invertedIndex.has(word) ? [word] : [];
    const terms: string[] = [];
    for (const term of this.invertedIndex.keys()) {
      if (term.startsWith(word)) terms.push(term);
    }
    return terms;
  }

  /**
   * Searches. With no options it answers exactly what BM25Index has always answered.
   *
   * @param query - The query text, read with the index's tokenizer.
   * @param topK - The most results answered. @default 10
   * @param options - `match` and `prefix`; see {@link LexicalSearchOptions}.
   * @returns The matching documents, highest score first.
   */
  search(query: string, topK: number = 10, options: LexicalSearchOptions = {}): BM25Result[] {
    this.recomputeIdf();
    const queryTokens = this.tokenizeText(query);
    if (queryTokens.length === 0) return [];
    const prefix = options.prefix === true;
    const scores = new Map<string, number>();
    const matched = new Map<string, Set<string>>();
    const avgdl = this.avgDocLength || 1;
    for (const word of queryTokens) {
      // With a prefix several stored terms can match one query word: a document takes its best one.
      const best = new Map<string, number>();
      for (const term of this.termsFor(word, prefix)) {
        const idfValue = this.idf.get(term);
        const docMap = this.invertedIndex.get(term);
        if (idfValue === undefined || !docMap) continue;
        for (const [docId, tf] of docMap) {
          const doc = this.documents.get(docId)!;
          const numerator = tf * (this.k1 + 1);
          const denominator = tf + this.k1 * (1 - this.b + this.b * (doc.length / avgdl));
          const termScore = idfValue * (numerator / denominator);
          if (termScore > (best.get(docId) ?? -Infinity)) best.set(docId, termScore);
        }
      }
      for (const [docId, termScore] of best) {
        scores.set(docId, (scores.get(docId) ?? 0) + termScore);
        let words = matched.get(docId);
        if (!words) {
          words = new Set();
          matched.set(docId, words);
        }
        words.add(word);
      }
    }
    const needed = options.match === 'all' ? new Set(queryTokens).size : 0;
    const results: BM25Result[] = [];
    for (const [id, score] of scores) {
      if (needed > 0 && (matched.get(id)?.size ?? 0) < needed) continue;
      results.push({ id, score, metadata: this.documents.get(id)!.metadata });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /** Removes a document; true when it was there. */
  removeDocument(id: string): boolean {
    if (!this.documents.has(id)) return false;
    for (const [term, docMap] of this.invertedIndex) {
      docMap.delete(id);
      if (docMap.size === 0) this.invertedIndex.delete(term);
    }
    this.documents.delete(id);
    this.idfDirty = true;
    return true;
  }

  /** The index's size. */
  getStats(): BM25Stats {
    this.recomputeIdf();
    return { documentCount: this.documents.size, termCount: this.invertedIndex.size, avgDocLength: this.avgDocLength };
  }

  /** The index as plain JSON. */
  toJSON(): LexicalIndexJSON {
    const position = new Map<string, number>();
    const documents: LexicalIndexJSON['documents'] = [];
    for (const doc of this.documents.values()) {
      position.set(doc.id, documents.length);
      documents.push(doc.metadata === undefined ? [doc.id, doc.length] : [doc.id, doc.length, doc.metadata]);
    }
    const terms: LexicalIndexJSON['terms'] = [];
    for (const [term, docMap] of this.invertedIndex) {
      terms.push([term, [...docMap].map(([docId, count]) => [position.get(docId) as number, count])]);
    }
    return { v: 1, k1: this.k1, b: this.b, documents, terms };
  }

  /** Fills this index from a saved one, or throws an Error naming what keeps it from being one `toJSON` writes. */
  protected restore(json: LexicalIndexJSON): void {
    if (json?.v !== 1) throw new Error('LexicalIndex: a saved index of an unknown version.');
    const problem = shapeProblem(json);
    if (problem !== undefined) throw new Error(`LexicalIndex: a saved index whose ${problem}.`);
    this.k1 = json.k1;
    this.b = json.b;
    this.documents = new Map(json.documents.map(([id, length, metadata]) => [id, { id, length, metadata }]));
    this.invertedIndex = new Map(
      json.terms.map(([term, postings]) => [term, new Map(postings.map(([document, count]) => [json.documents[document][0], count]))]),
    );
    this.idf = new Map();
    this.idfDirty = true;
  }

  /**
   * A saved index restored, with the tokenizer it was made with.
   *
   * @throws {Error} When the saved index is of another version or lacks the shape {@link LexicalIndex.toJSON} writes;
   * the message names what is wrong.
   */
  static fromJSON(json: LexicalIndexJSON, config: Pick<LexicalIndexConfig, 'tokenize'>): LexicalIndex {
    const index = new LexicalIndex({ tokenize: config.tokenize });
    index.restore(json);
    return index;
  }
}
