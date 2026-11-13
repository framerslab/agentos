/**
 * @file LibraryIndex.ts
 * @description A library over any vector store: sources (a kept session, a document) held as units. A source's
 * passages are indexed under a tenant and access groups, the metadata keys scopeToMetadataFilter reads, with a
 * folder, tags and a title; a source is replaced, re-scoped or removed whole; a search names who asks and never
 * runs without a tenant and at least one group.
 *
 * The store's own filter selects what a search reads, and the index checks every passage the store answers against
 * the search's scope and narrowing, so a store whose filter drops or ignores a condition cannot widen a search. A
 * store serves the index fully when it honours these MetadataFilter rules: a plain value and `$eq`; `$in`, which on an
 * array field keeps a passage whose field holds at least one of the values; `$all` on an array field; and
 * DeleteOptions.filter on `delete`. Lexical search needs the store's optional lexicalSearch, a change of scope its
 * optional updateMetadata, and a grouped search (`searchGroups`: one search over the caller's own item lists, each
 * group counted, ranked and paged) its optional lexicalGroupSearch. PostgresVectorStore honours every rule and has
 * the three members; InMemoryVectorStore honours every rule and has none of them.
 *
 * @module agentos/cognition/library/LibraryIndex
 */

import { sha256Hex } from '../../core/utils/sha256.js';
import type {
  IVectorStore,
  LexicalGroupKey,
  LexicalGroupRow,
  MetadataFilter,
  MetadataScalarValue,
  MetadataValue,
  QueryResult,
  RetrievedVectorDocument,
  VectorDocument,
} from '../../core/vector-store/IVectorStore.js';
import {
  LEXICAL_GROUP_EXPANSION_MAX,
  LEXICAL_GROUP_WORDS_MAX as GROUP_WORDS_MAX,
  isLexicalGroupExpansion as isExpansion,
  isLexicalGroupInstant as isInstant,
  isLexicalGroupRank as isRank,
  isLexicalGroupSourceId as isSourceId,
} from '../../core/vector-store/lexicalGroupForms.js';
import { reciprocalRankFusion } from '../memory/retrieval/hybrid/reciprocalRankFusion.js';
import { withinOneEdit } from '../rag/search/FuzzyIndex.js';
import { mergeMetadataFilters, scopeToMetadataFilter } from '../rag/scopeFilter.js';
import { WORD_PATTERN, lexicalTokens } from './tokens.js';

/** Who asks: the tenant, and the groups the principal is in. */
export interface LibraryScope {
  tenantId: string;
  aclGroups: string[];
}

/** One source and its passages. */
export interface LibrarySource {
  /** Unique in the collection, for example `session:<id>`. */
  sourceId: string;
  /** The caller's kind of source, for example `session` or `document`. */
  kind: string;
  tenantId: string;
  /** The groups that may see it; a principal sees it when in at least one. */
  aclGroups: string[];
  folderId?: string | null;
  tags?: string[];
  title?: string;
  /**
   * Copied onto every passage. The keys the index writes come from the fields above alone: a `folderId` or `title`
   * here, or in a passage's own metadata, is dropped.
   */
  metadata?: Record<string, MetadataValue>;
  passages: Array<{ text: string; metadata?: Record<string, MetadataValue> }>;
}

/** A passage found. */
export interface LibraryPassage {
  /** `<sourceId>#<index>`. */
  id: string;
  sourceId: string;
  kind: string;
  index: number;
  text: string;
  /**
   * The store's score for the passage, as the search's mode and the store compute it, read as a number. A hybrid
   * search with `anyOf` on a store with `lexicalSearch` answers the index's fusion of the two legs' ranks instead; on
   * a store without it, that search runs the dense leg alone and answers the store's score.
   */
  score: number;
  title?: string;
  folderId?: string;
  tags: string[];
  metadata: Record<string, MetadataValue>;
}

/** A search. */
export interface LibrarySearch {
  text: string;
  scope: LibraryScope;
  /** `lexical` embeds nothing; `hybrid` fuses both legs where the store can; `dense` is the embedding alone. @default 'hybrid' */
  mode?: 'lexical' | 'hybrid' | 'dense';
  /** The most passages answered. @default 10 */
  topK?: number;
  /** Only these kinds of source; an empty list narrows nothing. */
  kinds?: string[];
  /** Only the sources filed in this folder. */
  folderId?: string;
  /**
   * Only the sources filed in any of these folders; an empty list finds nothing, without a call to the embedder or
   * the store. With `folderId` as well, both apply.
   */
  folderIds?: string[];
  /** Every one of these tags; an empty list narrows nothing. */
  tags?: string[];
  /** Only these sources; an empty list finds nothing, without a call to the embedder or the store. */
  sourceIds?: string[];
  /**
   * Several narrowings at once: a passage is found when any one of them holds. Each is searched with the one
   * embedding of the text under the same scope, a passage found twice kept once, and the answer is ranked as one
   * search's: each leg by the passage's own score across every branch (its similarity to the text, the lexical rank
   * of the text's words in it), the two legs of a hybrid search fused once. A branch's fields replace the search's
   * own of the same name. An empty list finds nothing, as does a list whose every branch finds nothing by its own
   * narrowing, and neither calls the embedder or the store. The legs are the store's `query` and `lexicalSearch`,
   * never its `hybridSearch`; on a store without `lexicalSearch`, a hybrid search is answered by the dense leg alone.
   */
  anyOf?: Array<Pick<LibrarySearch, 'kinds' | 'folderId' | 'folderIds' | 'tags' | 'sourceIds'>>;
  /** For the lexical leg, alone or in a hybrid search: every word or any word (default), and whether a stored word may only begin with a query word. */
  match?: 'all' | 'any';
  prefix?: boolean;
  /**
   * Cancels the search: checked before and after the query is embedded and before and after each call to the store,
   * and handed to the embedding function. Once it has aborted, the search starts no further call to the embedder or the
   * store and rejects with the signal's reason, or with the embedding function's error when the signal cancelled its
   * request; a store call that has started runs to its end, and its answer is dropped.
   */
  signal?: AbortSignal;
}

