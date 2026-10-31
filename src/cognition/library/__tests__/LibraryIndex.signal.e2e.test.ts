/**
 * @fileoverview A search's signal on the path a host wires: LibraryIndex, embedText and the vector stores taken from
 * the package's own entries (`@framers/agentos`, `@framers/agentos/cognition/library`,
 * `@framers/agentos/cognition/rag`), the query embedded by embedText as an HTTP request to a local server that answers
 * as OpenAI's embeddings endpoint, so a request cancelled in flight is seen on the wire. On InMemoryVectorStore in
 * every run, and on PostgresVectorStore under a host's search settings when AGENTOS_TEST_POSTGRES_URL names a database
 * with pgvector (CI's Test & Lint job sets it), every statement the store sends recorded at its pool. On the same path,
 * an endpoint that answers no vector for the query fails the search after that one request.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { embedText } from '@framers/agentos';
import {
  LibraryIndex,
  type LibraryIndexOptions,
  type LibraryScope,
  type LibrarySearch,
  type LibrarySource,
} from '@framers/agentos/cognition/library';
import { InMemoryVectorStore, PostgresVectorStore, type PgPoolLike } from '@framers/agentos/cognition/rag';

/** One request the embeddings server received. */
interface Received {
  /** The texts it asked to embed. */
  input: string[];
  /** True once the server answered it. */
  answered: boolean;
  /** Settles when the client closed it before the server answered: the request was cancelled in flight. */
  cut: Promise<void>;
  /** Answers it now, when it is still open. */
  answer: () => void;
}

/** Every request the server received in the current case, in order. */
const received: Received[] = [];
/** While true, a request is left open until its `answer`, or until the client gives it up. */
let holding = false;
/** While true, the server answers 200 with an empty `data`: no vector for any text. */
let noVectors = false;
/** The cases waiting for the next request. */
let waiting: Array<(request: Received) => void> = [];
let server: http.Server;
let origin = '';

/** Three topic words and a constant, so the dense leg ranks by topic. */
function topicVector(text: string): number[] {
  const lower = text.toLowerCase();
  return [/budget/.test(lower) ? 1 : 0, /weather/.test(lower) ? 1 : 0, /hiring/.test(lower) ? 1 : 0, 0.1];
}

/** The next request the server receives. */
function nextRequest(): Promise<Received> {
  return new Promise((resolve) => waiting.push(resolve));
}

/** True once the client cancelled the request before it was answered; false when that has not happened within `ms`. */
async function cutWithin(request: Received, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request.cut.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Gives a request or a statement started after the search settled the time to reach the server or the pool. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

/** Starts a search and marks its rejection handled, so the case reads it later with `rejects`. */
function started<T>(search: Promise<T>): Promise<T> {
  search.catch(() => undefined);
  return search;
}

/**
 * The embedding function as the library index page writes it: embedText on OpenAI's model, the search's signal
 * forwarded as its `abortSignal`; here its requests go to the local server.
 */
const embed: LibraryIndexOptions['embed'] = async (texts, options) =>
  (
    await embedText({
      provider: 'openai',
      model: 'text-embedding-3-small',
      apiKey: 'test-key',
      baseUrl: `${origin}/v1`,
      input: texts,
      abortSignal: options?.signal,
    })
  ).embeddings;

/** An embedding function written before a search took a signal: the texts alone, so its request is never cancelled. */
async function embedTextsAlone(texts: string[]): Promise<number[][]> {
  return (
    await embedText({ provider: 'openai', model: 'text-embedding-3-small', apiKey: 'test-key', baseUrl: `${origin}/v1`, input: texts })
  ).embeddings;
}

/** A kept session: its first passage on the offsite budget, its second on the weather. */
const SESSION: LibrarySource = {
  sourceId: 'session:a',
  kind: 'session',
  tenantId: 'org1',
  aclGroups: ['acct:ann'],
  tags: ['q3'],
  title: 'Offsite planning',
  passages: [{ text: 'The offsite budget is nine thousand euros, flights included.' }, { text: 'The weather in Lisbon was mentioned once.' }],
};

/** A document filed to the whole workspace. */
const DOCUMENT: LibrarySource = {
  sourceId: 'document:b',
  kind: 'document',
  tenantId: 'org1',
  aclGroups: ['org:org1'],
  title: 'Hiring plan',
  passages: [{ text: 'Hiring opens in May for the budget team.' }],
};

/** What ann may see in org1: her own session, and the document filed to the whole workspace. */
const ANN: LibraryScope = { tenantId: 'org1', aclGroups: ['acct:ann', 'org:org1'] };

/** The words searched. */
const TEXT = 'offsite budget';

/** How long a case may run: a search left waiting on a request nobody cancels fails here, not at the suite's limit. */
const CASE_MS = 30_000;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/embeddings') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"no such route"}}');
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; input: string[] };
      let closed = false;
      let markCut: () => void = () => undefined;
      const cut = new Promise<void>((resolve) => {
        markCut = () => resolve();
      });
      const request: Received = {
        input: body.input,
        answered: false,
        cut,
        answer: () => {
          if (request.answered || closed) return;
          request.answered = true;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              object: 'list',
              data: noVectors ? [] : body.input.map((text, index) => ({ object: 'embedding', index, embedding: topicVector(text) })),
              model: body.model,
              usage: { prompt_tokens: body.input.length, total_tokens: body.input.length },
            }),
          );
        },
      };
      res.on('close', () => {
        closed = true;
        if (!request.answered) markCut();
      });
      received.push(request);
      for (const notify of waiting.splice(0)) notify(request);
      if (!holding) request.answer();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
  holding = false;
  noVectors = false;
  waiting = [];
});