/** One item of a group: the caller's source id and the date the caller orders by, or null. */
export interface LibraryGroupItem {
  /** The source's id, as `indexSource` took it. */
  sourceId: string;
  /**
   * An ISO 8601 instant with its zone (`2026-03-01T09:30:00.000Z`) that names a real day and time, to the microsecond
   * at most, or null for an item with no date.
   */
  date: string | null;
}

/** The kinds a session's part passages carry in the `partKind` metadata key. */
export type LibraryPartKind = 'transcript' | 'summary' | 'decisions' | 'action_items' | 'next_steps';

/** One group the caller hands: its id, the items the caller's own rule admits, its fingerprint, and the part kinds that narrow it. */
export interface LibraryGroup {
  /** The group's name in the answer, one per group of a search. */
  id: string;
  /**
   * The items the search may read, each once: the search reads the passages of these sources and no other, for a
   * match, a count, a rank or a stored word to widen to. An empty list finds nothing, without a call to the store.
   */
  items: LibraryGroupItem[];
  /**
   * The caller's name for this list as it stands, any text that is not empty: a cursor keeps the one its page was
   * made under, and a later page handed another answers `restart`. The index compares it and never computes it.
   */
  fingerprint: string;
  /** Only the passages whose `partKind` is one of these; an empty list narrows nothing. */
  partKinds?: LibraryPartKind[];
}

/**
 * How an item ranks: each field's weight, a finite number above 0, read by a passage's `field` metadata key. A
 * passage with no `field`, or one `fields` does not name, takes the weight of `fallback`, which `fields` names. With
 * `title: 'metadata'` an item's title is read as well from its passages' `title` metadata key (the source's title,
 * which `indexSource` writes on every passage), as the field `title`; with `'passage'`, the default, a title ranks
 * only where a passage of its own holds it.
 */
export interface LibraryRankProfile {
  fields: Record<string, number>;
  fallback: string;
  title?: 'passage' | 'metadata';
}

/** A grouped search: the words (none for a listing), who asks, the groups, the order, the typo rule and the page. */
export interface LibraryGroupSearch {
  /** The query. Its words are read by `lexicalTokens`, each once, the first 32; with no word, every item is listed. */
  text: string;
  scope: LibraryScope;
  /** One group or more, each under an id of its own and searched on its own: its count, its page and its stored words are its items' alone. */
  groups: LibraryGroup[];
  profile: LibraryRankProfile;
  /**
   * `rank`: the highest rank first. `date`: the newest of the caller's dates first, an undated item after every dated
   * one in rank order. Level items stand in the order of their source ids. A listing with no word is in the date
   * order under either. @default 'rank'
   */
  order?: 'rank' | 'date';
  /**
   * `one-edit` widens each word of four letters or more to the stored words of the group's own passages, of four
   * letters or more, that are one edit away: a letter added, dropped or changed, or two side by side swapped.
   * @default 'none'
   */
  typo?: 'one-edit' | 'none';
  /**
   * The most stored words one edit away that a word is widened to, the most frequent kept: a whole number from 1 to
   * 64; a search asking for more is refused before the store is asked anything, as one tsquery holding more than 64 a
   * word for 32 words would pass what Postgres reads. A word with more marks its group `incomplete`, and so does a
   * stored word the store's query has no room for beside the search's words (on `PostgresVectorStore`, one tsquery of
   * a mebibyte). @default 64
   */
  expansionMax?: number;
  /** The most hits a group answers on a page: a whole number, 1 or more, that JavaScript holds exactly. */
  pageSize: number;
  /**
   * A later page of one group: the `cursor` an earlier page of the same search answered for it. The answer then
   * holds that group alone. A cursor made for another search throws a {@link LibraryCursorError}, and so does any
   * value but a cursor's text: the `null` a group answers after its last page is not read as a first page.
   */
  cursor?: string;
  /**
   * Stops the search: checked before each group and between the store's statements. Once it has aborted, the store
   * is asked nothing more, and the group being read and every group after it answer `incomplete` with no hit; a group
   * with no item is complete either way. The search does not reject on it.
   */
  signal?: AbortSignal;
}

/** One hit: an item by the passage that shows it. */
export interface LibraryGroupHit {
  /**
   * The item's passage that holds the most of the words, then the one of the strongest field, then the earliest; the
   * item's first passage in a listing, or when only its title read from the metadata matched. Its `score` is the
   * item's rank: for each word, the best of its matches over the item's passages, the field's weight times 1 for the
   * same word, 0.75 for a word it begins and 0.5 for a word one edit away, summed over the words; 0 in a listing.
   */
  passage: LibraryPassage;
  sourceId: string;
  /** The field of the match shown: the passage's, as the rank read it, or the title's when no passage holds a word. */
  field: string;
  /** How the first word the passage holds matched, or the first the item holds when the passage holds none; `none` in a listing. */
  matchKind: 'same' | 'start' | 'edit' | 'none';
  /** Where the passage's text holds the words, in UTF-16 units, in order: the words of the word rule that match. */
  marks: Array<{ start: number; end: number }>;
  /** Where the first mark starts, or -1 with none. */
  at: number;
  /** The passage's `partKind`, or null when it has none. */
  partKind: LibraryPartKind | null;
  /** The date the caller handed for the item. */
  date: string | null;
  /** True for an item that holds some of the words and not all. */
  anyWord: boolean;
}

/** One group's answer. */
export interface LibraryGroupResult {
  id: string;
  /**
   * `restart` when the cursor was made under another fingerprint than the group's, or under another scope: what the
   * search may read changed between two pages, nothing is answered, and the caller searches again from the first page.
   */
  state: 'ok' | 'restart';
  /** How many distinct items match every word, whatever the page; in a listing, how many hold a passage. */
  total: number;
  /**
   * True when a word had more stored words one edit away than `expansionMax`, or than the store's query holds, on the
   * page that read them and on every page after it, the hits then matching the ones kept; or when the signal stopped
   * the search, the group then holding no hit.
   */
  incomplete: boolean;
  /** What the next page takes as `cursor`, or null after the last. */
  cursor: string | null;
  hits: LibraryGroupHit[];
  /**
   * On a first page of two words or more where no item matches every word: the items that match some of them, at
   * most `pageSize`, outside `total` and with no cursor.
   */
  anyWord: LibraryGroupHit[];
}

/** A grouped search's answer: one result a group, in the order handed; under a cursor, its group's alone. */
export interface LibraryGroupAnswer {
  groups: LibraryGroupResult[];
}

/** What `searchGroups` throws for a cursor it refuses: one the index did not make, or one made for another search. */
export class LibraryCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryCursorError';
  }
}

/** What the index is made of. */
export interface LibraryIndexOptions {
  store: IVectorStore;
  collection: string;
  /**
   * One vector per text, in order: an answer of any other count fails the call, a search before it asks the store
   * anything and `indexSource` before it writes the batch. The caller wires its model, its budget and its deadline. A
   * search hands it the search's `signal` as `options.signal`, so a request in flight is cancelled with the search;
   * indexing, and a search with no signal, pass no options.
   */
  embed: (texts: string[], options?: { signal?: AbortSignal }) => Promise<number[][]>;
  /** How many passages one `embed` call and one upsert carry. @default 64 */
  batchSize?: number;
}

/**
 * Metadata without `folderId` and `title`: like the other keys the index writes, a passage holds them only when the
 * source's own fields set them, so a source indexed without a folder is in none, whatever its metadata or a
 * passage's own says.
 */
function withoutSourceFields(metadata: Record<string, MetadataValue> | undefined): Record<string, MetadataValue> {
  const rest: Record<string, MetadataValue> = { ...(metadata ?? {}) };
  delete rest.folderId;
  delete rest.title;
  return rest;
}

/** What `indexSource` and `search` throw when the embedding function answers other than one vector per text. */
const VECTOR_COUNT_MISMATCH = 'LibraryIndex: the embedder answered a different number of vectors than texts.';

/**
 * A store may report a failed write or delete in its result instead of throwing (InMemoryVectorStore does for a
 * vector of the wrong dimension); the index throws on such a result as on a thrown error.
 */
function throwOnReportedFailure(result: { failedCount?: number; errors?: Array<{ message: string }> }, action: string): void {
  const failed = Math.max(result.failedCount ?? 0, result.errors?.length ?? 0);
  if (failed === 0) return;
  const reason = result.errors?.[0]?.message;
  throw new Error(`LibraryIndex: the store failed to ${action} (${failed} failed)${reason ? `: ${reason}` : '.'}`);
}

/** A metadata value's strings: the value itself when it is a string, an array's strings, or none. */
function stringsOf(value: MetadataValue | undefined): string[] {
  const values: MetadataScalarValue[] = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.filter((item): item is string => typeof item === 'string');
}

/** Whether a passage's metadata is in a scope: its tenant, the status `active`, and at least one of its groups. */
function meetsScope(metadata: Record<string, MetadataValue>, scope: LibraryScope): boolean {
  return (
    metadata.tenantId === scope.tenantId &&
    stringsOf(metadata.status).includes('active') &&
    stringsOf(metadata.aclGroups).some((group) => scope.aclGroups.includes(group))
  );
}

/**
 * Whether a passage's metadata meets a search's scope and narrowing, the conditions of the filter the store receives:
 * the tenant, the status `active`, at least one of the scope's groups, and each narrowing the search gives.
 */
function meetsSearch(metadata: Record<string, MetadataValue>, query: LibrarySearch): boolean {
  const { scope, kinds, folderId, folderIds, tags, sourceIds } = query;
  const held = (key: string): string[] => stringsOf(metadata[key]);
  return (
    meetsScope(metadata, scope) &&
    (!kinds || kinds.length === 0 || held('kind').some((kind) => kinds.includes(kind))) &&
    (!folderId || held('folderId').includes(folderId)) &&
    (!folderIds || held('folderId').some((id) => folderIds.includes(id))) &&
    (!tags || tags.every((tag) => held('tags').includes(tag))) &&
    (!sourceIds || held('sourceId').some((id) => sourceIds.includes(id)))
  );
}

/**
 * Whether a narrowing finds nothing, whatever the collection holds: an empty `sourceIds` or `folderIds`, or a
 * `folderId` that is not among the `folderIds`. The index answers it without a call to the embedder or the store.
 */
function findsNothing(query: Pick<LibrarySearch, 'folderId' | 'folderIds' | 'sourceIds'>): boolean {
  const { folderId, folderIds, sourceIds } = query;
  if (sourceIds && sourceIds.length === 0) return true;
  if (!folderIds) return false;
  if (folderIds.length === 0) return true;
  return folderId ? !folderIds.includes(folderId) : false;
}

/** A passage the store answered, as a search answers it, under the score given. */
function passageOf(doc: RetrievedVectorDocument, score: number): LibraryPassage {
  const metadata = (doc.metadata ?? {}) as Record<string, MetadataValue>;
  return {
    id: doc.id,
    sourceId: String(metadata.sourceId ?? ''),
    kind: String(metadata.kind ?? ''),
    index: Number(metadata.index ?? 0),
    text: doc.textContent ?? '',
    score,
    title: typeof metadata.title === 'string' ? metadata.title : undefined,
    folderId: typeof metadata.folderId === 'string' ? metadata.folderId : undefined,
    tags: Array.isArray(metadata.tags) ? metadata.tags.map(String) : [],
    metadata,
  };
}

/** The part kinds a group may narrow to. */
const PART_KINDS: readonly LibraryPartKind[] = ['transcript', 'summary', 'decisions', 'action_items', 'next_steps'];

/** The most stored words one edit away a word is widened to, unless the search asks for fewer; the most it may ask for. */
const EXPANSION_MAX = LEXICAL_GROUP_EXPANSION_MAX;

/** The fewest letters a query word and a stored word each need to match one edit apart. */
const EDIT_MIN_LETTERS = 4;

/** The words of a passage's text by the word rule, for the marks of a hit; `matchAll` reads a copy of it. */
const PASSAGE_WORDS = new RegExp(WORD_PATTERN, 'gu');

/** A group of a grouped search, checked. */
interface CheckedGroup {
  id: string;
  fingerprint: string;
  /** The items as handed, each with its date or null. */
  items: LibraryGroupItem[];
  /** Each item's date by its source id. */
  dates: Map<string, string | null>;
  /** The part kinds that narrow the group, each once, in order; null when none does. */
  partKinds: LibraryPartKind[] | null;
}