afterEach(() => {
  // A case that failed before its search settled leaves no request open, and the next suite's setup is answered.
  holding = false;
  noVectors = false;
  for (const request of received) request.answer();
});

describe('a search\'s signal on InMemoryVectorStore, its query embedded by embedText over HTTP', () => {
  it('cancels the embedding request in flight with the search, rejects with the signal\'s reason and asks the store nothing', async () => {
    const store = new InMemoryVectorStore();
    await store.initialize({ id: 'mem', type: 'in_memory' });
    await store.createCollection('library', 4);
    const index = new LibraryIndex({ store, collection: 'library', embed });
    await index.indexSource(SESSION);
    received.length = 0;
    const query = vi.spyOn(store, 'query');

    holding = true;
    const controller = new AbortController();
    const reason = new Error('the page closed');
    const arrival = nextRequest();
    const search = started(index.search({ text: TEXT, scope: ANN, mode: 'dense', signal: controller.signal }));
    const request = await arrival;
    expect(request.input).toEqual([TEXT]);
    controller.abort(reason);

    await expect(search).rejects.toBe(reason);
    expect(await cutWithin(request, 5_000)).toBe(true);
    await settle();
    expect(received).toHaveLength(1);
    expect(query).not.toHaveBeenCalled();
  }, CASE_MS);
});

describe('an embedding answer with no vector on InMemoryVectorStore, the query embedded by embedText over HTTP', () => {
  it('fails a search of several narrowings after its one embedding request, with or without a signal, and asks the store nothing', async () => {
    const store = new InMemoryVectorStore();
    await store.initialize({ id: 'mem', type: 'in_memory' });
    await store.createCollection('library', 4);
    const index = new LibraryIndex({ store, collection: 'library', embed });
    await index.indexSource(SESSION);
    const query = vi.spyOn(store, 'query');

    // The endpoint answers 200 with an empty `data`, so embedText answers no vector.
    noVectors = true;
    for (const signal of [undefined, new AbortController().signal]) {
      received.length = 0;
      await expect(
        index.search({ text: TEXT, scope: ANN, mode: 'dense', anyOf: [{ kinds: ['session'] }, { tags: ['q3'] }], signal }),
      ).rejects.toThrow('the embedder answered a different number of vectors than texts');
      await settle();
      expect(received.map((request) => request.input)).toEqual([[TEXT]]);
    }
    expect(query).not.toHaveBeenCalled();
  }, CASE_MS);
});

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const PREFIX = `sig${Date.now().toString(36)}_`;
const COLLECTION = 'chunks';
/** The collection's table as the store names it in its statements. */
const TABLE = `"${PREFIX}${COLLECTION}"`;