/** A grouped search, checked, with its defaults set. */
interface CheckedGroupSearch {
  words: string[];
  scope: LibraryScope;
  groups: CheckedGroup[];
  profile: LibraryRankProfile;
  order: 'rank' | 'date';
  typo: 'one-edit' | 'none';
  expansionMax: number;
  pageSize: number;
  signal: AbortSignal | undefined;
}

/** What a cursor carries: the group, the fingerprint, the scope and the search its page was made under, and where the page ended. */
interface LibraryCursor {
  v: 1;
  groupId: string;
  fingerprint: string;
  /** The scope the page was read under ({@link scopeMarkOf}). */
  scope: string;
  /** The signature of the search ({@link signatureOf}). */
  sig: string;
  words: string[];
  /** For each word, the stored words one edit away that the first page found. */
  expansion: string[][];
  /** Whether the first page left stored words out: a word had more of them one edit away than the limit. */
  over: boolean;
  /** The last item's place in the page's order: its rank and source id, after its date under the date order. */
  key: Array<string | null>;
}

/**
 * A grouped search with every part checked, before the store is asked anything.
 *
 * @throws When the scope has no tenant or no group, when no group is handed, or when a part is not in the form
 *   {@link LibraryGroupSearch} gives it.
 */
function groupSearchOf(query: LibraryGroupSearch): CheckedGroupSearch {
  const refused = (what: string): Error => new Error(`LibraryIndex.searchGroups: ${what}.`);
  const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
  if (!query.scope?.tenantId || !Array.isArray(query.scope.aclGroups) || query.scope.aclGroups.length === 0) {
    throw new Error('LibraryIndex.searchGroups needs a tenant and at least one access group.');
  }
  if (!Array.isArray(query.groups) || query.groups.length === 0) throw new Error('LibraryIndex.searchGroups needs at least one group.');
  if (typeof query.text !== 'string') throw refused('the text must be a string');

  const fields = query.profile?.fields;
  const names = fields !== null && typeof fields === 'object' ? Object.keys(fields) : [];
  if (names.length === 0 || names.some((name) => !(typeof fields[name] === 'number' && Number.isFinite(fields[name]) && fields[name] > 0))) {
    throw refused("each of the profile's fields needs a weight, a finite number above 0");
  }
  const { fallback, title } = query.profile;
  if (typeof fallback !== 'string' || !names.includes(fallback)) throw refused("the profile's fallback must be one of its fields");
  if (title !== undefined && title !== 'passage' && title !== 'metadata') throw refused("the profile's title must be 'passage' or 'metadata'");
  if (query.order !== undefined && query.order !== 'rank' && query.order !== 'date') throw refused("the order must be 'rank' or 'date'");
  if (query.typo !== undefined && query.typo !== 'one-edit' && query.typo !== 'none') throw refused("the typo rule must be 'one-edit' or 'none'");
  if (query.expansionMax !== undefined && !(whole(query.expansionMax) && query.expansionMax <= EXPANSION_MAX)) {
    throw refused(`expansionMax must be a whole number from 1 to ${EXPANSION_MAX}`);
  }
  if (!whole(query.pageSize)) throw refused(`pageSize must be a whole number from 1 to ${Number.MAX_SAFE_INTEGER}`);

  const handed = new Set<string>();
  const groups = query.groups.map((group): CheckedGroup => {
    if (group === null || typeof group !== 'object' || typeof group.id !== 'string' || group.id === '') throw refused('each group needs an id');
    if (handed.has(group.id)) throw refused(`the group ${group.id} is handed twice`);
    handed.add(group.id);
    if (typeof group.fingerprint !== 'string' || group.fingerprint === '') throw refused(`the group ${group.id} needs its fingerprint`);
    if (!Array.isArray(group.items)) throw refused(`the group ${group.id} needs its items`);
    const dates = new Map<string, string | null>();
    for (const item of group.items) {
      if (item === null || typeof item !== 'object' || !isSourceId(item.sourceId)) {
        throw refused(`each item of the group ${group.id} needs its sourceId, a text that is not empty and holds no NUL`);
      }
      if (dates.has(item.sourceId)) throw refused(`the item ${item.sourceId} of the group ${group.id} is listed twice`);
      const date = item.date ?? null;
      if (date !== null && !isInstant(date)) {
        throw refused(
          `the date of the item ${item.sourceId} must be an ISO 8601 instant with its zone that names a real day and time, to the microsecond at most, or null`,
        );
      }
      dates.set(item.sourceId, date);
    }
    const kinds: unknown = group.partKinds;
    if (kinds !== undefined && !(Array.isArray(kinds) && kinds.every((kind) => PART_KINDS.includes(kind)))) {
      throw refused(`the partKinds of the group ${group.id} must be among ${PART_KINDS.join(', ')}`);
    }
    const partKinds = PART_KINDS.filter((kind) => group.partKinds?.includes(kind));
    return {
      id: group.id,
      fingerprint: group.fingerprint,
      items: Array.from(dates, ([sourceId, date]) => ({ sourceId, date })),
      dates,
      partKinds: partKinds.length > 0 ? partKinds : null,
    };
  });

  return {
    words: [...new Set(lexicalTokens(query.text))].slice(0, GROUP_WORDS_MAX),
    scope: { tenantId: query.scope.tenantId, aclGroups: [...query.scope.aclGroups] },
    groups,
    profile: { fields: Object.fromEntries(names.map((name) => [name, fields[name]])), fallback, title: title ?? 'passage' },
    order: query.order ?? 'rank',
    typo: query.typo ?? 'none',
    expansionMax: query.expansionMax ?? EXPANSION_MAX,
    pageSize: query.pageSize,
    signal: query.signal,
  };
}

/**
 * The signature of one group's search: the SHA-256, in hex, of what decides which items a page holds and in what
 * order, apart from the list itself: the words, the order, the profile with its fields in the order of their names,
 * the part kinds or null, the typo rule, the expansion limit and the group's id. A cursor carries it, so a cursor
 * read under another order, profile or narrowing is told apart even where the item list is the same.
 */
function signatureOf(search: CheckedGroupSearch, group: CheckedGroup): string {
  const { profile } = search;
  const fields = Object.keys(profile.fields).sort().map((name): [string, number] => [name, profile.fields[name]]);
  return sha256Hex(
    JSON.stringify([
      search.words,
      search.order,
      { fallback: profile.fallback, fields, title: profile.title },
      group.partKinds,
      search.typo,
      search.expansionMax,
      group.id,
    ]),
  );
}

/**
 * A scope as a cursor keeps it: the SHA-256, in hex, of the tenant and the access groups, each group once and in
 * order, so the same groups handed in another order are the same scope. A page is ranked over what one scope may
 * read, and a later page asked under another has nothing to continue.
 */
function scopeMarkOf(scope: LibraryScope): string {
  return sha256Hex(JSON.stringify([scope.tenantId, [...new Set(scope.aclGroups)].sort()]));
}

/** A cursor as the text a caller keeps: its JSON in UTF-8, in base64url without padding. */
function cursorEncode(cursor: LibraryCursor): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(JSON.stringify(cursor))) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * What a cursor's text carries, each field checked for its type. The values are checked against the search by
 * `searchGroups`.
 *
 * @throws LibraryCursorError when the text is not base64url, not JSON, or not in a cursor's form.
 */
function cursorDecode(cursor: unknown): LibraryCursor {
  const refused = (): LibraryCursorError => new LibraryCursorError('LibraryIndex.searchGroups: the cursor is not one this index made.');
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length % 4 === 1) throw refused();
  let payload: unknown;
  try {
    const padded = cursor.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (cursor.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (unit) => unit.charCodeAt(0));
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw refused();
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw refused();
  const { v, groupId, fingerprint, scope, sig, words, expansion, over, key } = payload as Record<string, unknown>;
  const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
  if (
    v !== 1 ||
    typeof groupId !== 'string' ||
    typeof fingerprint !== 'string' ||
    typeof scope !== 'string' ||
    typeof sig !== 'string' ||
    !texts(words) ||
    !Array.isArray(expansion) ||
    !expansion.every((list) => texts(list)) ||
    typeof over !== 'boolean' ||
    !Array.isArray(key) ||
    !key.every((part) => part === null || typeof part === 'string')
  ) {
    throw refused();
  }
  return { v: 1, groupId, fingerprint, scope, sig, words, expansion: expansion as string[][], over, key: key as Array<string | null> };
}

/**
 * Whether the stored words a cursor carries are words its search reaches, as the store draws them: one list a word,
 * at most `expansionMax` long (64 at most), each stored word once, and none at all without the one-edit rule; each stored word one
 * edit from its query word where both hold four letters or more, and neither that word nor a word it begins, which
 * match as such and are never drawn. The words are held first to what one tsquery holds beside the search's own words
 * (each at most 2046 bytes, all of them under a mebibyte with those words), so a cursor adds no word to a search and
 * never carries more than its statement can write.
 */
function reachesEveryWord(search: CheckedGroupSearch, expansion: string[][]): boolean {
  if (!isExpansion(expansion, search.words)) return false;
  return expansion.every((list, at) => {
    if (list.length === 0) return true;
    if (search.typo !== 'one-edit' || list.length > search.expansionMax || new Set(list).size !== list.length) return false;
    const word = search.words[at];
    if (Array.from(word).length < EDIT_MIN_LETTERS) return false;
    return list.every(
      (stored) =>
        stored !== word &&
        !stored.startsWith(word) &&
        Array.from(stored).length >= EDIT_MIN_LETTERS &&
        withinOneEdit(word, stored),
    );
  });
}

/**
 * The place a cursor's key names in a page's order, or null when the key is not in the order's form: a rank a Postgres
 * numeric holds and a source id that holds no NUL, after a date or null under the date order, the date a real instant
 * as an item's must be. A key out of the form is refused here and never reaches a statement, which would fail on it.
 */
function placeOf(key: Array<string | null>, dated: boolean): LexicalGroupKey | null {
  const [date, rank, sourceId] = dated ? key : [null, ...key];
  if (key.length !== (dated ? 3 : 2) || !isRank(rank) || !isSourceId(sourceId)) {
    return null;
  }
  if (!dated) return { rank, sourceId };
  return date === null || isInstant(date) ? { date, rank, sourceId } : null;
}

/**
 * Where a passage's text holds the words it matched: each word of the text, by the word rule, read in NFC and in
 * lower case, that is a held query word, begins with one, or is one of the stored words that word was widened to.
 * The places are the text's own, in UTF-16 units, in order.
 */
function marksOf(text: string, wanted: Array<{ word: string; near: readonly string[] }>): Array<{ start: number; end: number }> {
  if (wanted.length === 0) return [];
  const marks: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(PASSAGE_WORDS)) {
    const word = match[0].normalize('NFC').toLowerCase();
    if (wanted.some((held) => word.startsWith(held.word) || held.near.includes(word))) {
      const start = match.index ?? 0;
      marks.push({ start, end: start + match[0].length });
    }
  }
  return marks;
}

/**
 * A library's sources in one collection of a vector store. Every passage of a source carries the source's tenant,
 * access groups, kind, folder, tags and title in its metadata, so the store's own filter selects who sees it and the
 * index checks what the store answers: `indexSource` replaces a source whole, `setSourceScope` changes who may see it
 * and where it is filed, `removeSource` and `removeTenant` delete, and `search` reads only what its scope may see.
 */
export class LibraryIndex {
  private readonly store: IVectorStore;
  private readonly collection: string;
  private readonly embed: (texts: string[], options?: { signal?: AbortSignal }) => Promise<number[][]>;
  private readonly batchSize: number;

  /** An index over a collection the store already holds; the index makes no collection. */
  constructor(options: LibraryIndexOptions) {
    this.store = options.store;
    this.collection = options.collection;
    this.embed = options.embed;
    this.batchSize = Math.max(1, options.batchSize ?? 64);
  }