describe.skipIf(!POSTGRES_URL)('a search\'s signal on PostgresVectorStore as a host sets it, its query embedded by embedText over HTTP', () => {
  let pool: pg.Pool;
  let store: PostgresVectorStore;
  let index: LibraryIndex;
  /** Every statement the store sent through its pool or a connection of it, in order. */
  const statements: string[] = [];
  /** Told of each statement as the store sends it, before the database receives it. */
  let onStatement: ((sql: string) => void) | undefined;
  /** The statements that read or write the collection's table. */
  const onTable = (): string[] => statements.filter((sql) => sql.includes(TABLE));

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 4 });
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch (error) {
      // Another suite made the extension at the same moment (unique_violation); it exists now.
      if ((error as { code?: unknown } | null)?.code !== '23505') throw error;
    }
    for (const statement of PostgresVectorStore.schemaSql(COLLECTION, 4, { tablePrefix: PREFIX, textSearchConfig: 'simple' })) {
      await pool.query(statement);
    }
    // The pool as a host lends it to the store, every statement recorded on its way to the database.
    const recorded: PgPoolLike = {
      query: (sql, params) => {
        statements.push(sql);
        onStatement?.(sql);
        return pool.query(sql, params);
      },
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (sql: string, params?: unknown[]) => {
            statements.push(sql);
            onStatement?.(sql);
            return client.query(sql, params);
          },
          release: () => client.release(),
        };
      },
    };
    // A host's library store: the table its migration made from the store's own schema, the simple text
    // configuration, cosine, and pgvector's relaxed iterative scan with a wider candidate list.
    store = new PostgresVectorStore({
      id: 'signal',
      type: 'postgres',
      pool: recorded,
      manageSchema: false,
      tablePrefix: PREFIX,
      textSearchConfig: 'simple',
      similarityMetric: 'cosine',
      defaultDimension: 4,
      iterativeScan: 'relaxed_order',
      efSearch: 100,
    });
    index = new LibraryIndex({ store, collection: COLLECTION, embed });
    for (const source of [SESSION, DOCUMENT]) await index.indexSource(source);
  });

  beforeEach(() => {
    statements.length = 0;
    onStatement = undefined;
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await pool.end();
  });

  it('sends no embedding request and no statement for a search whose signal aborted before it started, in every mode', async () => {
    const shapes: Array<Pick<LibrarySearch, 'mode' | 'anyOf'>> = [
      { mode: 'lexical' },
      { mode: 'dense' },
      { mode: 'hybrid' },
      { mode: 'hybrid', anyOf: [{ kinds: ['session'] }, { kinds: ['document'] }] },
    ];
    for (const shape of shapes) {
      const reason = new Error(`a newer question, a ${shape.mode} search${shape.anyOf ? ' of two narrowings' : ''}`);
      await expect(index.search({ text: TEXT, scope: ANN, ...shape, signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    }
    // A signal aborted with no reason of its own, as a closed page's request signal is, rejects with its AbortError.
    const closed = AbortSignal.abort();
    await expect(index.search({ text: TEXT, scope: ANN, mode: 'hybrid', signal: closed })).rejects.toBe(closed.reason);
    expect((closed.reason as { name?: unknown }).name).toBe('AbortError');
    await settle();
    expect(received).toEqual([]);
    expect(statements).toEqual([]);
  }, CASE_MS);

  it('cancels the query\'s embedding request in flight with a dense or a hybrid search and sends the store no statement', async () => {
    for (const mode of ['dense', 'hybrid'] as const) {
      received.length = 0;
      statements.length = 0;
      holding = true;
      const controller = new AbortController();
      const reason = new Error(`the page closed during a ${mode} search`);
      const arrival = nextRequest();
      const search = started(index.search({ text: TEXT, scope: ANN, mode, signal: controller.signal }));
      const request = await arrival;
      expect(request.input).toEqual([TEXT]);
      controller.abort(reason);

      await expect(search).rejects.toBe(reason);
      expect(await cutWithin(request, 5_000)).toBe(true);
      await settle();
      expect(received).toHaveLength(1);
      expect(statements).toEqual([]);
    }
  }, CASE_MS);

  it('runs a question\'s two legs on its one signal: the lexical leg answers, the dense leg\'s request is cancelled in flight and no dense statement is sent', async () => {
    holding = true;
    const question = new AbortController();
    // The two legs as a host starts them together for one question, both on the question's signal.
    const legs = { text: TEXT, scope: ANN, match: 'any' as const, prefix: true, topK: 8, signal: question.signal };
    const arrival = nextRequest();
    const lexicalLeg = started(index.search({ ...legs, mode: 'lexical' }));
    const denseLeg = started(index.search({ ...legs, mode: 'dense' }));
    const request = await arrival;
    const lexical = await lexicalLeg;
    const reason = new Error('the page closed');
    question.abort(reason);

    await expect(denseLeg).rejects.toBe(reason);
    expect(await cutWithin(request, 5_000)).toBe(true);
    expect(lexical.map((passage) => passage.id).sort()).toEqual(['document:b#0', 'session:a#0']);
    await settle();
    expect(received).toHaveLength(1);
    // The lexical leg's one statement went; the dense leg's never did.
    expect(onTable()).toHaveLength(1);
    expect(onTable().some((sql) => sql.includes('<=>'))).toBe(false);
  }, CASE_MS);

  it('makes one embedding request for a search of several narrowings, its signal on it, and runs no leg once that request is cancelled', async () => {
    const anyOf = [{ kinds: ['session'] }, { kinds: ['document'] }];
    const found = await index.search({ text: TEXT, scope: ANN, mode: 'hybrid', anyOf, signal: new AbortController().signal });
    expect(found.map((passage) => passage.id).sort()).toEqual(['document:b#0', 'session:a#0', 'session:a#1']);
    expect(received.map((request) => request.input)).toEqual([[TEXT]]);
    // Each narrowing's dense leg and lexical leg.
    expect(onTable()).toHaveLength(4);

    received.length = 0;
    statements.length = 0;
    holding = true;
    const controller = new AbortController();
    const reason = new Error('a newer question');
    const arrival = nextRequest();
    const search = started(index.search({ text: TEXT, scope: ANN, mode: 'hybrid', anyOf, signal: controller.signal }));
    const request = await arrival;
    controller.abort(reason);

    await expect(search).rejects.toBe(reason);
    expect(await cutWithin(request, 5_000)).toBe(true);
    await settle();
    expect(received).toHaveLength(1);
    expect(statements).toEqual([]);
  }, CASE_MS);

  it('sends the store no statement when an embedding function that ignores the signal answers after the search was cancelled', async () => {
    const unaware = new LibraryIndex({ store, collection: COLLECTION, embed: embedTextsAlone });
    for (const mode of ['dense', 'hybrid'] as const) {
      received.length = 0;
      statements.length = 0;
      holding = true;
      const controller = new AbortController();
      const reason = new Error(`the page closed during a ${mode} search`);
      const arrival = nextRequest();
      const search = started(unaware.search({ text: TEXT, scope: ANN, mode, signal: controller.signal }));
      const request = await arrival;
      controller.abort(reason);
      // This embedding function was not handed the signal, so its request runs on and is answered after the abort.
      request.answer();

      await expect(search).rejects.toBe(reason);
      expect(request.answered).toBe(true);
      await settle();
      expect(statements).toEqual([]);
    }
  }, CASE_MS);

  it('lets a statement that started run to its end, drops its answer and starts no later leg once the signal aborts while the database answers', async () => {
    // A narrowing built from another search's options carries that search's live signal; the search's own still holds.
    const elsewhere = { kinds: ['session'], signal: new AbortController().signal };
    const shapes: Array<Pick<LibrarySearch, 'mode' | 'anyOf'>> = [
      { mode: 'dense' },
      { mode: 'hybrid' },
      { mode: 'lexical' },
      { mode: 'hybrid', anyOf: [{ kinds: ['session'] }, { kinds: ['document'] }] },
      { mode: 'hybrid', anyOf: [elsewhere, { kinds: ['document'] }] },
    ];
    for (const shape of shapes) {
      statements.length = 0;
      const controller = new AbortController();
      const reason = new Error(`the page closed while the database answered a ${shape.mode} search`);
      onStatement = (sql) => {
        if (sql.includes(TABLE)) controller.abort(reason);
      };
      await expect(index.search({ text: TEXT, scope: ANN, ...shape, signal: controller.signal })).rejects.toBe(reason);
      onStatement = undefined;
      // The one statement on the table that had started, and no other leg's; a dense or hybrid statement ran in its
      // transaction to the COMMIT.
      expect(onTable()).toHaveLength(1);
      if (shape.mode !== 'lexical') expect(statements[statements.length - 1]).toBe('COMMIT');
    }
  }, CASE_MS);

  it('answers the same passages with a live signal as without one, and hands the embedding function the texts alone without one, indexing included', async () => {
    const calls: unknown[][] = [];
    const recording = async (...args: unknown[]): Promise<number[][]> => {
      calls.push(args);
      return embed(args[0] as string[], args[1] as { signal?: AbortSignal } | undefined);
    };
    const recordingIndex = new LibraryIndex({ store, collection: COLLECTION, embed: recording, batchSize: 1 });
    // Indexing the session again replaces it with the same passages, one embedding call a passage.
    await recordingIndex.indexSource(SESSION);
    expect(calls.map((args) => args.length)).toEqual([1, 1]);

    calls.length = 0;
    const live = new AbortController();
    const shapes: Array<Pick<LibrarySearch, 'mode' | 'anyOf'>> = [
      { mode: 'lexical' },
      { mode: 'dense' },
      { mode: 'hybrid' },
      { mode: 'hybrid', anyOf: [{ kinds: ['session'] }, { kinds: ['document'] }] },
    ];
    for (const shape of shapes) {
      const without = await recordingIndex.search({ text: TEXT, scope: ANN, ...shape });
      const withSignal = await recordingIndex.search({ text: TEXT, scope: ANN, ...shape, signal: live.signal });
      expect(without.length).toBeGreaterThan(0);
      expect(withSignal).toEqual(without);
    }
    // The lexical searches embed nothing; each other search embedded its text once: the text alone without a signal,
    // and with one the signal as the second argument.
    expect(calls.map((args) => args.length)).toEqual([1, 2, 1, 2, 1, 2]);
    expect(calls.map((args) => args[0])).toEqual(Array.from({ length: 6 }, () => [TEXT]));
    for (const args of calls.filter((call) => call.length === 2)) {
      expect(Object.keys(args[1] as object)).toEqual(['signal']);
      expect((args[1] as { signal?: AbortSignal }).signal).toBe(live.signal);
    }
  }, CASE_MS);

  it('ends a search at its deadline: a signal joined from the request\'s own and a deadline\'s cancels the embedding request in flight and rejects with the TimeoutError', async () => {
    holding = true;
    const page = new AbortController();
    const deadline = new AbortController();
    // The search's one signal, joined from the page's own and the deadline's, as a host joins them.
    const signal = AbortSignal.any([page.signal, deadline.signal]);
    const arrival = nextRequest();
    const search = started(index.search({ text: TEXT, scope: ANN, mode: 'dense', signal }));
    const request = await arrival;
    // The deadline runs out once the request is in flight, however long the worker took to send it: an
    // AbortSignal.timeout started now ends the deadline with its TimeoutError.
    const timer = AbortSignal.timeout(50);
    timer.addEventListener('abort', () => deadline.abort(timer.reason), { once: true });

    const error = await search.then(
      () => undefined,
      (rejected: unknown) => rejected,
    );
    expect(error).toBe(timer.reason);
    expect(error).toBe(signal.reason);
    expect((error as { name?: unknown }).name).toBe('TimeoutError');
    expect(await cutWithin(request, 5_000)).toBe(true);
    await settle();
    expect(received).toHaveLength(1);
    expect(statements).toEqual([]);
  }, CASE_MS);
});