  /**
   * Indexes a source, replacing whatever the collection held under its id: the old passages are deleted first, then
   * the new ones are embedded and written `batchSize` at a time. A failed batch leaves the passages written before
   * it, and indexing the source again replaces them. A delete or a write the store reports as failed in its result,
   * instead of throwing, fails the call as well.
   */
  async indexSource(source: LibrarySource): Promise<{ passages: number }> {
    if (!source.tenantId || source.aclGroups.length === 0) {
      throw new Error('LibraryIndex.indexSource needs a tenant and at least one access group.');
    }
    await this.removeSource(source.sourceId);
    const owned: Record<string, MetadataValue> = {
      tenantId: source.tenantId,
      aclGroups: source.aclGroups,
      status: 'active',
      sourceId: source.sourceId,
      kind: source.kind,
      tags: source.tags ?? [],
    };
    if (source.folderId) owned.folderId = source.folderId;
    if (source.title) owned.title = source.title;
    const inherited = withoutSourceFields(source.metadata);
    for (let from = 0; from < source.passages.length; from += this.batchSize) {
      const batch = source.passages.slice(from, from + this.batchSize);
      const vectors = await this.embed(batch.map((passage) => passage.text));
      if (vectors.length !== batch.length) throw new Error(VECTOR_COUNT_MISMATCH);
      const documents: VectorDocument[] = batch.map((passage, offset) => ({
        id: `${source.sourceId}#${from + offset}`,
        embedding: vectors[offset],
        textContent: passage.text,
        metadata: { ...withoutSourceFields(passage.metadata), ...inherited, ...owned, index: from + offset },
      }));
      throwOnReportedFailure(await this.store.upsert(this.collection, documents), `write the passages of ${source.sourceId}`);
    }
    return { passages: source.passages.length };
  }

  /**
   * Removes a source's passages and answers the store's `deletedCount`: how many went on a store that counts a delete
   * by filter, as PostgresVectorStore and InMemoryVectorStore do, and the store's own value on one that does not (-1
   * on PineconeVectorStore, 0 on QdrantVectorStore). Throws when the store reports the delete as failed.
   */
  async removeSource(sourceId: string): Promise<number> {
    const result = await this.store.delete(this.collection, undefined, { filter: { sourceId } });
    throwOnReportedFailure(result, `delete the passages of ${sourceId}`);
    return result.deletedCount;
  }

  /**
   * Removes every passage of one tenant and answers the store's `deletedCount`, as `removeSource` does. Throws when
   * the store reports the delete as failed.
   */
  async removeTenant(tenantId: string): Promise<number> {
    const result = await this.store.delete(this.collection, undefined, { filter: { tenantId } });
    throwOnReportedFailure(result, `delete the passages of tenant ${tenantId}`);
    return result.deletedCount;
  }

  /** Changes who may see a source, its folder, its tags or its title; `folderId: null` takes it out of its folder. */
  async setSourceScope(
    sourceId: string,
    change: { aclGroups?: string[]; folderId?: string | null; tags?: string[]; title?: string },
  ): Promise<number> {
    if (typeof this.store.updateMetadata !== 'function') throw new Error('LibraryIndex: the store has no updateMetadata.');
    if (change.aclGroups !== undefined && change.aclGroups.length === 0) {
      throw new Error('LibraryIndex.setSourceScope needs at least one access group.');
    }
    const patch: Record<string, MetadataValue | null> = {};
    if (change.aclGroups !== undefined) patch.aclGroups = change.aclGroups;
    if (change.folderId !== undefined) patch.folderId = change.folderId;
    if (change.tags !== undefined) patch.tags = change.tags;
    if (change.title !== undefined) patch.title = change.title;
    const result = await this.store.updateMetadata(this.collection, { sourceId }, patch);
    return result.updatedCount;
  }

  /**
   * Searches what the scope may see. The store's filter selects the passages, and the index keeps only those whose
   * metadata meets the scope and the narrowing: a store whose filter drops or ignores a condition cannot widen the
   * answer, which can then hold fewer than `topK` passages. With `anyOf`, each narrowing is searched leg by leg under
   * the same scope and the answers are ranked as one search's ({@link LibrarySearch.anyOf}). Once its `signal` has
   * aborted, a search starts no further call to the embedder or the store and rejects ({@link LibrarySearch.signal}).
   */
  async search(query: LibrarySearch): Promise<LibraryPassage[]> {
    query.signal?.throwIfAborted();
    if (!query.scope.tenantId || query.scope.aclGroups.length === 0) {
      throw new Error('LibraryIndex.search needs a tenant and at least one access group.');
    }
    const { anyOf, ...base } = query;
    if (anyOf === undefined) return this.searchWith(query, undefined);
    // A branch narrows and nothing more: the text, the scope and the signal stay the search's own, whatever a branch
    // holds at run time. A branch that finds nothing by its own narrowing is left out, so a choice of nothing embeds
    // nothing.
    const branches = anyOf
      .map((branch) => ({ ...base, ...branch, text: base.text, scope: base.scope, signal: base.signal }))
      .filter((narrowed) => !findsNothing(narrowed));
    if (branches.length === 0) return [];
    const mode = base.mode ?? 'hybrid';
    const topK = base.topK ?? 10;
    const dense = mode !== 'lexical';
    const lexical = mode === 'lexical' || (mode === 'hybrid' && typeof this.store.lexicalSearch === 'function');
    // A hybrid answer's score is a rank among one branch's own candidates, so a choice of several branches is searched
    // leg by leg, each leg's score the passage's own, and the two legs are fused once over every branch.
    const pool = dense && lexical ? topK * 3 : topK;
    const vector = dense ? await this.embedQuery(base.text, base.signal) : undefined;
    const byDense = new Map<string, LibraryPassage>();
    const byLexical = new Map<string, LibraryPassage>();
    for (const narrowed of branches) {
      if (dense) for (const passage of await this.searchWith({ ...narrowed, topK: pool, mode: 'dense' }, vector)) byDense.set(passage.id, passage);
      if (lexical) for (const passage of await this.searchWith({ ...narrowed, topK: pool, mode: 'lexical' }, undefined)) byLexical.set(passage.id, passage);
    }
    const ranked = (found: Map<string, LibraryPassage>): LibraryPassage[] =>
      [...found.values()].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, pool);
    if (!lexical) return ranked(byDense).slice(0, topK);
    if (!dense) return ranked(byLexical).slice(0, topK);
    const ranks = (found: Map<string, LibraryPassage>) => ranked(found).map((passage, at) => ({ id: passage.id, rank: at + 1 }));
    return reciprocalRankFusion(ranks(byDense), ranks(byLexical), { denseWeight: 1, sparseWeight: 1, k: 60 })
      .slice(0, topK)
      .flatMap(({ id, score }): LibraryPassage[] => {
        const passage = byDense.get(id) ?? byLexical.get(id);
        return passage === undefined ? [] : [{ ...passage, score }];
      });
  }

  /**
   * The query's embedding. None is asked for once the search's signal has aborted: the search rejects with the
   * signal's reason. The embedding function receives the signal, when the search gives one, to cancel its request. An
   * answer of other than one vector throws, as it does in `indexSource`, so no store call receives a query without its
   * vector and a search of several narrowings never embeds its text again; a signal that aborted while the text was
   * embedded rejects with its reason first, whatever the answer.
   */
  private async embedQuery(text: string, signal: AbortSignal | undefined): Promise<number[]> {
    signal?.throwIfAborted();
    const vectors = signal === undefined ? await this.embed([text]) : await this.embed([text], { signal });
    signal?.throwIfAborted();
    if (vectors.length !== 1) throw new Error(VECTOR_COUNT_MISMATCH);
    return vectors[0];
  }

  /**
   * One search under one narrowing: the store's filter, then the check of every passage the store answers. `vector`
   * is the text's embedding when the caller holds it already; without it, a dense or hybrid search embeds the text.
   */
  private async searchWith(query: LibrarySearch, vector: number[] | undefined): Promise<LibraryPassage[]> {
    // An empty source or folder list finds nothing on every store, whatever a store's filter makes of an empty `$in`,
    // and so does a folder that is not in the folder list.
    if (findsNothing(query)) return [];
    const narrowed: MetadataFilter = {};
    if (query.kinds && query.kinds.length > 0) narrowed.kind = { $in: query.kinds };
    if (query.folderId) narrowed.folderId = query.folderId;
    // With `folderId` as well, that folder is in the list (findsNothing holds the rest), so it alone narrows.
    if (query.folderIds && !query.folderId) narrowed.folderId = { $in: query.folderIds };
    if (query.tags && query.tags.length > 0) narrowed.tags = { $all: query.tags };
    if (query.sourceIds) narrowed.sourceId = { $in: query.sourceIds };
    const filter = mergeMetadataFilters(narrowed, scopeToMetadataFilter({ tenantId: query.scope.tenantId, aclGroups: query.scope.aclGroups }));
    const options = { topK: query.topK ?? 10, filter, includeMetadata: true, includeTextContent: true };
    const mode = query.mode ?? 'hybrid';
    let result: QueryResult;
    // No call to the store starts once the search's signal has aborted, whether it aborted while the query was embedded
    // (an embedding function may ignore the signal) or during an earlier leg of a search with `anyOf`; a store call
    // that has started runs to its end, and its answer is dropped when the signal aborted meanwhile.
    if (mode === 'lexical') {
      if (typeof this.store.lexicalSearch !== 'function') throw new Error('LibraryIndex: the store has no lexicalSearch.');
      query.signal?.throwIfAborted();
      result = await this.store.lexicalSearch(this.collection, query.text, { topK: options.topK, match: query.match ?? 'any', prefix: query.prefix === true, includeMetadata: true, includeTextContent: true, filter });
    } else {
      const embedded = vector === undefined ? await this.embedQuery(query.text, query.signal) : vector;
      query.signal?.throwIfAborted();
      result =
        mode === 'hybrid' && typeof this.store.hybridSearch === 'function'
          ? await this.store.hybridSearch(this.collection, embedded, query.text, { ...options, match: query.match ?? 'any', prefix: query.prefix === true })
          : await this.store.query(this.collection, embedded, options);
    }
    query.signal?.throwIfAborted();
    // The store's filter selected these passages. A store whose filter drops or ignores a condition can still answer
    // one outside the scope or the narrowing, so each passage is checked against them again here.
    const allowed = result.documents.filter((doc) => meetsSearch((doc.metadata ?? {}) as Record<string, MetadataValue>, query));
    // A store can answer a score as numeric text (node-postgres returns a Postgres numeric as a string), so the index
    // reads it as a number.
    return allowed.map((doc) => passageOf(doc, Number(doc.similarityScore)));
  }

  /**
   * One search over the caller's own item lists, in named groups, on the store's lexical index, with no embedding.
   * Each group is searched on its own, in the order handed, inside the scope and the items the caller hands for it
   * and nowhere else, and answers:
   *
   * - `total`: the count of its distinct items that match every word, whatever the page. An item matches when every
   *   word matches in at least one of its passages, the same passage or different ones: the same word, a word it
   *   begins, or, under `typo: 'one-edit'`, a stored word of the group's own passages one edit away.
   * - `hits`: a page of those items, each by its best passage, in the order of `order`, with the words marked.
   * - `cursor`: what the next page takes. It is bound to the words, the order, the profile, the part kinds, the typo
   *   rule and its limit, the group and the stored words the first page found, which a later page matches again and
   *   never reads anew, and it keeps the group's fingerprint and the scope: a later page handed another fingerprint,
   *   or asked under another tenant or other access groups, answers `restart`, so that every item is listed once
   *   across the pages of one unchanged list.
   * - `anyWord`: on a first page of two words or more with no item that holds them all, the items that hold some.
   * - `incomplete`: whether a word had more stored words one edit away than the limit, or the signal stopped the read.
   *
   * With no word in `text`, each group lists every item that holds a passage, a passage of one of `partKinds` where
   * the group names any, in the date order, each by its first such passage.
   *
   * The index checks each passage the store answers against the scope, the group's items and its part kinds, and a
   * search whose store answers a passage outside them fails: its count would hold what the scope does not.
   *
   * @throws When the scope has no tenant or no group, when no group is handed, when a part of the search is not in
   *   the form {@link LibraryGroupSearch} gives it, when the store has no `lexicalGroupSearch`, and a
   *   {@link LibraryCursorError} for a cursor the index did not make or that was made for another search: one whose
   *   group is not handed, whose words, order, profile, part kinds, typo rule or expansion limit differ, that carries
   *   a stored word no word of the search reaches or more stored words than one tsquery holds, or whose key names no
   *   place in the order (a rank past what a Postgres numeric holds, a date that is not a real instant, a source id
   *   holding NUL).
   */
  async searchGroups(query: LibraryGroupSearch): Promise<LibraryGroupAnswer> {
    const search = groupSearchOf(query);
    if (typeof this.store.lexicalGroupSearch !== 'function') throw new Error('LibraryIndex: the store has no lexicalGroupSearch.');
    if (query.cursor === undefined) {
      const groups: LibraryGroupResult[] = [];
      // One group at a time: a store on a caller's transaction runs its statements on one connection, and a signal
      // that aborts during one group stops the groups after it.
      for (const group of search.groups) groups.push(await this.searchGroup(search, group, undefined));
      return { groups };
    }
    const carried = cursorDecode(query.cursor);
    const refused = (what: string): LibraryCursorError => new LibraryCursorError(`LibraryIndex.searchGroups: the cursor ${what}.`);
    const group = search.groups.find((handed) => handed.id === carried.groupId);
    if (group === undefined) throw refused('names a group the search does not hand');
    if (carried.sig !== signatureOf(search, group)) {
      throw refused('was made for another search: the words, the order, the profile, the part kinds, the typo rule, the expansion limit or the group differ');
    }
    if (carried.words.length !== search.words.length || carried.words.some((word, at) => word !== search.words[at])) {
      throw refused("carries other words than the search's");
    }
    if (!reachesEveryWord(search, carried.expansion)) throw refused('carries a stored word that no word of the search reaches');
    const after = placeOf(carried.key, search.order === 'date' || search.words.length === 0);
    if (after === null) throw refused("names no place in the page's order");
    // The list the cursor's page was made under is not the list handed now, or the scope it was read under is not
    // the scope that asks now: nothing computed under the old one is answered, and the caller searches again from the
    // first page.
    if (carried.fingerprint !== group.fingerprint || carried.scope !== scopeMarkOf(search.scope)) {
      return { groups: [{ id: group.id, state: 'restart', total: 0, incomplete: false, cursor: null, hits: [], anyWord: [] }] };
    }
    return { groups: [await this.searchGroup(search, group, { expansion: carried.expansion, over: carried.over, after })] };
  }

  /**
   * One group of a grouped search: the store's answer for the group's items under the scope, each row checked and
   * read into a hit, and the cursor of the next page. `page` is where a later page starts, the stored words its first
   * page found and whether that page left any out; without it, the first page.
   */
  private async searchGroup(
    search: CheckedGroupSearch,
    group: CheckedGroup,
    page: { expansion: string[][]; over: boolean; after: LexicalGroupKey } | undefined,
  ): Promise<LibraryGroupResult> {
    const nothing: LibraryGroupResult = { id: group.id, state: 'ok', total: 0, incomplete: false, cursor: null, hits: [], anyWord: [] };
    // An empty list is empty, never unrestricted: the store is asked nothing.
    if (group.items.length === 0) return nothing;
    if (search.signal?.aborted) return { ...nothing, incomplete: true };
    if (typeof this.store.lexicalGroupSearch !== 'function') throw new Error('LibraryIndex: the store has no lexicalGroupSearch.');
    const { words, scope } = search;
    const answered = await this.store.lexicalGroupSearch(this.collection, {
      words,
      ...(page !== undefined
        ? { expansion: page.expansion, after: page.after }
        : search.typo === 'one-edit'
          ? { oneEdit: { minLength: EDIT_MIN_LETTERS, max: search.expansionMax } }
          : {}),
      group: { items: group.items, ...(group.partKinds !== null ? { partKinds: group.partKinds } : {}) },
      profile: search.profile,
      order: search.order,
      pageSize: search.pageSize,
      filter: mergeMetadataFilters(
        { sourceId: { $in: group.items.map((item) => item.sourceId) } },
        scopeToMetadataFilter({ tenantId: scope.tenantId, aclGroups: scope.aclGroups }),
      ),
      ...(search.signal !== undefined ? { signal: search.signal } : {}),
    });

    const hitOf = (row: LexicalGroupRow, anyWord: boolean): LibraryGroupHit => {
      const passage = passageOf(row.document, Number(row.rank));
      const { metadata } = passage;
      const partKind = PART_KINDS.find((kind) => kind === metadata.partKind) ?? null;
      // The store's statements selected this passage. A store that reads outside the scope, the group's items or its
      // part kinds would count what the caller may not see, so such an answer fails the search.
      if (
        row.sourceId !== metadata.sourceId ||
        !group.dates.has(row.sourceId) ||
        !meetsScope(metadata, scope) ||
        (group.partKinds !== null && (partKind === null || !group.partKinds.includes(partKind)))
      ) {
        throw new Error('LibraryIndex.searchGroups: the store answered a passage outside the scope, the items or the part kinds of the search.');
      }
      const marks = marksOf(
        passage.text,
        words.flatMap((word, at) => (row.held[at] ? [{ word, near: answered.expansion[at] ?? [] }] : [])),
      );
      return {
        passage,
        sourceId: row.sourceId,
        field: row.field,
        matchKind: row.held.find((kind) => kind !== null) ?? row.kinds.find((kind) => kind !== null) ?? 'none',
        marks,
        at: marks.length > 0 ? marks[0].start : -1,
        partKind,
        date: group.dates.get(row.sourceId) ?? null,
        anyWord,
      };
    };
    const hits = answered.rows.map((row) => hitOf(row, false));
    const anyWord = answered.anyWord.map((row) => hitOf(row, true));
    // A later page matches the stored words its first page kept, so what that page left out is left out of it too.
    const incomplete = answered.incomplete || page?.over === true;
    const last = answered.rows[answered.rows.length - 1];
    let cursor: string | null = null;
    if (answered.more && last !== undefined) {
      // The last item's place in the page's complete order; a listing with no word is in the date order.
      const dated = search.order === 'date' || words.length === 0;
      cursor = cursorEncode({
        v: 1,
        groupId: group.id,
        fingerprint: group.fingerprint,
        scope: scopeMarkOf(scope),
        sig: signatureOf(search, group),
        words,
        // A later page carries the lists it was handed, never the store's echo of them: a store that answered other
        // lists, empty ones among them, would otherwise drop from the pages after it the items those words hold.
        expansion: page !== undefined ? page.expansion : answered.expansion,
        over: incomplete,
        key: dated ? [group.dates.get(last.sourceId) ?? null, last.rank, last.sourceId] : [last.rank, last.sourceId],
      });
    }
    return { id: group.id, state: 'ok', total: answered.total, incomplete, cursor, hits, anyWord };
  }
}
