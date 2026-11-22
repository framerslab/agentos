/**
 * @fileoverview souledAgent — first-class factory for a soul-file agent whose
 * long-term memory is kept per subject beside its `memory/` wiki.
 *
 * Composes existing, tested pieces:
 * - {@link loadSoulFromOption} resolves the soul and its `memory/` dir.
 * - {@link Memory.createSqlite} opens the single backing store, in `memory/.store/`; with `soulStore`,
 *   {@link Memory.createWithAdapter} opens it on the host's own adapter.
 * - {@link attachMemoryWiki} wires the wiki write-back loop + the
 *   `read_memory_page` tool + the boot index over the same facade.
 * - {@link agent} runs it; its `buildSystemPrompt` already injects the index of the operator's pages.
 *
 * One `Memory` facade is both the agent's live memory and the wiki store, so the
 * conversation the agent observes lands where the wiki compiler reads it. Each turn is filed under the key of its
 * subject (the session's user, else the session) and recalls that subject's memory and the operator's pages alone.
 *
 * @module agentos/api/souledAgent
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  agent,
  loadSoulFromOption,
  type AgentOptions,
  type Agent,
  type AgentMemoryProvider,
  type AgentSession,
  type MemoryHookContext,
} from './agent.js';
import { generateText } from './generateText.js';
import type { StreamTextResult } from './streamText.js';
import type { IModelRouter } from '../core/llm/routing/IModelRouter.js';
import { Memory, type AttachedWiki, type ScoredTrace } from '../cognition/memory/io/facade/Memory.js';
import type { MemoryTrace } from '../cognition/memory/core/types.js';
import { brainOf } from '../cognition/memory/io/facade/handedBrain.js';
import { createStorageFeatures, type StorageAdapter } from '@framers/sql-storage-adapter';
import {
  ForgottenLedger,
  copyUnavailableError,
  type SuppressionSubject,
  type TombstoneKey,
} from '../cognition/memory/suppression/ForgottenLedger.js';
import {
  forgetUserMemory,
  reapplyTombstones,
  type ForgetMemoryReport,
  type ForgetUserMemoryOptions,
  type PartOutcome,
} from '../cognition/memory/io/forgetUserMemory.js';
import type { ForgetReport } from '../cognition/learning/types.js';
import { openForgottenCopy } from '../cognition/memory/suppression/forgottenCopy.js';
import { shareForgottenLedger } from '../cognition/memory/suppression/learnerTombstones.js';
import { createSoulMind, shareSoulStore } from './runtime/soulStore.js';
import { SOUL_TURN_NOTHING, type SoulTurnAnswer, type SoulTurnMemory } from '../cognition/substrate/soulTurnMemory.js';
import { guardedWrite } from '../cognition/memory/suppression/guardedWrite.js';
import { retentionDaysOf, sweepRetention, type RetentionPeriod } from '../cognition/memory/io/retentionSweep.js';
import { correctSubjectMemory, exportSubjectMemory, type UserMemoryExport } from '../cognition/memory/io/userMemoryExport.js';
import {
  assertLegacyMemory,
  attributeLegacyMemory,
  LEGACY_SCOPE,
  legacyScopeIds,
  type LegacyMemoryReason,
} from '../cognition/memory/io/legacyMemory.js';
import type { WikiPage } from '../cognition/substrate/memory/wiki/types.js';
import { WriteChains } from '../cognition/learning/writeChains.js';
import { conversationScopeKey, parseConversationScopeKey } from '../cognition/memory/retrieval/store/conversationScopeKey.js';
import { encodePlainScopeId } from '../cognition/memory/retrieval/store/scopeIdForm.js';
import { memoryLog } from '../cognition/memory/log.js';
import { soulAgentIdOf } from '../cognition/substrate/personas/SoulLoader.js';
import { attachMemoryWiki } from '../cognition/memory/io/attachMemoryWiki.js';
import { SemanticChunker } from '../cognition/rag/chunking/SemanticChunker.js';
import { estimateTokens } from '../core/utils/text-utils.js';
import { createFileOutsideLinksSync } from '../core/utils/linkFreeWrite.js';
import { errorFields } from '../core/logging/events.js';
import { formatMemoryAge } from '../cognition/memory/core/prompt/MemoryFormatters.js';
import { parseTraceMetadata } from '../cognition/memory/retrieval/store/tracePersistence.js';
import { DEFAULT_MEMORY_TOKEN_BUDGET, MEMORY_TIMEOUT_MS } from './runtime/memoryProviderHooks.js';
import { messageOf, reportMindWriteFailure, reportObserveFailure } from './runtime/memoryObserveFailures.js';
import { ensureScopeRow } from '../cognition/memory/retrieval/store/conversationScopes.js';
import type { ICognitiveMemoryManager } from '../cognition/memory/CognitiveMemoryManager.js';
import type { CognitiveMechanismsConfig } from '../cognition/memory/mechanisms/types.js';
import { failedWriteEntry, type MemoryWriteEntry } from './runtime/memoryWriteRecord.js';
import { isAnonymousUserId } from './runtime/memorySubject.js';
import { asSpendBudget } from './runtime/spendBudget.js';
import { credentialsGoWith, modelNamesAnotherProvider } from './runtime/credentialOwner.js';
import {
  PROVIDER_FROM_THE_ROUTER,
  recipientKey,
  recipientsOf,
  recordedRecipients,
  recordRecipient,
  routeRecipient,
  type MemoryRecipient,
  type NamedRoute,
  type RecipientRoutes,
} from './runtime/memoryRecipients.js';
import { resolveCognition, type CognitionInputs } from './runtime/gmiCognition.js';
import { shareRouteObserver } from './runtime/routeObserver.js';
import { assertBigintReadsAsNumbers, embeddingRouteOf } from './runtime/agentCognitiveMemory.js';
import { serializeTransactionsOn } from '../cognition/memory/retrieval/store/adapterTransactionLock.js';
import { resolveModelOption, resolveProviderRoute } from './model.js';
import type { AgentOSUsageLedgerOptions } from './runtime/usageLedger.js';

/** One of a deletion's four parts, as its report lists it. */
type DeletionPart = ForgetMemoryReport['parts'][number];

/**
 * What a souled agent adds to one subject's deletion report: the stores it reached or names itself, and whether one of
 * its own failed.
 */
type ReportExtras = { stores: ForgetMemoryReport['stores']; incomplete: boolean };

/**
 * One part of a person's deletion with the same part of a linked session's added: reached with the sum of the two
 * counts when both reached it, else missed with the reason of each that missed it.
 */
function addPart(part: DeletionPart, other: DeletionPart | undefined): DeletionPart {
  if (!other) return part;
  if (part.reached && other.reached) return { part: part.part, reached: true, deleted: part.deleted + other.deleted };
  const reasons = [part, other].flatMap((each) => (each.reached ? [] : [each.reason]));
  return { part: part.part, reached: false, reason: [...new Set(reasons)].join('; ') };
}

/**
 * Whether a deletion left nothing of its subject in the store: no write of theirs running at the deadline, and every
 * part reached but the open sessions, which hold no row of the store.
 */
function storeHoldsNoMore(report: ForgetMemoryReport): boolean {
  return report.pendingAtDeadline === 0 && report.parts.every((part) => part.part === 'sessions' || part.reached);
}

/** Characters a token is estimated at, as `estimateTokens` counts them. */
const CHARS_PER_TOKEN = 4;

/**
 * How long `close()` waits for the agent's turns still running and for the memory writes of its turns before it
 * compiles, unless an option sets it.
 */
export const DEFAULT_PENDING_WRITES_TIMEOUT_MS = 5_000;

/** The learning layer's entry, among the stores its deletion does not reach, for a conversation's messages. */
const CONVERSATION_HISTORY = "a conversation's own history";

/**
 * Why a souled agent's deletion does not reach a conversation's messages, in place of the learning layer's reason:
 * the sessions the agent's handle holds open for the person are emptied (the report's `sessions` part).
 */
const HISTORY_HELD_ELSEWHERE = 'a session another agent object or another process holds open keeps its messages until the host closes it';

/** The longest delay a timer takes (2^31 - 1 ms, about 24.8 days); a longer one fires at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** The usage ledger's source for the model calls of the wiki compile a souled agent runs. */
export const SOULED_AGENT_COMPILE_SOURCE = 'souledAgent.compileWiki';

/**
 * The key of the trace metadata in which the observer records who spoke a trace: `'user'` or `'assistant'`. It is
 * kept out of the trace's text and its tags, which the store's full-text search reads, so a search never matches a
 * trace by who spoke it.
 */
export const SPEAKER_METADATA_KEY = 'speaker';

/** Who spoke a trace, as the observer records it. */
type Speaker = 'user' | 'assistant';

/** Who a turn's memory belongs to: the user its session named, else the session. */
type MemorySubject = MemoryHookContext['subject'];

/** How many traces a turn's recall reads from its subject's memory, and how many from the operator's pages. */
const RECALL_LIMIT = 8;

/**
 * What a host's memory policy answers for the account a turn serves.
 *
 * - `{ longTerm: 'off' }`: nothing is filed for the account, and its turns recall the operator's pages alone.
 * - `{ longTerm: 'raw' }`: its turns are filed and recalled as traces, and no page is compiled for it.
 * - `{ longTerm: 'compiled' }`: its turns are filed, recalled and compiled into its pages. The default.
 *
 * Each form may add two marks, with exactly these values:
 *
 * - `minor: true`: the account is a child's. On a store that keeps the account's memory until deletion (its period in
 *   `retention`, or no `retention` at all), the answer keeps no long-term memory, as `longTerm: 'off'` does, whatever
 *   `retentionDays` it holds, and one `memory.write_refused` line a session says `minor_no_retention`. On a store that
 *   keeps it for a number of days, the account's pages are compiled only by the target `compile.minors` names, and
 *   not at all without one (`memory.compile_skipped`, `minor_no_compile`).
 * - `profiling: 'off'`: the person objects to profiling. The souled agent's own store keeps no mood or emotional
 *   context of anyone, so on its path the answer files, recalls and compiles as `longTerm` says. On `runtime: 'gmi'`
 *   the person's turns are not scored for sentiment, whatever `longTerm` says; neither are a minor's.
 */
export type MemoryPolicy =
  | { longTerm: 'off'; profiling?: 'off'; minor?: true }
  | { longTerm: 'raw'; retentionDays?: number; profiling?: 'off'; minor?: true }
  | { longTerm: 'compiled'; retentionDays?: number; profiling?: 'off'; minor?: true };

/**
 * How long a souled agent's store keeps what people said.
 *
 * A store that holds, or would hold, the memory of more than one user or session does not open, and opens no second
 * subject's session, without it.
 */
export interface MemoryRetention {
  /**
   * How long a subject's conversation traces are kept from the time they were stored, or until the subject's deletion
   * by name.
   */
  traces: RetentionPeriod;
  /** The same for the sessions that named no user; unset, `traces` applies to them too. Operator pages are exempt. */
  sessions?: RetentionPeriod;
  /**
   * What happens to a per-user page when a trace it was compiled from expires. `'delete-whole'` (the default) deletes
   * the page; `'rebuild'` deletes it and has the next compile build it again from the traces that are left, one model
   * call a page, charged to the budget.
   */
  pages?: 'delete-whole' | 'rebuild';
}

/** What the open of a store more than one subject shares, and the open of a second subject's session, is refused with. */
const RETENTION_REQUIRED =
  "souledAgent: this store holds memory of more than one person or session; set retention: { traces: { days } } or { traces: 'until-deletion' }";

/**
 * What the open of a store more than one subject shares, and the open of a second subject's session, is refused with
 * when no `tombstoneKey` is set and the ledger holds no tombstone yet.
 */
const TOMBSTONE_KEY_REQUIRED =
  'souledAgent: this store would hold memory of more than one person or session; set tombstoneKey: without it, the tombstone a deletion leaves is an unkeyed SHA-256 hash of the id, which anyone who can read the ledger can match by hashing a guessed id';

/** What a `soulStore` that is not `{ adapter }` with a storage adapter is refused with. */
const SOUL_STORE_SHAPE = 'souledAgent: soulStore must be { adapter } with a StorageAdapter of @framers/sql-storage-adapter';

/** What an open with `soulStore` and no `tombstoneCopy`, or one that names no file and no adapter, is refused with. */
const SOUL_STORE_NEEDS_COPY =
  "souledAgent: soulStore needs tombstoneCopy ({ path } or { adapter }), the tombstones' second copy outside what a restore of the store replaces; the default copy is a file on one machine, and a store in the host's database usually serves several";

/** What an open on the file store with a `tombstoneCopy` that is set and names no file and no adapter is refused with. */
const TOMBSTONE_COPY_NAMES_NOTHING =
  "souledAgent: tombstoneCopy names no copy; pass { path } with a non-empty file path or { adapter } with a StorageAdapter, or leave it out for the default file memory/.store/forgotten.sqlite in the store's own folder";

/** What an open with `soulStore` and no `retention`, or no `tombstoneKey` that holds a key, is refused with. */
const SOUL_STORE_NEEDS_RETENTION_AND_KEY =
  "souledAgent: soulStore needs retention and tombstoneKey: the agent counts the people and sessions it holds memory of in its own process, and a store in the host's database is usually served by several processes, each of which would let its own first one in without them";

/** What an open on a database that holds another agent's memory is refused with. */
const SOUL_STORE_HOLDS_ANOTHER_AGENT =
  "souledAgent: soulStore's database already holds another agent's memory (rows under another brain id in brain_meta, memory_traces or memory_scopes); give each agent a database or PostgreSQL schema of its own: the tombstone ledger is database-wide, so two agents on one database would share each other's deletions";

/** The tables a Brain keeps its rows in under its own `brain_id`; a row under another id is another agent's. */
const BRAIN_TABLES = ['brain_meta', 'memory_traces', 'memory_scopes'] as const;

/** Whether `value` has the calls of a `StorageAdapter` the store and the ledger make, and a `kind`. */
function isStorageAdapter(value: unknown): value is StorageAdapter {
  const calls = ['get', 'all', 'run', 'exec', 'transaction'];
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { kind?: unknown }).kind === 'string' &&
    calls.every((name) => typeof (value as Record<string, unknown>)[name] === 'function')
  );
}

/** Throws {@link SOUL_STORE_SHAPE} unless `soulStore` is `{ adapter }` with an adapter's calls. */
function assertSoulStore(soulStore: unknown): asserts soulStore is { adapter: StorageAdapter } {
  const adapter = soulStore !== null && typeof soulStore === 'object' ? (soulStore as { adapter?: unknown }).adapter : undefined;
  if (!isStorageAdapter(adapter)) throw new TypeError(SOUL_STORE_SHAPE);
}

/**
 * Whether `tombstoneCopy` names a second copy, read as the open reads it: an option that has an `adapter` key is an
 * adapter's, whatever else it holds, so it names one only when that key holds an object with an adapter's calls; any
 * other option names a file by a non-empty path.
 */
function namesTombstoneCopy(tombstoneCopy: unknown): boolean {
  if (tombstoneCopy === null || typeof tombstoneCopy !== 'object') return false;
  if ('adapter' in tombstoneCopy) return isStorageAdapter((tombstoneCopy as { adapter?: unknown }).adapter);
  const file = (tombstoneCopy as { path?: unknown }).path;
  return typeof file === 'string' && file !== '';
}

/**
 * Whether the database behind `adapter` has `table` in the place a Brain opened on the adapter makes its own: on
 * PostgreSQL the connection's current schema. Before the Brain has made its tables there, the bare name of a table can
 * resolve to a same-named table of a later schema on the search path (a schema of the agent's own ahead of a `public`
 * another brain uses), which is not this database's. False when the catalog cannot be read.
 */
async function hasTableOfItsOwn(adapter: StorageAdapter, table: string): Promise<boolean> {
  try {
    if (String(adapter.kind).includes('postgres')) {
      const row = await adapter.get<{ found: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?) AS found',
        [table],
      );
      return row?.found === true;
    }
    return (await adapter.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table])) != null;
  } catch {
    return false;
  }
}

/**
 * Whether the database behind `adapter` holds a row of another brain than `brainId`, in a table every open makes.
 *
 * @param beforeOpen - The read before this agent's Brain has opened: a table the database does not have yet in the
 *   Brain's own place ({@link hasTableOfItsOwn}), or has in an older shape that cannot be read, counts as holding no
 *   such row. The read after the open decides, and its errors are thrown.
 */
async function holdsAnotherBrain(adapter: StorageAdapter, brainId: string, beforeOpen = false): Promise<boolean> {
  for (const table of BRAIN_TABLES) {
    if (beforeOpen && !(await hasTableOfItsOwn(adapter, table))) continue;
    const row = adapter.get(`SELECT 1 AS n FROM ${table} WHERE brain_id <> ? LIMIT 1`, [brainId]);
    if ((await (beforeOpen ? row.catch(() => null) : row)) != null) return true;
  }
  return false;
}

/**
 * Whether `brain_meta` holds a row of `brainId`, read before the Brain opens; false while the database has no such
 * table of its own ({@link hasTableOfItsOwn}) or it cannot be read.
 */
async function brainIsSeeded(adapter: StorageAdapter, brainId: string): Promise<boolean> {
  if (!(await hasTableOfItsOwn(adapter, 'brain_meta'))) return false;
  return adapter.get('SELECT 1 AS n FROM brain_meta WHERE brain_id = ? LIMIT 1', [brainId]).then(
    (row) => row != null,
    () => false,
  );
}

/**
 * After an open refused because another agent seeded the database at the same moment, deletes the `brain_meta` rows
 * this open seeded for `brainId`, so the agent that stays opens again. The caller calls it only for a brain the
 * database did not hold before the open. Only rows seeded at or after `since` (a brain that was there before keeps its
 * own time) of a brain that holds no trace and no scope are deleted.
 */
async function dropSeededBrain(adapter: StorageAdapter, brainId: string, since: number): Promise<void> {
  const seeded = await adapter.get<{ value: string }>("SELECT value FROM brain_meta WHERE brain_id = ? AND key = 'created_at'", [brainId]);
  if (!seeded || !(Number(seeded.value) >= since)) return;
  for (const table of ['memory_traces', 'memory_scopes']) {
    if ((await adapter.get(`SELECT 1 AS n FROM ${table} WHERE brain_id = ? LIMIT 1`, [brainId])) != null) return;
  }
  await adapter.run('DELETE FROM brain_meta WHERE brain_id = ?', [brainId]);
}

/** Whether a file, a folder or a link is at `target`. */
async function somethingAt(target: string): Promise<boolean> {
  return fs.lstat(target).then(
    () => true,
    () => false,
  );
}

/** Whether a tombstone copy's ledger table holds no row; false when the table cannot be read. */
async function holdsNoLedgerRow(copy: StorageAdapter): Promise<boolean> {
  try {
    return (await copy.get('SELECT hash FROM agentos_learning_forgotten LIMIT 1')) == null;
  } catch {
    return false;
  }
}

/**
 * Throws unless `compile.minors`, when the key is there with a value, names a provider and a model as non-empty
 * strings, with an `apiKey` and a `baseUrl` that are strings when given. A target with no provider or no model would
 * resolve to the agent's or the environment's provider, which the host never named for minors.
 *
 * @throws TypeError naming `compile.minors` and what it must hold.
 */
function assertCompileMinors(compile: unknown): void {
  if (compile === null || typeof compile !== 'object') return;
  const minors = (compile as { minors?: unknown }).minors;
  if (minors === undefined) return;
  const target = (
    minors !== null && typeof minors === 'object' && !Array.isArray(minors) ? minors : {}
  ) as Record<string, unknown>;
  const named = (value: unknown) => typeof value === 'string' && value !== '';
  const optional = (value: unknown) => value === undefined || typeof value === 'string';
  if (!named(target.provider) || !named(target.model) || !optional(target.apiKey) || !optional(target.baseUrl)) {
    throw new TypeError(
      "souledAgent: compile.minors needs { provider, model } as non-empty strings (apiKey and baseUrl strings when given): a minor's compile goes only to the target named for it",
    );
  }
  // A `provider:` prefix the library knows wins over the named provider when the call resolves, so such a model
  // would send a minor's compile to the provider of the prefix, on that provider's key from the environment.
  if (modelNamesAnotherProvider(target.provider as string, target.model as string)) {
    throw new TypeError(
      "souledAgent: compile.minors.model names another provider than compile.minors.provider; name the model without that provider's prefix, or name that provider",
    );
  }
}

/**
 * Throws unless `retention` names a period for traces (and, when given, for sessions) that is `'until-deletion'` or a
 * positive number of days, and a page rule that is one of the two.
 *
 * @throws TypeError naming what the option must hold.
 */
function assertRetention(retention: unknown): void {
  const given = (retention !== null && typeof retention === 'object' ? retention : {}) as Record<string, unknown>;
  const assertPeriod = (period: unknown): void => {
    if (period === 'until-deletion') return;
    const days = period !== null && typeof period === 'object' ? (period as { days?: unknown }).days : undefined;
    if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
      throw new TypeError('souledAgent: retention days must be a positive number');
    }
  };
  assertPeriod(given.traces);
  if (given.sessions !== undefined) assertPeriod(given.sessions);
  if (given.pages !== undefined && given.pages !== 'delete-whole' && given.pages !== 'rebuild') {
    throw new TypeError("souledAgent: retention pages must be 'delete-whole' or 'rebuild'");
  }
}

/** The policy of an agent that names none. */
const COMPILED: MemoryPolicy = { longTerm: 'compiled' };

/** What a turn's memory does: the account's policy, or `'failed'` when the host's policy hook gave no valid answer. */
type TurnPolicy = MemoryPolicy | 'failed';

/** A hook that did not answer within its time. */
const TIMED_OUT = Symbol('timed out');

/** A screen hook that failed: a symbol, so no text a screen answers, and no text a person writes, is read as it. */
const SCREEN_FAILED = Symbol('screen failed');

/**
 * The provider a route names itself: `provider`, else the known provider its model's own `provider:` or `provider/`
 * prefix names. Never one the environment or a default picks for a plain model.
 */
function providerNamedBy(provider: string | undefined, model: string | undefined): string | undefined {
  if (provider !== undefined) return provider;
  if (model === undefined) return undefined;
  const prefix = /^([^:/]+)[:/]/.exec(model)?.[1];
  if (prefix === undefined) return undefined;
  try {
    // A prefix no provider owns falls through to detection, which picks some other provider: that one is not named.
    const resolved = resolveModelOption({ model }, 'text').providerId;
    return resolved === prefix ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** A route a call is sent on: its provider and model as named, its own key and base URL, and whether it is strict. */
interface CallRoute {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Sent to its provider alone: no Anthropic to OpenRouter reroute. */
  strict?: boolean;
}

/** Whether a GMI built from `opts` runs cognitive memory; options that do not resolve are left for agent() to refuse. */
function cognitiveMemoryOf(opts: CognitionInputs): boolean {
  try {
    return Boolean(resolveCognition(opts).memory);
  } catch {
    return false;
  }
}

/**
 * The mechanisms the soul's mind runs: those a GMI built from `opts` resolves to, as the host gave them. Undefined for
 * options that do not resolve, which agent() refuses before any mind is built.
 */
function soulMechanismsOf(opts: CognitionInputs): CognitiveMechanismsConfig | undefined {
  try {
    return resolveCognition(opts).mechanisms;
  } catch {
    return undefined;
  }
}

/** `work`'s result, or {@link TIMED_OUT} when it has not settled within `ms`. A rejection is the caller's to catch. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), Math.min(Math.max(ms, 0), MAX_TIMER_DELAY_MS));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True for an object that holds `longTerm`, one of the three words a policy takes, and nothing else but `profiling`
 * as `'off'`, `minor` as `true` and, on a policy that keeps memory, `retentionDays` as a positive number.
 */
function isMemoryPolicy(value: unknown): value is MemoryPolicy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const { longTerm, retentionDays, profiling, minor, ...others } = value as {
    longTerm?: unknown;
    retentionDays?: unknown;
    profiling?: unknown;
    minor?: unknown;
  };
  if (Object.keys(others).length > 0) return false;
  // A mark is given with its one value or not at all: a key present with any other value is not an answer.
  if (Object.prototype.hasOwnProperty.call(value, 'profiling') && profiling !== 'off') return false;
  if (Object.prototype.hasOwnProperty.call(value, 'minor') && minor !== true) return false;
  if (longTerm === 'off') return !Object.prototype.hasOwnProperty.call(value, 'retentionDays');
  if (longTerm !== 'raw' && longTerm !== 'compiled') return false;
  if (!Object.prototype.hasOwnProperty.call(value, 'retentionDays')) return true;
  return typeof retentionDays === 'number' && Number.isFinite(retentionDays) && retentionDays > 0;
}

/** What `sharedMemory` must be, as the rejection of an option that is not says it. */
const SHARED_MEMORY_SHAPE =
  "souledAgent: sharedMemory needs { as: <a user id>, reason: 'one-persons-machine' | 'operators-notes' }";

/** The tag a wiki page chunk carries for its page: `page:<id>`. */
const PAGE_TAG = 'page:';

/** One recalled trace: the label that opens its line, then its text, and the label's parts as a record's fields. */
interface RecallLine {
  /** `[user, 26 days ago, 2026-10-14] `: who spoke it and when it was stored; ends with a space. Empty when dropped. */
  prefix: string;
  content: string;
  /** Who spoke it, or `note` for a chunk of a wiki page; undefined when no speaker was recorded. */
  speaker?: 'user' | 'assistant' | 'note';
  /** The page id of a chunk of a wiki page. */
  page?: string;
  /** When it was stored, as its label shows it (`26 days ago, 2026-10-14`). */
  when: string;
}

/** The page id of a chunk of a wiki page, from the tags the wiki gives it (`wiki` and `page:<id>`); else undefined. */
function wikiPageOf(trace: { tags: readonly string[] }): string | undefined {
  if (!trace.tags.includes('wiki')) return undefined;
  return trace.tags.find((tag) => tag.startsWith(PAGE_TAG))?.slice(PAGE_TAG.length);
}

/** The speaker recorded in a trace's metadata (`'user'` or `'assistant'`); undefined for any other value or none. */
function speakerIn(metadata: string | undefined): Speaker | undefined {
  const speaker = parseTraceMetadata(metadata)[SPEAKER_METADATA_KEY];
  return speaker === 'user' || speaker === 'assistant' ? speaker : undefined;
}

/**
 * The label a recalled trace's line opens with: who spoke it (`user` or `assistant`, as the observer recorded it, or
 * `note` and the page id for a chunk of a wiki page) and when it was stored, in the memory block's wording
 * (`26 days ago, 2026-10-14`). A trace with no speaker, such as one stored before speakers were recorded, has the date
 * alone.
 */
function recallPrefix(trace: { createdAt: number }, speaker: string | undefined, now: number): string {
  const when = formatMemoryAge(trace.createdAt, now);
  return speaker ? `[${speaker}, ${when}] ` : `[${when}] `;
}

/**
 * A trace's text on one line: its lines, each trimmed, joined by one space, blank ones left out. The text of a trace
 * can then never open a line of the recall block, where only a label opens one. Linear in the text's length.
 */
function onOneLine(text: string): string {
  return text
    .split(/[\n\r\v\f\u0085\u2028\u2029]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ');
}

/**
 * The recalled traces, in rank order, that fit `tokenBudget` when joined one line each (its label, then its text),
 * estimated with `estimateTokens`. Whole lines are kept while they fit; when the first alone is larger, it is kept with
 * its text cut at the last word boundary that fits beside its label (mid-word only when it has none, and never inside a
 * character a surrogate pair encodes), so a matched trace never yields no recall under a positive budget; a label
 * longer than the whole budget is dropped (its `prefix` is then empty). A budget of 0 or less asks for no recall, and
 * one that is not a number is the hooks' default.
 *
 * @param lines - The traces' labels and text, best first.
 * @param tokenBudget - The recall's token ceiling.
 * @returns The kept lines; none when nothing was recalled or the budget is 0 or less.
 */
function fitRecallLines(lines: readonly RecallLine[], tokenBudget: number): RecallLine[] {
  if (tokenBudget <= 0) return [];
  const budget = Number.isNaN(tokenBudget) ? DEFAULT_MEMORY_TOKEN_BUDGET : Math.floor(tokenBudget);
  const recalled = lines.filter((line) => line.content.length > 0);
  if (recalled.length === 0) return [];
  const kept: RecallLine[] = [];
  let block = '';
  for (const line of recalled) {
    const text = `${line.prefix}${line.content}`;
    const next = block ? `${block}\n${text}` : text;
    if (estimateTokens(next) > budget) break;
    block = next;
    kept.push(line);
  }
  if (kept.length > 0) return kept;
  const first = recalled[0];
  const { content } = first;
  const room = budget * CHARS_PER_TOKEN - first.prefix.length;
  const prefix = room >= 1 ? first.prefix : '';
  const maxChars = Math.max(1, room >= 1 ? room : budget * CHARS_PER_TOKEN);
  const head = codePointPrefix(content, maxChars);
  // Cut back to the last whitespace when the cut falls inside a word; text that fits whole is not cut.
  const whole = head.length >= content.length;
  const cut = whole || /\s/.test(content.charAt(maxChars)) ? head : head.replace(/\s+\S*$/, '');
  return [{ ...first, prefix, content: cut.trimEnd() || head }];
}

/**
 * Wait for `pending` to empty, up to `timeoutMs`; a promise added while waiting (a turn's memory write, which its
 * observe hook adds before the turn settles) is waited for too.
 *
 * @returns How many promises are still pending when the wait ends.
 */
async function waitForWrites(pending: Set<Promise<unknown>>, timeoutMs: number): Promise<number> {
  if (pending.size === 0 || timeoutMs <= 0) return pending.size;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    // A timer longer than the longest one fires at once, so a longer wait is held to the longest.
    timer = setTimeout(() => resolve('deadline'), Math.min(timeoutMs, MAX_TIMER_DELAY_MS));
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    while (pending.size > 0) {
      const outcome = await Promise.race([Promise.allSettled([...pending]).then(() => 'settled' as const), deadline]);
      if (outcome === 'deadline') break;
    }
  } finally {
    clearTimeout(timer);
  }
  return pending.size;
}

/**
 * The first `maxUnits` UTF-16 units of `text`, one fewer when the last would be the first half of a surrogate pair,
 * so no character is cut in two; the whole first character when it alone is longer than `maxUnits`.
 */
function codePointPrefix(text: string, maxUnits: number): string {
  const splitsPair = /[\uD800-\uDBFF]/.test(text.charAt(maxUnits - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(maxUnits));
  const end = splitsPair ? maxUnits - 1 : maxUnits;
  return end > 0 ? text.slice(0, end) : String.fromCodePoint(text.codePointAt(0) ?? 0);
}

/**
 * Throws unless `sharedMemory` is `{ as, reason }` with a user id that names someone, which a conversation key can be
 * built from, and one of the two reasons.
 *
 * @param sharedMemory - The option as the caller gave it.
 * @param anonymousUserIds - The ids the agent itself reads as naming nobody, beside the built-in ones.
 * @throws TypeError naming the shape the option must have.
 */
function assertSharedMemory(sharedMemory: unknown, anonymousUserIds: readonly string[] | null | undefined): void {
  const given = (sharedMemory !== null && typeof sharedMemory === 'object' ? sharedMemory : {}) as Record<string, unknown>;
  const user = given.as;
  const reason = given.reason;
  if (typeof user !== 'string' || isAnonymousUserId(user, anonymousUserIds)) throw new TypeError(SHARED_MEMORY_SHAPE);
  if (reason !== 'one-persons-machine' && reason !== 'operators-notes') throw new TypeError(SHARED_MEMORY_SHAPE);
  try {
    // An id that is not well-formed text has no key.
    conversationScopeKey('agent', { kind: 'user', id: user });
  } catch {
    throw new TypeError(SHARED_MEMORY_SHAPE);
  }
}

/**
 * True for the errors a spend budget's refusal throws, by name as the runtime reads them: `CostCapExceededError`,
 * `UnpricedModelError`, and `SpendMeterUnavailableError` when the budget's meter could not answer.
 */
function isBudgetRefusal(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'CostCapExceededError' || name === 'UnpricedModelError' || name === 'SpendMeterUnavailableError';
}

/**
 * Thrown in place of a compile's next model call when the account's latest answer no longer lets it run: the
 * scope's compile stops there, is logged as skipped for `reason`, and its traces wait with their watermark.
 */
class CompileStopped extends Error {
  constructor(readonly reason: 'policy_raw' | 'minor_no_compile') {
    super(`the compile stopped before its next model call: ${reason}`);
    this.name = 'CompileStopped';
  }
}

/** Options for {@link souledAgent}: those of {@link AgentOptions}, with `soul` required. */
export interface SouledAgentOptions extends AgentOptions {
  soul: NonNullable<AgentOptions['soul']>;
  /**
   * How long `close()` waits, in milliseconds, for the agent's turns still running and then for the memory writes of
   * its turns, one deadline for both, before it compiles the wiki. Default {@link DEFAULT_PENDING_WRITES_TIMEOUT_MS}
   * (5 seconds); 0 waits for none, and `Infinity` (or any wait past the longest timer, about 24.8 days) waits for them
   * all. When the wait ends with turns or writes still pending, the compile takes what is stored and one `console.warn`
   * line gives their number. A deletion (`forgetUser`) waits as long for the person's pending writes and then, with
   * `runtime: 'gmi'`, as long again for a turn still running on a session it empties, unless the deletion was called
   * from that turn's own hook or tool.
   */
  pendingWritesTimeoutMs?: number;
  /**
   * For one person's own machine, or an operator's own notes: every session that names no user, and every one-shot
   * `generate()` or `stream()`, runs as the user `as`, so they share one memory. A session that names another user is
   * refused, and so is opening a store that already holds the memory of another user or session.
   */
  sharedMemory?: { as: string; reason: 'one-persons-machine' | 'operators-notes' };
  /**
   * Where the wiki compile's model calls go. Unset: the agent's own provider and model, on its route, budget and
   * ledger. An object names another provider or model (a local model included): the compile's text then goes to that
   * provider alone, with no fallback and no router, and the agent's own key is sent only to the agent's own provider.
   * `false`: no compile; raw traces only, and no per-user page is ever written.
   *
   * `minors` names where the compile of an account `memoryPolicy` answers `minor: true` for goes: that provider and
   * model alone, with no fallback and no router, as a named target above, and no other provider in its place: with no
   * key for it, the compile fails rather than going to OpenRouter, and a `setDefaultProvider()` default that names no
   * provider lends it nothing. The agent's own key and base URL go with it only when the agent names that provider, as
   * its `provider` or its model's prefix, never when the environment picks it. `provider` and `model` are required and
   * non-empty, and a `model` whose `provider:` prefix names another provider is refused, or the agent does not open
   * (`TypeError`). Without it, no page is compiled for a minor.
   * Each merge of a compile is sent on the route the account's latest answer gives at that moment. An object that
   * holds `minors` alone leaves every other account's compile on the agent's own provider, model and route.
   */
  compile?:
    | {
        provider?: string;
        model?: string;
        apiKey?: string;
        baseUrl?: string;
        minors?: { provider: string; model: string; apiKey?: string; baseUrl?: string };
      }
    | false;
  /**
   * The host's policy for the account a turn serves. A session asks once and keeps the answer for its next turns,
   * until a later answer for the same account, given to any session or call of this agent, replaces it from the
   * session's next turn; a later answer that failed makes the session ask again. A hook that throws, rejects, does not
   * answer within the memory hooks' timeout (`memoryProviderOptions.timeoutMs`) or answers anything but one of the
   * three policies, with `minor: true` and `profiling: 'off'` as the only marks it may add, fails closed: nothing is
   * filed for that turn, it recalls the operator's pages alone, and the next turn asks again. `retentionDays` on a
   * policy that keeps memory shortens the agent's `retention` period for that account, in the sweeps of the process
   * that asked; it never lengthens it. Another agent object, in this process or another, reads the host's answer at
   * its own sessions' next ask.
   */
  memoryPolicy?: (context: MemoryHookContext) => MemoryPolicy | Promise<MemoryPolicy>;
  /**
   * Screens or redacts text before it is filed (and so embedded) and before it is sent to a compile. Returns the text
   * to use, or null to drop it. A hook that throws, rejects, does not answer within the memory hooks' timeout or
   * answers anything else fails closed: the text is not filed, and a compile that needs it does not run.
   */
  screen?: (text: string, context: MemoryHookContext & { stage: 'file' | 'compile' }) => Promise<string | null>;
  /**
   * How long conversation traces, and the pages compiled from them, are kept. Required once the store holds, or would
   * hold, the memory of a second user or session: a session that names no user is a subject of its own, so a product
   * that opens one anonymous session a visitor chooses a period. One stable `userId`, or `sharedMemory`, is one subject
   * and needs none. Expired memory is deleted by `close()` and by `agent.sweepRetention()`.
   */
  retention?: MemoryRetention;
  /**
   * The secret that keys the tombstones (HMAC-SHA-256). Without it tombstones are unkeyed SHA-256 hashes, which can be
   * matched by hashing a guessed id. After a rotation the previous keys are still needed to check the old tombstones.
   * A store whose tombstones are keyed does not open without it.
   *
   * Required once the store holds, or would hold, the memory of a second user or session, while its ledger holds no
   * tombstone: the open of such a store, and the second subject's session, are refused without it. A ledger that
   * already holds unkeyed tombstones lets the second subject in, and one `memory.tombstones_unkeyed` line an open
   * says so. One stable `userId`, or `sharedMemory`, is one subject and needs none.
   */
  tombstoneKey?: TombstoneKey | { current: TombstoneKey; previous?: ReadonlyArray<TombstoneKey> };
  /**
   * Where the second copy of the tombstones lives, out of what a restore of the store replaces: a SQLite file path, or
   * an adapter (left open on close). Default: `memory/.store/forgotten.sqlite`. A store whose copy is missing or
   * unreadable does not open, and an option that names neither a file by a non-empty path nor an adapter (`null`,
   * `{}`, `{ path: undefined }`, `{ adapter: undefined }`) is refused before anything opens.
   */
  tombstoneCopy?: { path: string } | { adapter: StorageAdapter };
  /**
   * For a single person's own machine: attributes all memory the store holds from before per-user scope (traces
   * under the agent's plain scope, pages an earlier version compiled under `memory/`) to one named user, who then
   * recalls it, reads and lists those pages, gets both in an export, and whose deletion removes them. Unset, the
   * default, that memory stays in place and is read by nobody new. The store refuses the attribution when it records
   * any other user or session, and it is never moved to another user. A page whose front matter does not parse is
   * never attributed.
   */
  legacyMemory?: { attributeTo: string; reason: LegacyMemoryReason };
  /**
   * Keeps the store in the host's own database: a `StorageAdapter` of `@framers/sql-storage-adapter`, SQLite or
   * PostgreSQL, in place of the SQLite file `memory/.store/memory.sqlite`. Every call reaches the store there as it
   * reaches the file. `close()` leaves the adapter open, and on SQLite the agent turns `secure_delete` on for it.
   *
   * Give the agent a database or PostgreSQL schema of its own: the tombstone ledger is database-wide, so the open is
   * refused on a database that holds another agent's memory, before anything is written there. Give it an adapter
   * object of its own too: the agent runs its own transactions on a PostgreSQL adapter one after another, and a
   * transaction the host runs on the same adapter is outside that order. A PostgreSQL adapter must read BIGINT as
   * numbers (`typeParsers: { int8: 'number' }`).
   * `tombstoneCopy` is required with it, and the open is refused while a store file is still at
   * `memory/.store/memory.sqlite`: the memory it holds would be out of reach of every call on the new store.
   * `retention` and `tombstoneKey` are required with it too, with or without `sharedMemory`: the agent counts the
   * people and sessions it holds memory of in its own process, and other processes serve the same database.
   */
  soulStore?: { adapter: StorageAdapter };
  /**
   * Whether a session turn on `runtime: 'gmi'` sends the end user's id to the model provider: the `userId` the session
   * was opened with, in the provider's end-user field (OpenAI's `user` or `safety_identifier`), as the name the user's
   * messages are sent under (which OpenAI's Chat Completions API receives) and as a tag of the cognitive memory a turn
   * files (which the memory block shows the model), a seat's session included. Default
   * `false`: no turn of the agent sends one, and a team a session launches seats its sessions as the session's user and
   * sends none either. Set it only where the session's `userId` is an opaque or hashed id, never an email address: the
   * provider receives it. Tools, the user context and the memory hooks get the user id either way. The default runtime
   * sends no end-user id, with or without it.
   */
  sendUserIdToProvider?: boolean;
}

/**
 * Return type of {@link souledAgent}: an {@link Agent} with its backing
 * {@link Memory} store exposed as `memory`, so callers can fold conversation
 * into the wiki mid-session via `await agent.memory.compileWiki()`. `memory` and the
 * members below are present whenever the soul resolves to a workspace directory; they are absent for
 * inline souls that fall back to a plain agent.
 */
export type SouledAgent = Agent & {
  memory?: Memory;
  /**
   * Deletes one person's memory from this agent's store for good and keeps it deleted: it waits for the person's
   * pending writes (up to `pendingWritesTimeoutMs`), records a tombstone, deletes their traces, document chunks,
   * compiled pages and registry row, writes the vector index again, and empties the sessions this handle holds open
   * for them: on the default runtime each session's history is cleared; with `runtime: 'gmi'` each session's messages
   * go at once and its GMI drops its history, its reasoning trace, its sentiment trend, its working-memory slots and
   * its metaprompts' imprints once no turn of the session runs, which the call waits for up to
   * `pendingWritesTimeoutMs`. A session still running a turn then leaves the report's `sessions` part missed, and is
   * emptied when that turn ends. With a learning layer, the layer's own deletion runs first, and
   * `agent.learning.forgetUser(userId)` runs this same deletion. `linkedSessions` names the anonymous sessions the
   * host has tied to the person: each is deleted the same way, and its counts add into the report's parts.
   *
   * @returns One report for the user and the linked sessions, the receipt a host keeps beside its own record of the
   *   request: each store with `reached` and a count or a reason, the pages deleted and those that failed, `drained`,
   *   `pendingAtDeadline`, `complete`, `completedAt`, `agentId`, `libraryVersion`, the four `parts` in order
   *   (`tombstone`, `mind`, `store`, `sessions`) and `recipients`. It never holds the user's id, a hash of the id or
   *   any text. The person's deletion and each linked session's write one `memory.forget_incomplete` warn line when
   *   incomplete, with each part reached or missed.
   * @throws TypeError when `userId`, or an entry of `linkedSessions`, is not a non-empty string, or holds a NUL or a
   *   lone surrogate, so no memory key can be built from it; nothing is deleted and no tombstone is written.
   */
  forgetUser?(userId: string, options?: { linkedSessions?: readonly string[] }): Promise<ForgetMemoryReport>;
  /**
   * Applies the tombstones again, as every open does: brings the store's ledger up to date from its copy, then
   * deletes again whatever the store holds of a forgotten user or session. For a restore runbook, and for a schedule
   * when several processes share one store on PostgreSQL.
   *
   * @returns One report a subject deleted again; none on a store that holds nothing of a forgotten subject.
   */
  applyTombstones?(): Promise<ForgetMemoryReport[]>;
  /**
   * Deletes for good what the agent's `retention` no longer keeps: each subject's traces older than its period, and
   * the pages compiled from them (whole, or rebuilt from the traces that are left with `pages: 'rebuild'`). `close()`
   * runs it too. Without `retention` it deletes nothing.
   *
   * @returns How many traces and pages it deleted, and how many subjects it removed from the registry.
   */
  sweepRetention?(): Promise<{ traces: number; pages: number; scopes: number }>;
  /**
   * One person's memory as JSON: their conversation traces (id, time, speaker, text, tags) and their compiled pages
   * (id, summary, updated, sources, body), read from their own scope alone; what they provided (their own messages);
   * what is held about them (each trace with its entities, filing side, emotional context and strength fields, the
   * memory graph's links between their traces, their pages, and their learned state when the agent runs a learning
   * layer); {@link SouledAgent.recipients}; the retention period; whether their messages are scored for sentiment; and
   * each read that failed (`unread`). Operator pages, other people's memory and a gmi() session's history are not in
   * it; a forgotten person's export holds nothing of them. It reads after the memory writes of the person's turns
   * already sent, so a turn whose `send()` resolved before the call is in it.
   *
   * @throws TypeError when `userId` is not a non-empty string.
   */
  exportUserMemory?(userId: string): Promise<UserMemoryExport>;
  /**
   * Who receives a person's text from this agent, outside the process: its model's provider and model, a model
   * router's pick, each fallback hop (or the automatic fallback chain), the compile's target, the target for minors'
   * compiles, the embedding provider and model of cognitive memory, and every route a call took that the options do
   * not name (a `generate()` or `stream()` with its own `provider`, `model`, router or `fallbackProviders`, each provider
   * and model a model router picked, or a route the credential layer sent elsewhere), which the store records so it is
   * still named after a restart. An entry names a provider, not the endpoint a `baseUrl` sends it to. Each entry names
   * where the text goes: the provider a model's `provider:` prefix names, and OpenRouter for an Anthropic route with no
   * Anthropic key or base URL while `OPENROUTER_API_KEY` is set. The list is agent-wide, the same for every person.
   * The library sends these recipients nothing.
   *
   * @throws Error when the store cannot be read.
   */
  recipients?(): Promise<MemoryRecipient[]>;
  /**
   * Deletes or corrects one person's memories. It deletes the named traces for good, deletes each page built from a
   * deleted trace and has the next compile build it again from the traces that are left. With `text` it files `text`
   * in their place, as a trace tagged `correction`; with no `text` it files nothing. It rejects, and changes nothing,
   * when any id is not one of that person's live traces. When the person's memory already holds `text` word for
   * word, that trace is the correction: it is tagged `correction`, kept, and not deleted even when it is one of the
   * named traces. No newer statement replaces an older one by itself: this call is how one does.
   *
   * A session turn of the person that was running when the call changed their memory does not file its reply, which
   * can restate what the turn recalled before: the turn's `memoryWrite` names the reply `skipped`, `corrected`. What
   * the person said in that turn is filed.
   *
   * @returns How many traces and pages it deleted, and `recipients`, the list {@link SouledAgent.recipients} returns:
   *   the call sends them nothing, so telling each one is the host's. A correction adds `correctionTraceId`, the id
   *   of the correction's trace, a live trace; a deletion with no `text` has no such key.
   * @throws TypeError when `userId` or the trace ids are missing, or when `text` is given and is not a non-empty
   *   string: a deletion leaves `text` out.
   * @throws Error when the correction's trace was deleted before it was marked; the call deletes no named trace. The
   *   same call made again files the correction anew when every named trace is still live; otherwise it rejects.
   */
  correctUserMemory?: {
    (
      userId: string,
      correction: { traceIds: readonly string[]; text: string },
    ): Promise<{ deleted: number; pagesDeleted: number; correctionTraceId: string; recipients: MemoryRecipient[] }>;
    (
      userId: string,
      correction: { traceIds: readonly string[]; text?: undefined },
    ): Promise<{ deleted: number; pagesDeleted: number; recipients: MemoryRecipient[] }>;
    (
      userId: string,
      correction: { traceIds: readonly string[]; text?: string },
    ): Promise<{ deleted: number; pagesDeleted: number; correctionTraceId?: string; recipients: MemoryRecipient[] }>;
  };
};

/**
 * Create an agent whose long-term memory is its soul-file `memory/` wiki.
 *
 * When the soul resolves to a workspace directory, the wiki is wired end to end
 * (store + write-back + `read_memory_page` tool + prelude `index.md`). For inline
 * souls (`{ content }`) there is no workspace, so this falls back to a plain
 * {@link agent} and says so in one `console.warn` line.
 *
 * Memory is kept per subject. A session turn is filed under the key of its subject, the user the session named or
 * else the session itself, the user's message and the reply alike, and it recalls that subject's memory and the
 * operator's pages, and nobody else's. A one-shot `generate()` or `stream()` names no user: nothing is filed for it,
 * it recalls the operator's pages alone, and one `memory.one_shot_unfiled` line an agent says so. With
 * {@link SouledAgentOptions.sharedMemory} every session that names no user, and every one-shot call, runs as one
 * user. Traces an earlier version filed under the agent's plain id stay in the store, are read by no turn, and are
 * counted in one `memory.legacy_traces` line at open. The store's folder, `memory/.store/`, gets a `.gitignore` holding
 * `*` when it has none; a file git tracked before stays tracked until the host removes it from the index.
 *
 * Each stored turn records who spoke it in the trace's metadata ({@link SPEAKER_METADATA_KEY}), outside its text and
 * its tags, so recall never matches a trace by its speaker; each recalled trace is sent as one record, with its
 * speaker and its date, in a data block. The wiki compile's model calls go on the agent's route with its fallback
 * settings, are checked against and charged to its spend budget, and are written to its usage ledger under the source
 * {@link SOULED_AGENT_COMPILE_SOURCE}.
 *
 * The wiki is compiled once a subject, from that subject's traces alone, into pages that are rows of the store and
 * never files under `memory/`; each subject has its own watermark. `close()` compiles the subjects its turns wrote
 * to, and `agent.memory.compileWiki()` every subject with new traces. A subject whose compile the spend budget
 * refuses is skipped with one `memory.compile_skipped` line: its traces wait for the next compile, and the other
 * subjects compile.
 *
 * Three options say what is kept and where it goes. {@link SouledAgentOptions.compile} names the provider or model
 * the compile's calls go to, or turns the compile off (`false`: raw traces only, one `memory.compile_skipped` line at
 * open). {@link SouledAgentOptions.memoryPolicy} is asked once a session for the account the turn serves: `off` files
 * nothing and recalls the operator's pages alone, `raw` files and recalls and compiles no page, `compiled` is the
 * default. {@link SouledAgentOptions.screen} is given each text before it is filed and again before it is compiled.
 * Both hooks fail closed: a hook that throws, times out or answers anything else files nothing for that write
 * (`memory.write_refused`), and a compile it fails for does not run (`memory.compile_skipped`), its traces waiting
 * with their watermark where it was. A compile started in a process that served no turn of a subject has no policy
 * answer and no hook context for it: under a policy hook it is not compiled, and under a screen hook neither.
 *
 * With `runtime: 'gmi'` no session turn sends the end user's id to the model provider unless
 * {@link SouledAgentOptions.sendUserIdToProvider} is set, and a turn whose policy answer marks a minor or a person who
 * objects to profiling, whose policy hook failed, whose subject is forgotten, or whose user id no memory key can be
 * built from, or whose tombstone read does not answer within the memory hooks' timeout, is not scored for sentiment.
 *
 * `close()` first closes the agent (with `runtime: 'gmi'` that stops its session turns), then waits, within one
 * deadline (see {@link SouledAgentOptions.pendingWritesTimeoutMs}), for the turns still running (a `generate()`, a
 * `stream()`, a session's `send()` or `stream()`, on either runtime; a stream whose signal aborted before anything was
 * read from it is not waited for, and on the default runtime a stream nobody reads and nobody aborts keeps the wait
 * until the deadline) and for the memory writes of its turns, then compiles the wiki, then closes the store. A turn or a write
 * still pending when the deadline passes is left out of the compile, and a write that reaches the store after it is
 * closed is not stored.
 *
 * @param opts - Agent options with a required `soul`.
 * @returns A fully-wired {@link Agent}.
 * @throws TypeError when `sharedMemory` is not `{ as, reason }` with a user id that names someone and one of the two
 *   reasons; nothing is opened.
 * @throws Error when `sharedMemory` is set and the store already holds the memory of another user or session; the
 *   store is closed first.
 * @throws Error when the store holds the memory of more than one user or session and `retention` is unset, or
 *   `tombstoneKey` is unset and the ledger holds no tombstone; the store is closed first. A session that would be the
 *   second subject throws the same from `agent.session()`.
 * @throws TypeError when `memoryPolicy`, `screen` or `sharedMemory` is set on an agent whose cognitive memory is on
 *   (`runtime: 'gmi'` with `cognition.memory`, the `full` profile, or the `memory` option): the GMI keeps that memory
 *   in a store of its own, which none of them reaches; nothing is opened.
 * @throws TypeError when `soulStore` is not `{ adapter }`, or is set without a `tombstoneCopy` that names a file or an
 *   adapter, or without `retention`, or without a `tombstoneKey` that holds a key; nothing is opened.
 * @throws TypeError when `tombstoneCopy` is set and names neither a file by a non-empty path nor an adapter; nothing is
 *   opened.
 * @throws Error when `soulStore` is set and a store file is at `memory/.store/memory.sqlite`, or its PostgreSQL adapter
 *   reads BIGINT as text, or its database holds another agent's memory; nothing is opened. Of two agents opened at
 *   once on an empty database, at least one is refused the same way before the tombstone ledger opens, and takes back
 *   the rows its open seeded. The host's adapter is left open on every refusal.
 */
export async function souledAgent(opts: SouledAgentOptions): Promise<SouledAgent> {
  const {
    pendingWritesTimeoutMs,
    sharedMemory,
    compile,
    memoryPolicy,
    screen,
    tombstoneKey,
    tombstoneCopy,
    retention,
    legacyMemory,
    soulStore,
    sendUserIdToProvider,
    ...rest
  } = opts;
  /** The ids the agent itself reads as naming nobody, beside the built-in ones. */
  const anonymousUserIds =
    typeof rest.learning === 'object' && rest.learning !== null ? rest.learning.anonymousUserIds : undefined;
  if (sharedMemory !== undefined) assertSharedMemory(sharedMemory, anonymousUserIds);
  if (retention !== undefined) assertRetention(retention);
  assertCompileMinors(compile);
  if (legacyMemory !== undefined) assertLegacyMemory(legacyMemory, (id) => isAnonymousUserId(id, anonymousUserIds));
  /** The key the tombstone ledger is handed: one key is the current key. A `tombstoneKey` that holds nothing is none. */
  const key =
    tombstoneKey === undefined
      ? undefined
      : typeof tombstoneKey === 'string' || tombstoneKey instanceof Uint8Array
        ? { current: tombstoneKey }
        : tombstoneKey;
  if (soulStore !== undefined) {
    assertSoulStore(soulStore);
    // An option that names nothing would fall back to the default file, or to a ledger with no second copy.
    if (!namesTombstoneCopy(tombstoneCopy)) throw new TypeError(SOUL_STORE_NEEDS_COPY);
    // The rule that a second person needs a retention period and a tombstone key counts the people this process
    // holds memory of. Another process on the same database counts its own, so each would let its first one in; with
    // sharedMemory, two processes that name different users would each open an empty store as one person's.
    if (retention === undefined || !key) throw new TypeError(SOUL_STORE_NEEDS_RETENTION_AND_KEY);
  } else if (tombstoneCopy !== undefined && !namesTombstoneCopy(tombstoneCopy)) {
    // A copy option built from configuration that is not there ({ path: process.env.X } with X unset, or null) would
    // put the second copy in the default file inside the store's own folder, which a restore of that folder replaces,
    // in a file named by an empty path, or nowhere ({ adapter: undefined } opens the ledger with no copy). Only an
    // option left out keeps the default file.
    throw new TypeError(TOMBSTONE_COPY_NAMES_NOTHING);
  }
  // The two hooks and sharedMemory act on this agent's own store. A GMI's cognitive memory files and recalls in a store
  // of its own, which none of them reaches: an account the policy turns off would still be remembered there, and
  // sessions sharedMemory runs as one user would not share it. They are refused together, before the soul is loaded:
  // an inline soul, or an optional one that does not load, builds a plain agent that keeps cognitive memory too.
  if ((memoryPolicy || screen || sharedMemory !== undefined) && rest.runtime === 'gmi' && cognitiveMemoryOf(rest as CognitionInputs)) {
    throw new TypeError(
      "souledAgent: memoryPolicy, screen and sharedMemory act on the souled agent's own memory, and cognitive memory (runtime: 'gmi' with cognition memory on) keeps a store none of them reaches; turn cognitive memory off, or leave them out",
    );
  }
  /**
   * A plain agent, where the soul gives no workspace to keep a store in. On the GMI runtime it keeps the souled
   * agent's rule for the end user's id: no session turn sends it to the model provider unless the host opts in.
   */
  const plainAgent = (options: AgentOptions, agentId: string | undefined): Agent => {
    if (options.runtime === 'gmi') {
      // No store: its cognitive memory, when on, stays its GMI's own.
      shareSoulStore(options, {
        agentId: agentId ?? '',
        sendUserIdToProvider: sendUserIdToProvider === true,
        forTurn: () => undefined,
        mechanisms: undefined,
        memoryBuilt: () => undefined,
        memoryClosed: () => undefined,
        drainWrites: async () => undefined,
      });
    }
    return agent(options);
  };
  const loaded = loadSoulFromOption(rest.soul);
  if (!loaded) {
    // The soul failed to load, and loadSoulFromOption has warned: a plain agent without it, which loads it no
    // second time and so does not warn again.
    return plainAgent({ ...rest, soul: undefined }, opts.name?.trim() || undefined);
  }
  if (!loaded.memoryDir) {
    // Inline soul: no workspace dir, so no wiki. A plain agent, and a line that says so.
    console.warn(
      '[agentos] souledAgent: the soul has no workspace folder (an inline { content } soul), so no wiki memory is ' +
        'wired: no memory index, no read_memory_page tool and no compile on close. Pass the folder that holds ' +
        'SOUL.md to have them.',
    );
    return plainAgent(rest, soulAgentIdOf(loaded.frontmatter, opts.name));
  }
  // NaN, a negative number or none is the default; Infinity is held to the longest timer when the wait starts.
  const waitMs =
    typeof pendingWritesTimeoutMs === 'number' && pendingWritesTimeoutMs >= 0
      ? pendingWritesTimeoutMs
      : DEFAULT_PENDING_WRITES_TIMEOUT_MS;
  // One budget for the agent and the compile, so both draw on the same total.
  const budget = asSpendBudget(rest.budget);
  const ledger = (rest.observability?.usageLedger as AgentOSUsageLedgerOptions | undefined) ?? rest.usageLedger;

  // The soul's one id: the wiki files under it, and nothing files under a shared fallback id.
  const agentId = soulAgentIdOf(loaded.frontmatter, opts.name);
  if (!agentId) {
    throw new Error(
      "souledAgent: the soul has no agentId and no name, and the agent has no name; set agentId in SOUL.md's front matter so the agent's memory has one stable id",
    );
  }

  /** The key the operator's own pages are indexed under; an id no key can be built from is refused before any store is made. */
  const operatorKey = conversationScopeKey(agentId, { kind: 'operator' });

  // The operator's pages under memory/ are markdown files; what people said to the agent lives in the store.
  const storeDir = path.join(loaded.memoryDir, '.store');
  /** The adapter of the host's database the store lives in (`soulStore`); undefined for the store's own file. */
  const hostAdapter = soulStore?.adapter;
  /** Whether the host's database held rows of this agent's brain before this open; such rows are never taken back. */
  let seededBefore = false;
  /** Why the open was refused: `anotherAgent` when another agent seeded the database while this one opened. */
  const refusal = { anotherAgent: false };
  if (hostAdapter) {
    // Checked before anything opens. A store file left beside the soul holds people the new store's calls never reach.
    const leftover = path.join(storeDir, 'memory.sqlite');
    if (await somethingAt(leftover)) {
      throw new Error(
        `souledAgent: soulStore is set and a store file is still at ${leftover}: the memory it holds would be out of reach of forgetUser, exportUserMemory, correctUserMemory and retention on the new store; move it into the host's database, or delete it, first`,
      );
    }
    await assertBigintReadsAsNumbers(hostAdapter, "souledAgent: soulStore's PostgreSQL adapter");
    // One agent a database: the tombstone ledger is database-wide. Another agent's database is refused here, before
    // this agent's Brain makes or migrates a table in it.
    if (await holdsAnotherBrain(hostAdapter, agentId, true)) throw new Error(SOUL_STORE_HOLDS_ANOTHER_AGENT);
    seededBefore = await brainIsSeeded(hostAdapter, agentId);
    // The agent's transactions on a PostgreSQL adapter run one at a time from here on, the open's migrations included.
    serializeTransactionsOn(hostAdapter);
  } else {
    await fs.mkdir(storeDir, { recursive: true });
    // The store holds what people said: it stays out of version control. A .gitignore already there is left as it is.
    createFileOutsideLinksSync(path.join(storeDir, '.gitignore'), '*\n');
  }
  // The tombstones' second copy, outside the store's database, so a restore of the store does not replace it. A copy
  // the host passes as an adapter is the host's to close.
  const copyPath =
    tombstoneCopy && 'adapter' in tombstoneCopy
      ? undefined
      : (tombstoneCopy?.path ?? path.join(storeDir, 'forgotten.sqlite'));
  let ownCopy: { adapter: StorageAdapter; existed: boolean } | undefined;
  if (copyPath !== undefined) {
    try {
      ownCopy = await openForgottenCopy(copyPath);
    } catch {
      // The ledger is not reached: the refusal's one line is written here.
      const refused = copyUnavailableError();
      memoryLog.warn('memory.ledger_refused', errorFields(refused));
      throw refused;
    }
  }
  const copy = ownCopy?.adapter ?? (tombstoneCopy as { adapter: StorageAdapter }).adapter;
  /** Closes the copy this function opened; an adapter the host passed is left open. */
  const closeCopy = async (): Promise<void> => {
    await ownCopy?.adapter.close().catch(() => undefined);
  };
  // A learning layer gmi() builds writes tombstones under its namespace: the ledger reads it beside the store-wide one.
  const learningConfig = typeof rest.learning === 'object' && rest.learning !== null ? rest.learning : undefined;
  const namespaces =
    rest.runtime === 'gmi' && (rest.learning === true || learningConfig !== undefined) ? [learningConfig?.namespace ?? ''] : [];
  /** When this open began: the rows it seeds in the host's database are dated from here on. */
  const openedAt = Date.now();
  let memory: Memory;
  try {
    const forgottenOptions = { copy, ...(key ? { key } : {}), namespaces };
    memory = hostAdapter
      ? await Memory.createWithAdapter(hostAdapter, {
          brainId: agentId,
          graph: true,
          selfImprove: true,
          forgotten: forgottenOptions,
          leaveAdapterOpen: true,
          // The one-agent check again, for two agents opened at once on an empty database: each passed the check
          // before the open. The Brain's open has seeded this agent's own brain_meta rows before this reads, so the
          // one that reads second finds the other's. It runs before the ledger opens, so a refused agent never
          // touches the other agent's tombstones.
          beforeLedger: async () => {
            if (await holdsAnotherBrain(hostAdapter, agentId)) {
              refusal.anotherAgent = true;
              throw new Error(SOUL_STORE_HOLDS_ANOTHER_AGENT);
            }
          },
        })
      : await Memory.createSqlite(path.join(storeDir, 'memory.sqlite'), {
          graph: true,
          selfImprove: true,
          forgotten: forgottenOptions,
        });
  } catch (err) {
    // A store whose copy is missing or unreadable, or whose tombstones need a key not given, serves nothing. A copy
    // file this open made is removed with it while its ledger table holds no row, so the next open still finds the
    // copy missing; a copy that already received the ledger, or that cannot be read, is kept for the next open.
    const emptyNewCopy = ownCopy !== undefined && !ownCopy.existed && (await holdsNoLedgerRow(ownCopy.adapter));
    await closeCopy();
    if (emptyNewCopy && copyPath !== undefined) await fs.rm(copyPath, { force: true }).catch(() => undefined);
    // The host's adapter is left open. An agent refused because another one seeded the database at the same moment
    // takes back the brain_meta rows its own open seeded, so the agent that stays opens again. No other refusal takes
    // rows back: they are this agent's own, in the database its host gave it, and an open of the same agent that is
    // live there at this moment relies on them.
    if (hostAdapter && refusal.anotherAgent && !seededBefore) {
      await dropSeededBrain(hostAdapter, agentId, openedAt).catch(() => undefined);
    }
    throw err;
  }
  /** The store's forgotten-user ledger: every write and read of a subject asks it. */
  const forgotten = memory.forgotten as ForgottenLedger;
  /** Set once the store starts to close: a deletion is then refused before any part of it runs. */
  let storeClosed = false;
  /** Closes the store, then the copy. */
  const closeStore = async (): Promise<void> => {
    storeClosed = true;
    try {
      await memory.close();
    } finally {
      await closeCopy();
    }
  };
  /** Runs a step of the open; a step that throws closes the store first, so a failed open leaves no handle open. */
  const closingOnThrow = async <T>(step: () => T | Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (err) {
      await closeStore().catch(() => undefined);
      throw err;
    }
  };

  if (hostAdapter) {
    // A deleted row's bytes are overwritten in a SQLite file; the pragma builder answers nothing on PostgreSQL.
    await closingOnThrow(async () => {
      const secure = createStorageFeatures(hostAdapter).dialect.pragma('secure_delete', 'ON');
      if (secure) await hostAdapter.exec(secure);
    });
  }

  /** The user every session that names none, and every one-shot call, runs as; undefined without `sharedMemory`. */
  const sharedUser = sharedMemory?.as;

  /**
   * This agent's key of every subject this store holds memory of, and of every session this process opened: read
   * from the registry once the open has applied the tombstones, and kept current by the session wrapper and the
   * deletions. A subject the store holds under several agent ids counts once. Without `retention`, a second one is
   * refused; without `tombstoneKey`, too, unless the ledger already holds tombstones.
   */
  const subjects = new Set<string>();
  /**
   * Whether the ledger holds a tombstone: read once the open has applied the tombstones, and set by every unkeyed
   * tombstone this ledger handle writes (the agent's deletions, its learning layer's, a call on `agent.memory`). Read
   * only while the ledger keys nothing, where every tombstone it holds is unkeyed (a ledger that holds a key's marker
   * does not open without that key).
   */
  let ledgerHoldsTombstones = false;
  // The agent's deletions, its learning layer's and a call on agent.memory write through this handle: each unkeyed
  // tombstone they write is seen here.
  const markForgotten = forgotten.markForgotten.bind(forgotten);
  forgotten.markForgotten = async (...args: Parameters<ForgottenLedger['markForgotten']>) => {
    const written = await markForgotten(...args);
    if (written.form === 'unkeyed') ledgerHoldsTombstones = true;
    return written;
  };
  /** Whether this open has written its `memory.tombstones_unkeyed` line. */
  let unkeyedNoted = false;
  /**
   * The tombstone rule for `count` subjects, the one being opened included. With a key, or one subject, nothing. With
   * no key and a ledger that holds no tombstone, a second subject is refused: its deletion would leave a tombstone
   * anyone who reads the ledger can match by hashing a guessed id. With no key and a ledger that already holds such
   * tombstones, the subject is let in, and `noteUnkeyed` says so once it is.
   */
  const assertSubjectAllowed = (count: number): void => {
    if (forgotten.keyed || count <= 1) return;
    if (!ledgerHoldsTombstones) throw new Error(TOMBSTONE_KEY_REQUIRED);
  };
  /** One `memory.tombstones_unkeyed` line an open, once `count` subjects are let in with no key. */
  const noteUnkeyed = (count: number): void => {
    if (forgotten.keyed || count <= 1 || unkeyedNoted) return;
    unkeyedNoted = true;
    memoryLog.warn('memory.tombstones_unkeyed', {});
  };
  /** This agent's key of the user or session a stored key names; undefined for the operator's and for none. */
  const ownKeyOf = (scopeId: string): string | undefined => {
    const subject = parseConversationScopeKey(scopeId)?.subject;
    if (!subject || subject.kind === 'operator') return undefined;
    try {
      return conversationScopeKey(agentId, subject);
    } catch {
      return undefined;
    }
  };

  // Traces an earlier version filed under the agent's plain id, in either form it was written in: no turn reads
  // them, and nothing here deletes, moves or rewrites them.
  const encodedAgentId = encodePlainScopeId('persona', agentId);
  const earlierTraces = await closingOnThrow(
    async () =>
      (await memory.countScope('persona', agentId)) +
      (encodedAgentId !== agentId ? await memory.countScope('persona', encodedAgentId) : 0),
  );
  if (earlierTraces > 0) memoryLog.warn('memory.legacy_traces', { count: earlierTraces });
  /** The written forms of the agent's plain scope id the older traces sit under. */
  const legacyForms = legacyScopeIds(agentId);
  /**
   * The conversation key of the user the older memory is attributed to (`legacyMemory`), as the store records it: an
   * attribution made by an earlier open stands without the option.
   */
  let legacyOwnerKey = await closingOnThrow(() => memory.legacyOwner(agentId));

  /** The subject a turn's memory is kept under: the one user of `sharedMemory` for a subject that names none. */
  const subjectOf = (subject: MemorySubject): MemorySubject =>
    sharedUser !== undefined && subject.kind === 'session' ? { kind: 'user', id: sharedUser } : subject;
  let oneShotNoted = false;
  /**
   * The subject one turn is filed and recalled under, from the context its hooks were given. A one-shot call that
   * names no user has none: nothing is filed for it and it recalls the operator's pages alone, which one line an
   * agent says.
   */
  const turnSubjectOf = (context: MemoryHookContext): MemorySubject | undefined => {
    const subject = subjectOf(context.subject);
    if (context.call !== 'one-shot' || subject.kind === 'user') return subject;
    if (!oneShotNoted) {
      oneShotNoted = true;
      memoryLog.warn('memory.one_shot_unfiled', {});
    }
    return undefined;
  };
  /** The key of every scope a turn of this agent wrote to. */
  const written = new Set<string>();

  /** How long the host's policy hook and its screen hook may take: the memory hooks' own timeout. */
  const hookTimeoutMs = rest.memoryProviderOptions?.timeoutMs ?? MEMORY_TIMEOUT_MS;
  /** The context a host's hook is given: the turn's, with the subject its memory is kept under and that subject's user. */
  const hookContextOf = (context: MemoryHookContext, subject: MemorySubject): MemoryHookContext => ({
    ...context,
    subject,
    ...(subject.kind === 'user' ? { userId: subject.id } : {}),
  });
  /**
   * The policy the host answered for each subject of a session, by session id then by the subject's key, with the
   * place of the ask that gave it, kept until the session closes: a session id opened again for another user never
   * reads the answer given for the first, and a later answer for the subject replaces it.
   */
  const sessionPolicies = new Map<string, Map<string, { policy: MemoryPolicy; ask: number }>>();
  /**
   * On the GMI runtime with cognitive memory on, the keys whose rows the soul's mind has loaded for each open session,
   * by session id: a person's rows are loaded as the first turn of each session opening begins, and kept until the
   * session closes. A load that failed is not kept, so the next turn loads again.
   */
  const mindLoads = new Map<string, Set<string>>();
  /** How many times each session id has been closed: an answer asked for before a close is kept for nothing. */
  const sessionCloses = new Map<string, number>();
  /**
   * How many corrections and single deletions of each subject's memory this process has run, by the subject's key:
   * counted twice a call, when it has passed its ownership check and before it changes anything, and again when its
   * change has settled. So each one that finished is in it, and so is one that failed partway, which may have deleted
   * a named trace already; a turn whose decision was opened while the call was changing the memory, and which may
   * have recalled a trace the call then deleted, sees the count move too. A call the agent rejected whole is not
   * counted.
   */
  const correctionCounts = new Map<string, number>();
  /**
   * For each turn's decision, its subject's count in {@link correctionCounts} when the turn asked for the decision,
   * which is before the turn recalls anything. A turn whose count has moved by the time its reply is written recalled
   * memory that a correction or a single deletion has changed since.
   */
  const correctionsAtDecision = new WeakMap<Promise<TurnPolicy>, number>();
  /**
   * What each turn decided, from its first hook to its reply's write, by the context the turn's hooks share: a turn
   * of the default runtime and a one-shot call have one of their own, and a GMI session one for its turns, which run
   * one at a time. Two turns of one session that overlap never read each other's decision.
   */
  const turnDecisions = new WeakMap<MemoryHookContext, Promise<TurnPolicy>>();
  /**
   * The decision a GMI turn read when it asked for its answer (`begin()` of the turn's soul memory), by the turn's
   * context, for as long as the context lives: a recall that resumes after its timeout reads it, so the host is asked
   * once a turn and the turn's writes keep the decision the turn began with.
   */
  const mindDecisions = new WeakMap<MemoryHookContext, Promise<TurnPolicy>>();
  /**
   * The host's latest answer for each subject this process asked about, a failure among them: what the page tool and
   * the compile read, so an earlier answer one session keeps never outlasts a later one.
   */
  const latestAnswers = new Map<string, TurnPolicy>();
  /** How many times the host's policy has been asked for, in this process: each ask's place in that order. */
  let asks = 0;
  /**
   * For each subject, the place of the ask whose answer {@link latestAnswers} and {@link served} hold: an answer asked
   * for before it, which the host gives after it, decides its own turn and nothing for the subject.
   */
  const answeredAsk = new Map<string, number>();
  /** The sessions whose `off` policy has been said. */
  const offSaid = new Set<string>();
  /** For each scope a turn of this process served under a policy that keeps memory: the policy and the turn's context. */
  const served = new Map<string, { policy: MemoryPolicy; context: MemoryHookContext }>();
  /** For each scope, the shortest `retentionDays` the host's policy answered in this process: its sweep's own period. */
  const policyDays = new Map<string, number>();

  /**
   * Asks the host's policy for the account a turn serves. A throw, a rejection, no answer in time or any answer but
   * one of the three policies is a failure: one `memory.hook_failed` line, and `'failed'`.
   */
  const askPolicy = async (context: MemoryHookContext): Promise<TurnPolicy> => {
    if (!memoryPolicy) return COMPILED;
    try {
      const answer = await within(Promise.resolve().then(() => memoryPolicy(context)), hookTimeoutMs);
      if (answer === TIMED_OUT) {
        memoryLog.warn('memory.hook_failed', { hook: 'memoryPolicy', type: 'TimeoutError', code: 'MEMORY_HOOK_TIMEOUT' });
        return 'failed';
      }
      if (!isMemoryPolicy(answer)) {
        memoryLog.warn('memory.hook_failed', { hook: 'memoryPolicy', type: 'TypeError', code: 'MEMORY_HOOK_MALFORMED' });
        return 'failed';
      }
      return answer;
    } catch (err) {
      memoryLog.warn('memory.hook_failed', { hook: 'memoryPolicy', ...errorFields(err) });
      return 'failed';
    }
  };
  /**
   * Whether a child's memory may be kept for `subject` at all: only where the store keeps that subject's memory for a
   * number of days. The period is `retention.sessions ?? retention.traces` for a session and `retention.traces` for a
   * user; an agent with no `retention` keeps memory until deletion.
   */
  const keepsMinorsMemory = (subject: MemorySubject): boolean => {
    const period = subject.kind === 'session' ? (retention?.sessions ?? retention?.traces) : retention?.traces;
    return period !== undefined && period !== 'until-deletion';
  };
  /**
   * The host's answer as the agent applies it: `minor: true` where the store would keep the child's memory until
   * deletion keeps no long-term memory, whatever `retentionDays` the answer holds.
   */
  const applied = (policy: TurnPolicy, subject: MemorySubject): TurnPolicy =>
    policy !== 'failed' && policy.minor === true && policy.longTerm !== 'off' && !keepsMinorsMemory(subject)
      ? { longTerm: 'off', minor: true, ...(policy.profiling === 'off' ? { profiling: 'off' as const } : {}) }
      : policy;
  /**
   * What one turn's memory does, decided once a turn: the answer kept for its session, else the host's answer now. A
   * valid answer of a session turn is kept for the session; a failure is kept for nothing, so the next turn asks again.
   * A later answer for the same subject, given to any turn of this agent, replaces the one a session keeps from the
   * session's next turn: a valid one with no new ask, a failed one by asking again.
   */
  const decide = async (context: MemoryHookContext, subject: MemorySubject, scopeId: string): Promise<TurnPolicy> => {
    const hookContext = hookContextOf(context, subject);
    const session = context.call === 'session' ? context.sessionId : undefined;
    const closesBefore = session !== undefined ? (sessionCloses.get(session) ?? 0) : 0;
    const ofSession = session !== undefined ? sessionPolicies.get(session) : undefined;
    const kept = ofSession?.get(scopeId);
    if (ofSession && kept) {
      const newestAsk = answeredAsk.get(scopeId) ?? 0;
      if (newestAsk <= kept.ask) return kept.policy;
      const newest = latestAnswers.get(scopeId);
      if (newest !== undefined && newest !== 'failed') {
        // The newest answer was applied, and its period and its compile recorded, by the turn that asked for it.
        ofSession.set(scopeId, { policy: newest, ask: newestAsk });
        return newest;
      }
      ofSession.delete(scopeId);
    }
    const ask = ++asks;
    const policy = applied(await askPolicy(hookContext), subject);
    // The subject's answer is the one asked for last, whenever the host gives it: an answer to an earlier ask that
    // comes after a later one's decides this turn alone.
    const latest = ask > (answeredAsk.get(scopeId) ?? 0);
    if (latest) {
      answeredAsk.set(scopeId, ask);
      latestAnswers.set(scopeId, policy);
    }
    if (policy === 'failed') {
      // A failed answer is the latest: no compile reads an earlier permission for the subject.
      if (latest) served.delete(scopeId);
      return policy;
    }
    if (policy.longTerm !== 'off' && policy.retentionDays !== undefined) {
      policyDays.set(scopeId, Math.min(policyDays.get(scopeId) ?? Number.POSITIVE_INFINITY, policy.retentionDays));
    }
    // Kept only where a hook reads it later: the session's answer for its next turns, the scope's for its compile. An
    // answer that came after its session closed is not kept for the session's next opening.
    if (memoryPolicy && session !== undefined && (sessionCloses.get(session) ?? 0) === closesBefore) {
      const answers = sessionPolicies.get(session) ?? new Map<string, { policy: MemoryPolicy; ask: number }>();
      answers.set(scopeId, { policy, ask });
      sessionPolicies.set(session, answers);
    }
    // The compile reads the host's latest answer for the subject: an `off` answer takes back an earlier permission,
    // and neither an answer a session keeps from before nor one to an earlier ask is a new one.
    if ((memoryPolicy || screen) && latest) {
      if (policy.longTerm === 'off') served.delete(scopeId);
      else served.set(scopeId, { policy, context: hookContext });
    }
    return policy;
  };
  /**
   * The decision of the turn a hook call belongs to. A turn's recall opens it; the write of its reply closes it, so
   * the whole turn recalls and files under one answer, and a hook that failed is not asked a second time in the turn.
   * A decision keeps, from when it is opened, how many corrections and single deletions its subject's memory had been
   * through ({@link correctionsAtDecision}).
   */
  const turnPolicyOf = (
    context: MemoryHookContext,
    subject: MemorySubject,
    scopeId: string,
    at: 'recall' | 'mind' | 'user' | 'assistant',
  ): Promise<TurnPolicy> => {
    // A recall that comes after its turn asked for its answer (one that timed out and resumed) reads that answer.
    const asked = at === 'recall' ? mindDecisions.get(context) : undefined;
    if (asked) return asked;
    const open = at === 'recall' ? undefined : turnDecisions.get(context);
    const decision = open ?? decide(context, subject, scopeId);
    if (!open) correctionsAtDecision.set(decision, correctionCounts.get(scopeId) ?? 0);
    if (at === 'mind') mindDecisions.set(context, decision);
    if (at === 'assistant') turnDecisions.delete(context);
    else turnDecisions.set(context, decision);
    return decision;
  };
  /**
   * What a turn may do with the person it serves, from its decision. A policy that keeps memory recalls; it lets a
   * recall drift what it reads, and the person's message be scored for sentiment, unless it marks them a minor or a
   * person who objects to profiling. `off` recalls nothing, and the message is scored unless the answer holds one of
   * those marks. A failed hook allows nothing.
   */
  const soulAnswerOf = (policy: TurnPolicy): SoulTurnAnswer => {
    if (policy === 'failed') return { ...SOUL_TURN_NOTHING };
    const profiled = policy.profiling !== 'off' && policy.minor !== true;
    if (policy.longTerm === 'off') return { recall: false, reconsolidation: false, sentiment: profiled };
    return { recall: true, reconsolidation: profiled, sentiment: profiled };
  };
  /**
   * Whether the tombstone ledger says `subject` is not forgotten, read within the memory hooks' timeout: a read that
   * has not answered by then counts as forgotten, with one `memory.hook_failed` line (`hook: 'soulMemory'`), so a
   * stalled store never holds a turn before its model call.
   */
  const notForgottenWithin = async (subject: MemorySubject): Promise<boolean> => {
    const read = await within(forgotten.isForgotten(subject), hookTimeoutMs);
    if (read !== TIMED_OUT) return !read;
    memoryLog.warn('memory.hook_failed', { hook: 'soulMemory', type: 'TimeoutError', code: 'MEMORY_HOOK_TIMEOUT' });
    return false;
  };
  /**
   * Whether the agent's cognitive memory is the soul's mind: on the GMI runtime with cognitive memory on, the mind
   * files each session turn in this store and recalls the rows it filed, and the provider recalls the rest.
   */
  const mindRecalls = rest.runtime === 'gmi' && cognitiveMemoryOf(rest as CognitionInputs);
  /** The store's own Brain, which the soul's mind files into and reads on the GMI runtime with cognitive memory on. */
  const soulBrain = brainOf(memory);
  /** The managers of the soul's mind open in this process: the ones `gmi()` built on {@link soulBrain}, until it shuts each down. */
  const mindManagers = new Set<ICognitiveMemoryManager>();
  /** When `close()` began: the turns and the writes it waits for, the mind's among them, share one deadline from here. */
  let closeStartedAt: number | undefined;
  /** What is left of `close()`'s one deadline; all of it before the close begins. */
  const closeWaitLeft = (): number => (closeStartedAt === undefined ? waitMs : Math.max(0, closeStartedAt + waitMs - Date.now()));
  /** What the failures of the soul's mind to store a side of a turn are counted by, for their sparse log line. */
  const mindFailures = {};
  /** The filings of the soul's mind that have started and not settled: `agent.close()` waits for them. */
  const mindFilings = new Set<Promise<unknown>>();
  /** Holds one filing of the soul's mind in {@link mindFilings} until it settles; returns it unchanged. */
  const mindFiling = <T>(run: Promise<T>): Promise<T> => {
    mindFilings.add(run);
    const settle = () => {
      mindFilings.delete(run);
    };
    void run.then(settle, settle);
    return run;
  };
  /**
   * Loads the rows the soul's mind filed under `scopeId` into its manager, on the first turn of a session opening that
   * recalls: the key's newest rows, which the store already holding some of skips. Any other manager reads its own
   * store and is not asked. A load that rejects is the caller's, and is not kept, so the session's next turn loads again;
   * one that the session's close outran is not kept either.
   */
  const loadForSession = async (manager: ICognitiveMemoryManager, context: MemoryHookContext, scopeId: string): Promise<void> => {
    if (manager.getConfig?.()?.rows !== 'mind' || context.call !== 'session') return;
    const session = context.sessionId;
    if (mindLoads.get(session)?.has(scopeId)) return;
    const closesBefore = sessionCloses.get(session) ?? 0;
    await manager.getStore().hydrateScope('conversation', scopeId);
    if ((sessionCloses.get(session) ?? 0) !== closesBefore) return;
    const loaded = mindLoads.get(session) ?? new Set<string>();
    loaded.add(scopeId);
    mindLoads.set(session, loaded);
  };
  /**
   * One session turn's view of the memory rules, for the GMI that serves it on `runtime: 'gmi'`: the subject's key, and
   * the turn's decision, which its recall may have opened and its two writes share. A turn with no subject has none. A
   * subject whose id no key can be built from has no key and no policy to ask: its view has no scope and allows
   * nothing, so the turn is not scored for sentiment, and one `memory.hook_failed` line says so; it files nothing
   * (`no_subject`).
   *
   * Its `file` runs one side of the turn through the same gate as the provider's writes ({@link fileTurn}), on the
   * subject's chain, so close() waits for it and no compile, deletion or sweep of the subject runs beside it. The
   * mind's writer is handed the text the screen kept, a neutral stamp, and the filing that marks the row as the mind's
   * with its speaker and its subject, the subject whose key the view names; the key's registry row is written before
   * the trace and again after it, and `agent.close()` waits for the filing before the mind's manager shuts down. A
   * throw in the write is counted as the mind's own failure. Its `begin()` loads the subject's rows into the mind as the
   * first turn of a session opening that recalls begins ({@link loadForSession}).
   */
  const soulTurnOf = (context: MemoryHookContext): SoulTurnMemory | undefined => {
    const subject = turnSubjectOf(context);
    if (!subject) return undefined;
    let scopeId: string;
    try {
      scopeId = conversationScopeKey(agentId, subject);
    } catch (err) {
      memoryLog.warn('memory.hook_failed', { hook: 'soulMemory', ...errorFields(err) });
      return {
        begin: async () => ({ ...SOUL_TURN_NOTHING }),
        file: async (role) => ({ role, outcome: 'skipped', reason: 'no_subject' }),
      };
    }
    const filedFor = { kind: subject.kind, id: subject.id };
    return {
      scope: { scope: 'conversation', scopeId },
      file: (role, content, write, undo) =>
        mindFiling(
          onSubject(scopeId, () =>
            fileTurn(
              role,
              content,
              context,
              subject,
              scopeId,
              async (text) => {
                // The key's registry row, before the trace and again after it, as the store's own writes keep it: a
                // deletion of the key that ran meanwhile took the row away.
                await ensureScopeRow(soulBrain, soulBrain.brainId, scopeId, Date.now());
                const trace = await write({
                  text,
                  stamp: 'neutral',
                  filing: { filedBy: 'mind', speaker: role, subject: { ...filedFor } },
                  ...(subject.kind === 'user' ? { turnUserId: subject.id } : {}),
                });
                await ensureScopeRow(soulBrain, soulBrain.brainId, scopeId, Date.now());
                return trace;
              },
              undo,
              (err) => reportMindWriteFailure(mindFailures, err),
            ),
          ),
        ),
      begin: async (manager, stop) => {
        // A forgotten subject is allowed nothing, and the host's hook is not asked about them.
        if (!(await notForgottenWithin(subject))) return { ...SOUL_TURN_NOTHING };
        // A turn stopped meanwhile asks the host nothing: an answer it started after its session closed would be kept
        // for the session's next opening.
        if (stop?.aborted) return { ...SOUL_TURN_NOTHING };
        const policy = await turnPolicyOf(context, subject, scopeId, 'mind');
        // Nor is a subject forgotten while the host answered.
        if (!(await notForgottenWithin(subject))) return { ...SOUL_TURN_NOTHING };
        const answer = soulAnswerOf(policy);
        // A turn that recalls loads the person's rows into the mind first, once a session opening. A load that throws is
        // the answer's failure: the turn recalls nothing of the mind and files as usual.
        if (answer.recall && manager) await loadForSession(manager, context, scopeId);
        return answer;
      },
    };
  };
  /**
   * Whether the page tool serves a subject its own pages: always without a policy hook; under one, only when the
   * host's latest answer for the subject keeps memory. An `off` answer, a failed hook and a subject this process has
   * not asked about read the operator's pages alone.
   */
  const ownPagesServed = (scopeId: string): boolean => {
    if (!memoryPolicy) return true;
    const answer = latestAnswers.get(scopeId);
    return answer !== undefined && answer !== 'failed' && answer.longTerm !== 'off';
  };
  /**
   * `text` through the host's screen hook: the text to use, null when the hook drops it, or {@link SCREEN_FAILED}
   * (with one `memory.hook_failed` line) when it throws, rejects, does not answer in time or answers anything else.
   */
  const screened = async (
    text: string,
    context: MemoryHookContext,
    stage: 'file' | 'compile',
  ): Promise<string | null | typeof SCREEN_FAILED> => {
    if (!screen) return text;
    try {
      const answer = await within(Promise.resolve().then(() => screen(text, { ...context, stage })), hookTimeoutMs);
      if (answer === TIMED_OUT) {
        memoryLog.warn('memory.hook_failed', { hook: 'screen', type: 'TimeoutError', code: 'MEMORY_HOOK_TIMEOUT' });
        return SCREEN_FAILED;
      }
      if (answer === null) return null;
      if (typeof answer !== 'string') {
        memoryLog.warn('memory.hook_failed', { hook: 'screen', type: 'TypeError', code: 'MEMORY_HOOK_MALFORMED' });
        return SCREEN_FAILED;
      }
      return answer;
    } catch (err) {
      memoryLog.warn('memory.hook_failed', { hook: 'screen', ...errorFields(err) });
      return SCREEN_FAILED;
    }
  };
  /**
   * Files one side of a turn under its subject's key, when the account's policy keeps memory and the screen hook
   * lets the text through, and answers what became of it. A reply is not filed either when a correction or a single
   * deletion has changed its subject's memory since its turn's decision was opened (`corrected`). Each write that is
   * not made says why in one `memory.write_refused` line, except under an `off` policy, the host's standing choice for
   * the account, which is said once a session; the entry it answers names the same reason. It never rejects: a throw,
   * from the write or from a read before it, answers a `failed` entry with the error's class name, and is counted and
   * logged as a failure of the provider's `observe` (`memory.hook_failed`, sparsely).
   *
   * @param write - Stores the text the screen let through, and resolves with its trace.
   * @param undo - Deletes a trace `write` stored, for good: a write that landed after the subject was forgotten.
   * @param reportFailure - Counts and logs a throw: the provider's `observe` failure, unless the writer says whose it is
   *   (the soul's mind reports its own).
   */
  const fileTurn = async (
    role: Speaker,
    text: string,
    context: MemoryHookContext,
    subject: MemorySubject,
    scopeId: string,
    write: (text: string) => Promise<MemoryTrace>,
    undo: (trace: MemoryTrace) => Promise<void>,
    reportFailure: (error: unknown) => void = (error) => reportObserveFailure(provider, error),
  ): Promise<MemoryWriteEntry> => {
    try {
      // A forgotten subject's text goes nowhere: not to the host's hooks, not to the store.
      if (await forgotten.isForgotten(subject)) {
        memoryLog.warn('memory.write_refused', { reason: 'forgotten' });
        return { role, outcome: 'skipped', reason: 'forgotten' };
      }
      const decision = turnPolicyOf(context, subject, scopeId, role);
      const policy = await decision;
      if (policy === 'failed') {
        memoryLog.warn('memory.write_refused', { reason: 'policy_failed' });
        return { role, outcome: 'skipped', reason: 'policy_failed' };
      }
      if (policy.longTerm === 'off') {
        // A child's answer on a store that would keep their memory until deletion says so in its own reason.
        const reason: 'minor_no_retention' | 'policy_off' =
          policy.minor === true && !keepsMinorsMemory(subject) ? 'minor_no_retention' : 'policy_off';
        if (context.call !== 'session' || !offSaid.has(context.sessionId)) {
          if (context.call === 'session') offSaid.add(context.sessionId);
          memoryLog.warn('memory.write_refused', { reason });
        }
        return { role, outcome: 'skipped', reason };
      }
      // A reply written from memory that a correction or a single deletion has changed since the turn recalled it can
      // restate what was deleted, under a new id no later call names: it is not filed, and goes to no hook. What the
      // person said themselves is filed as usual.
      if (role === 'assistant' && (correctionCounts.get(scopeId) ?? 0) !== (correctionsAtDecision.get(decision) ?? 0)) {
        memoryLog.warn('memory.write_refused', { reason: 'corrected' });
        return { role, outcome: 'skipped', reason: 'corrected' };
      }
      const filed = await screened(text, hookContextOf(context, subject), 'file');
      if (filed === SCREEN_FAILED) {
        memoryLog.warn('memory.write_refused', { reason: 'screen_failed' });
        return { role, outcome: 'skipped', reason: 'screen_failed' };
      }
      if (filed === null || filed === '') {
        memoryLog.warn('memory.write_refused', { reason: 'screened' });
        return { role, outcome: 'skipped', reason: 'screened' };
      }
      written.add(scopeId);
      // The tombstone is read again once the trace is stored: a trace that landed after the subject was forgotten is
      // deleted again.
      let landed = false;
      const outcome = await guardedWrite(
        forgotten,
        subject,
        async () => {
          const trace = await write(filed);
          landed = true;
          return trace;
        },
        undo,
      );
      if (outcome.status !== 'refused') return { role, outcome: 'written', traceId: outcome.result.id };
      memoryLog.warn('memory.write_refused', { reason: 'forgotten' });
      if (landed) {
        // The write landed after the subject's tombstone and is taken back. Its scope's registry row, which the write
        // made again when the subject's deletion had already run, goes with whatever the scope still holds.
        await memory.deleteScope('conversation', scopeId).catch(() => undefined);
      }
      return { role, outcome: 'skipped', reason: 'forgotten' };
    } catch (err) {
      // The record names the error's class; the log counts the failure as its writer's and writes it sparsely.
      reportFailure(err);
      return failedWriteEntry(role, err);
    }
  };
  /**
   * Asked before a scope's traces are compiled. Under a policy hook, a scope no turn of this process was served for,
   * or whose account keeps raw traces only, is not compiled. Under a screen hook, a scope with no turn of this process
   * has no context to screen with, and is not compiled; otherwise each trace's text goes through the hook again: what
   * it returns is what is compiled, a trace it drops is left out, and a failure stops the scope's compile. The
   * account's latest answer is read again once the screen has answered, so an `off` answer given meanwhile stops the
   * compile. A minor's scope is compiled by the target `compile.minors` names, and not at all without one. The batch's
   * model call it hands back reads the latest answer again before each merge.
   */
  const beforeScopeCompile: NonNullable<AttachedWiki['beforeScopeCompile']> = async (scopeId, traces) => {
    const turn = served.get(scopeId);
    if (memoryPolicy && turn?.policy.longTerm !== 'compiled') return { skip: 'policy_raw' };
    // Checked before the screen, so a minor's text goes to no hook for a compile that cannot run.
    if (turn?.policy.minor === true && !minorsLlm) return { skip: 'minor_no_compile' };
    let kept: typeof traces = traces;
    if (screen) {
      if (!turn) return { skip: 'screen_failed' };
      kept = [];
      let dropped = false;
      for (const trace of traces) {
        const text = await screened(trace.content, turn.context, 'compile');
        if (text === SCREEN_FAILED) return { skip: 'screen_failed' };
        if (text === null || text === '') {
          dropped = true;
          continue;
        }
        kept.push(text === trace.content ? trace : { ...trace, content: text });
      }
      // The host may have answered again while the screen ran: the compile goes on only under the latest answer.
      if (memoryPolicy && served.get(scopeId)?.policy.longTerm !== 'compiled') return { skip: 'policy_raw' };
      if (dropped) memoryLog.warn('memory.write_refused', { reason: 'screened' });
    }
    // A minor's pages go to the target named for minors alone, and nowhere without one.
    if (served.get(scopeId)?.policy.minor === true && !minorsLlm) return { skip: 'minor_no_compile' };
    // Each model call of the compile reads the latest answer again (compileCallOf).
    return { traces: kept, llm: (prompt) => compileCallOf(scopeId, prompt) };
  };
  /**
   * One model call of `scopeId`'s compile, on the route the account's latest answer gives when the call is sent: a
   * minor's on the target `compile.minors` names, any other account's on the compile's own. An answer given while the
   * compile runs holds from its next call; one that no longer compiles the account, or a minor's with no target named
   * for minors, stops the compile before the call is sent ({@link CompileStopped}).
   */
  const compileCallOf = async (scopeId: string, prompt: string): Promise<string> => {
    const latest = served.get(scopeId)?.policy;
    if (memoryPolicy && latest?.longTerm !== 'compiled') throw new CompileStopped('policy_raw');
    if (latest?.minor === true) {
      if (!minorsLlm) throw new CompileStopped('minor_no_compile');
      return minorsLlm(prompt);
    }
    return llm(prompt);
  };

  // The turns still running and the memory writes the observer has started, until each settles: close() waits for
  // them before it compiles. A turn never waits for its writes.
  const pending = new Set<Promise<unknown>>();
  /** Adds `work` to what close() waits for, until it settles; returns it unchanged. */
  const awaitedOnClose = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    const settle = () => {
      pending.delete(work);
    };
    void work.then(settle, settle);
    return work;
  };
  /**
   * One promise chain per subject key: every write and compile of a subject runs on it, one after another, and a
   * deletion of the subject takes it too. Each run is held in {@link pendingBySubject} from before it starts until it
   * settles, so a deletion that waits for a subject's pending work sees a write before its first check.
   */
  const chains = new WriteChains();
  const pendingBySubject = new Map<string, Set<Promise<unknown>>>();
  /** Runs `work` on the subject's chain; close() waits for it. */
  const onSubject = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const run = chains.run(key, work);
    let ofSubject = pendingBySubject.get(key);
    if (!ofSubject) {
      ofSubject = new Set();
      pendingBySubject.set(key, ofSubject);
    }
    const held = ofSubject;
    held.add(run);
    const settle = () => {
      held.delete(run);
      if (held.size === 0 && pendingBySubject.get(key) === held) pendingBySubject.delete(key);
    };
    void run.then(settle, settle);
    return awaitedOnClose(run);
  };
  /**
   * True once close() has waited for the pending writes: it then sweeps and compiles what is stored at once, past any
   * write still running, which holds its subject's chain.
   */
  let closing = false;
  /**
   * A stream is settled once its usage and its text are known; its text settles after its observation has started.
   * On the default runtime a stream runs only once a consumer reads it, so one whose `signal` aborts before anything
   * was read from it would never settle: its entry is released on that abort instead. An abort after the first read
   * ends the stream on either runtime, which settles its usage.
   */
  const awaitStreamOnClose = (result: StreamTextResult, signal: AbortSignal | undefined): StreamTextResult => {
    const settled = Promise.allSettled([result.usage, result.text]).then(() => undefined);
    if (!signal) {
      awaitedOnClose(settled);
      return result;
    }
    let read = false;
    const abortedUnread = new Promise<void>((resolve) => {
      const onAbort = () => {
        if (!read) resolve();
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        void settled.then(() => signal.removeEventListener('abort', onAbort));
      }
    });
    awaitedOnClose(Promise.race([settled, abortedUnread]));
    const onRead = <T>(iterable: AsyncIterable<T>): AsyncIterable<T> => ({
      [Symbol.asyncIterator](): AsyncIterator<T> {
        const inner = iterable[Symbol.asyncIterator]();
        return {
          next: (...args: [] | [undefined]) => {
            read = true;
            return inner.next(...args);
          },
          ...(inner.return ? { return: inner.return.bind(inner) } : {}),
          ...(inner.throw ? { throw: inner.throw.bind(inner) } : {}),
        };
      },
    });
    result.textStream = onRead(result.textStream);
    result.fullStream = onRead(result.fullStream);
    return result;
  };

  // Adapt the Memory facade directly to the provider contract. AgentMemory's own
  // getContext/observe signatures don't match AgentMemoryProvider, so wrap the
  // facade's remember/recall here.
  const provider: AgentMemoryProvider = {
    observe: (role, text, context) => {
      // Nothing is ever filed without the subject of its turn.
      if (!context) return Promise.reject(new TypeError('souledAgent: a memory write needs the hook context of its turn'));
      const subject = turnSubjectOf(context);
      if (!subject) return Promise.resolve<MemoryWriteEntry>({ role, outcome: 'skipped', reason: 'no_subject' });
      let scopeId: string;
      try {
        scopeId = conversationScopeKey(agentId, subject);
      } catch (err) {
        // An id no key can be built from files nothing: the failure is logged as the hook's, and the turn goes on.
        reportObserveFailure(provider, err);
        return Promise.resolve<MemoryWriteEntry>({ role, outcome: 'skipped', reason: 'no_subject' });
      }
      // The whole write, its policy and its screening with it, runs on the subject's chain, and close() waits for it.
      // The user's message and the reply alike go under the subject's key. Who spoke goes in the trace's metadata:
      // outside its text and its tags, which full-text search reads.
      return onSubject(scopeId, () =>
        fileTurn(
          role,
          text,
          context,
          subject,
          scopeId,
          (filed) =>
            memory.remember(filed, {
              type: 'episodic',
              scope: 'conversation',
              scopeId,
              metadata: {
                [SPEAKER_METADATA_KEY]: role,
                subject: { kind: subject.kind, id: subject.id },
                ...(subject.kind === 'user' ? { turnUserId: subject.id } : {}),
              },
            }),
          async (trace) => {
            await memory.deleteTraces([trace.id]);
          },
        ),
      );
    },
    getContext: async (text, options) => {
      // Two reads, each of one key, by equality: the turn's own subject, and the operator's pages. Nothing a caller
      // passes widens them. A turn with no subject, one whose id no key can be built from, and one whose account
      // keeps no memory (or whose policy hook failed) read the operator's pages alone.
      const context = options?.context;
      const subject = context ? turnSubjectOf(context) : undefined;
      // A forgotten subject is recalled nothing: neither their memory nor the operator's pages.
      if (subject && (await forgotten.isForgotten(subject))) return null;
      let own: ScoredTrace[] = [];
      if (context && subject) {
        let scopeId: string | undefined;
        try {
          scopeId = conversationScopeKey(agentId, subject);
        } catch (err) {
          // An id no key can be built from has no memory to read: the turn goes on with the operator's pages.
          memoryLog.warn('memory.hook_failed', { hook: 'getContext', ...errorFields(err) });
        }
        if (scopeId !== undefined) {
          const policy = await turnPolicyOf(context, subject, scopeId, 'recall');
          if (policy !== 'failed' && policy.longTerm !== 'off') {
            // On a session turn the soul's mind recalls what it filed itself: the provider reads the rest of the key.
            // A one-shot call, which the mind does not serve, reads the key whole.
            const side = mindRecalls && context.call === 'session' ? { filedBy: 'soul' as const } : {};
            own = await memory.recall(text, { scope: 'conversation', scopeId, limit: RECALL_LIMIT, ...side });
            // The older memory attributed to this user is theirs too: a third read, of each form of the agent's plain
            // scope, merged with the other two under the same budget. No other subject reads it.
            if (legacyOwnerKey !== undefined && scopeId === legacyOwnerKey) {
              for (const form of legacyForms) {
                own.push(...(await memory.recall(text, { scope: LEGACY_SCOPE, scopeId: form, limit: RECALL_LIMIT })));
              }
            }
          }
        }
      }
      const shared = await memory.recall(text, { scope: 'conversation', scopeId: operatorKey, limit: RECALL_LIMIT });
      // Best match first across the two reads; a score that is not a number ranks last.
      const rank = (score: number): number => (Number.isFinite(score) ? score : 0);
      const scored = [...own, ...shared].sort((a, b) => rank(b.score) - rank(a.score));
      const now = Date.now();
      // A recalled trace carries no metadata, so each one's speaker is read from its stored record.
      const lines: RecallLine[] = await Promise.all(
        scored.map(async ({ trace }) => {
          const page = wikiPageOf(trace);
          const speaker = page ? ('note' as const) : speakerIn((await memory.readTrace(trace.id))?.metadata);
          const label = page ? `note ${page}` : speaker;
          return {
            prefix: recallPrefix(trace, label, now),
            content: onOneLine(trace.content),
            ...(speaker ? { speaker } : {}),
            ...(page ? { page } : {}),
            when: formatMemoryAge(trace.createdAt, now),
          };
        }),
      );
      const kept = fitRecallLines(lines, options?.tokenBudget ?? DEFAULT_MEMORY_TOKEN_BUDGET);
      if (kept.length === 0) return null;
      return {
        contextText: kept.map((line) => `${line.prefix}${line.content}`).join('\n'),
        // The same lines as records: a line whose label was dropped for the budget keeps its text alone.
        items: kept.map((line) => ({
          ...(line.prefix && line.speaker ? { speaker: line.speaker } : {}),
          ...(line.prefix && line.page ? { page: line.page } : {}),
          ...(line.prefix ? { when: line.when } : {}),
          text: line.content,
        })),
      };
    },
  };

  // The compile's model calls: the agent's route and fallback settings, its completion cap (the budget's check
  // estimates a call without one at 4,096 output tokens), its budget (checked before each call and charged after it; a
  // refusal skips that subject's compile, and its watermark stays where it was), and its usage ledger. A compile
  // target the host named takes them instead: that provider and model alone, with no fallback and no router, so a
  // compile's text goes nowhere else; the agent's own key and base URL go with it only to the agent's own provider.
  // `compile.minors` is such a target, for the accounts the host answers `minor: true` for alone.
  const compileOptions = typeof compile === 'object' && compile !== null ? compile : undefined;
  const { minors: minorsTarget, ...namedTarget } = compileOptions ?? ({} as NonNullable<typeof compileOptions>);
  // An object that holds `minors` alone names no target for the other accounts: their compile keeps the agent's route.
  const target =
    compileOptions !== undefined && (Object.keys(namedTarget).length > 0 || minorsTarget === undefined)
      ? namedTarget
      : undefined;
  // The provider the agent's own model belongs to, when only its model names it.
  const agentProvider = (() => {
    if (rest.provider !== undefined) return rest.provider;
    if (rest.model === undefined) return undefined;
    try {
      return resolveModelOption({ model: rest.model }, 'text').providerId;
    } catch {
      return undefined;
    }
  })();
  /**
   * The provider the agent names itself: its `provider`, else the known provider its model's own `provider:` or
   * `provider/` prefix names. Never one the environment or a default picks for a plain model.
   */
  const agentNamedProvider = providerNamedBy(rest.provider, rest.model);
  /** The provider and model a compile on `named` calls, or on the agent's own route when it is undefined. */
  const compileRouteOf = (
    named: { provider?: string; model?: string } | undefined,
  ): { provider: string | undefined; model: string | undefined } => {
    // A target that names a model alone, whose `provider:` prefix names another provider than the agent's, does not
    // take the agent's provider.
    const provider =
      named === undefined
        ? rest.provider
        : (named.provider ??
          (rest.provider !== undefined && named.model !== undefined && modelNamesAnotherProvider(rest.provider, named.model)
            ? undefined
            : rest.provider));
    // A target that names a provider alone runs on that provider's default model, unless it is the agent's own
    // provider: the agent's model belongs to the agent's provider.
    const model = named?.model ?? (named?.provider === undefined || named.provider === agentProvider ? rest.model : undefined);
    return { provider, model };
  };
  /**
   * The provider, model, key and base URL a compile on `named` is sent with, or on the agent's own route when it is
   * undefined. The agent's key and base URL go with it only when its call resolves to the provider they were set for,
   * whether the agent names it or only its model does; with `strict`, only when the agent names that provider itself.
   */
  const compileSendOf = (
    named: { provider?: string; model?: string; apiKey?: string; baseUrl?: string } | undefined,
    strict: boolean,
  ): CallRoute => {
    const route = compileRouteOf(named);
    const agentCredentialsGo =
      named === undefined ||
      (strict
        ? agentNamedProvider !== undefined && agentNamedProvider === route.provider
        : credentialsGoWith({ provider: rest.provider, model: rest.model }, route));
    return {
      ...route,
      apiKey: named?.apiKey ?? (agentCredentialsGo ? rest.apiKey : undefined),
      baseUrl: named?.baseUrl ?? (agentCredentialsGo ? rest.baseUrl : undefined),
      strict,
    };
  };
  /**
   * The compile's model call on `named`, a target the host named, or on the agent's own route when it is undefined.
   * `strict`, for the target named for minors, sends to that provider alone: no Anthropic to OpenRouter reroute when
   * it has no key, no `setDefaultProvider()` default that names no provider, and the agent's own key and base URL only
   * when the agent names that provider itself ({@link agentNamedProvider}).
   */
  const compileLlmOn = (
    named: { provider?: string; model?: string; apiKey?: string; baseUrl?: string } | undefined,
    strict = false,
  ) => {
    const call = compileSendOf(named, strict);
    // Where the compile's text goes, as recipients() names it, recorded when the options do not name it (an Anthropic
    // target the credential layer sends to OpenRouter).
    const role = strict ? 'compile-minors' : 'compile';
    return async (prompt: string): Promise<string> => {
      noteRoute(routeRecipient(role, destinationOf(call, true)));
      return (
        await generateText({
          provider: call.provider,
          model: call.model,
          prompt,
          maxTokens: rest.maxTokens ?? rest.controls?.maxTotalTokens,
          apiKey: call.apiKey,
          baseUrl: call.baseUrl,
          ...(named
            ? { fallbackProviders: [] }
            : {
                fallbackProviders: rest.fallbackProviders,
                onFallback: rest.onFallback,
                router: rest.router ? recordingPicks(rest.router, role, () => call) : undefined,
                hostPolicy: rest.hostPolicy,
                routerParams: rest.routerParams,
                policyTier: rest.policyTier,
              }),
          ...(budget ? { budget } : {}),
          ...(rest.accountIdOf ? { accountIdOf: rest.accountIdOf } : {}),
          usageLedger: { ...(ledger ?? {}), source: SOULED_AGENT_COMPILE_SOURCE },
          ...(strict ? { __strictCredentials: true } : {}),
        })
      ).text;
    };
  };
  const llm = compileLlmOn(target);
  /** The compile's model call for a minor's pages: the target `compile.minors` names, or none, and no page. */
  const minorsLlm = minorsTarget === undefined ? undefined : compileLlmOn(minorsTarget, true);

  /**
   * Where a route sends a person's text: the provider a known `provider:` prefix of its model names, over its own
   * `provider`, as a call resolves it; with `inEnvironment`, also where the credential layer sends it in this process
   * now (an Anthropic route with no key or base URL of its own while `OPENROUTER_API_KEY` is set goes to OpenRouter).
   * A route that names no provider is the environment's pick at each call.
   */
  const destinationOf = (route: CallRoute, inEnvironment: boolean): NamedRoute => {
    let provider = route.provider;
    let model = route.model;
    if (model !== undefined && (provider !== undefined || providerNamedBy(undefined, model) !== undefined)) {
      try {
        const resolved = resolveModelOption({ ...(provider !== undefined ? { provider } : {}), model }, 'text');
        provider = resolved.providerId;
        model = resolved.modelId;
      } catch {
        // A route that does not resolve is named as the options give it.
      }
    }
    if (inEnvironment && provider !== undefined) {
      try {
        const sent = resolveProviderRoute(provider, model ?? '', { apiKey: route.apiKey, baseUrl: route.baseUrl, strict: route.strict });
        if (sent.providerId !== provider) {
          provider = sent.providerId;
          model = model === undefined ? undefined : sent.modelId;
        }
      } catch {
        // No credentials for it in this process: a call on it fails before it sends anything.
      }
    }
    return { provider, model };
  };
  /**
   * The embedding route of cognitive memory on the GMI runtime, resolved at open as the memory resolves it when it is
   * built (a model's `provider:` prefix, the provider's default model, the default provider's or the environment's pick
   * when no provider is named); undefined when cognitive memory is off. The route the memory was built with, which a
   * default provider changed in between can move, is recorded when the memory is built.
   */
  const embeddingRoute = ((): NamedRoute | undefined => {
    if (rest.runtime !== 'gmi') return undefined;
    let memoryConfig: ReturnType<typeof resolveCognition>['memory'];
    try {
      memoryConfig = resolveCognition(rest as CognitionInputs).memory;
    } catch {
      return undefined;
    }
    if (!memoryConfig) return undefined;
    try {
      return embeddingRouteOf(memoryConfig);
    } catch {
      // gmi() refuses to build such a memory; named as the options give it.
      return { provider: memoryConfig.embedding?.provider, model: memoryConfig.embedding?.model };
    }
  })();
  /** The options' own fallback hops, each with its own key and base URL; undefined for the automatic chain. */
  const optionHops: CallRoute[] | undefined = Array.isArray(rest.fallbackProviders)
    ? rest.fallbackProviders
        .filter((hop) => hop !== null && typeof hop === 'object' && typeof hop.provider === 'string')
        .map((hop) => ({ provider: hop.provider, model: hop.model, apiKey: hop.apiKey, baseUrl: hop.baseUrl }))
    : undefined;
  /**
   * The routes the options send a person's text on: each as the options name it, or, with `inEnvironment`, where it
   * goes in this process now.
   */
  const routesOf = (inEnvironment: boolean): RecipientRoutes => ({
    model: destinationOf({ provider: rest.provider, model: rest.model, apiKey: rest.apiKey, baseUrl: rest.baseUrl }, inEnvironment),
    router: rest.router !== undefined,
    fallbacks: optionHops?.map((hop) => destinationOf(hop, inEnvironment)),
    ...(compile === false ? {} : { compile: destinationOf(compileSendOf(target, false), inEnvironment) }),
    ...(minorsTarget !== undefined ? { compileMinors: destinationOf(compileSendOf(minorsTarget, true), inEnvironment) } : {}),
    ...(embeddingRoute ? { embedding: embeddingRoute } : {}),
  });
  /** The keys of what the options name: a route a call takes among them is not recorded. */
  const namedKeys = new Set(recipientsOf(routesOf(false)).map(recipientKey));
  /** The routes calls of this process took that the options do not name, by key: listed whether or not they are stored. */
  const calledRoutes = new Map<string, MemoryRecipient>();
  /** The keys of the routes stored, or being stored, by this process. */
  const storedRoutes = new Set<string>();
  /** The writes of routes still running: close() waits for them again after its compile, before the store closes. */
  const routeWrites = new Set<Promise<unknown>>();
  /**
   * Records a route a call takes that the options do not name. Each is stored once, as one `brain_meta` row of the
   * store that holds no person, no text and no time, so `recipients()` names it after a restart; close() waits for the
   * write. A write that fails leaves the route listed in this process, is tried again by the next call on the route,
   * and one `memory.recipient_unrecorded` line says so.
   */
  const noteRoute = (route: MemoryRecipient): void => {
    const routeKey = recipientKey(route);
    if (namedKeys.has(routeKey)) return;
    calledRoutes.set(routeKey, route);
    if (storedRoutes.has(routeKey)) return;
    storedRoutes.add(routeKey);
    const write = Promise.resolve()
      .then(() => recordRecipient(brainOf(memory), route))
      .catch((err: unknown) => {
        storedRoutes.delete(routeKey);
        memoryLog.warn('memory.recipient_unrecorded', errorFields(err));
      });
    routeWrites.add(write);
    void write.then(() => routeWrites.delete(write));
    awaitedOnClose(write);
  };
  /**
   * `router` with each pick recorded in `role` before the call is sent: the provider and model it picks, where the
   * credential layer sends them, the call's own key and base URL going with a pick of the call's own provider alone.
   * A pick that names no provider keeps the call's. Every other member reads through to `router`, called on it.
   */
  const recordingPicks = (router: IModelRouter, role: MemoryRecipient['role'], own: () => CallRoute): IModelRouter => ({
    get routerId() {
      return router.routerId;
    },
    get policyTier() {
      return router.policyTier;
    },
    initialize: (config, providerManager, promptEngine) => router.initialize(config, providerManager, promptEngine),
    selectModel: async (params, availableModels) => {
      const picked = await router.selectModel(params, availableModels);
      if (picked && typeof picked.modelId === 'string') {
        const call = own();
        const provider = picked.modelInfo?.providerId ?? call.provider;
        const ownProvider = provider === call.provider;
        const pick: CallRoute = { provider, model: picked.modelId, ...(call.strict ? { strict: true } : {}) };
        noteRoute(
          routeRecipient(role, destinationOf(ownProvider ? { ...pick, apiKey: call.apiKey, baseUrl: call.baseUrl } : pick, true)),
        );
      }
      return picked;
    },
  });

  const chunker = new SemanticChunker();
  const priorTools = rest.tools;
  const memoryDir = loaded.memoryDir;
  const { tools: augmentedTools, store: operatorPages, storeFor: pagesOf } = await closingOnThrow(() => attachMemoryWiki({
    memory,
    memoryDir,
    agentId,
    llm,
    chunk: (t) => chunker.chunk(t).map((c) => ({ text: c.text })),
    tools: Array.isArray(priorTools) ? [...priorTools] : undefined,
    // The page tool reads the key the observer writes, and serves a subject's own pages only under a policy that
    // keeps memory.
    subjectOf,
    ownPagesServed,
    // A subject whose compile the budget refuses, or whose latest answer stopped it, is skipped: its traces wait, and
    // the other subjects compile.
    compileSkipReasonOf: (error) =>
      isBudgetRefusal(error) ? 'budget' : error instanceof CompileStopped ? error.reason : undefined,
    ...(memoryPolicy || screen ? { beforeScopeCompile } : {}),
    // No compile at all: raw traces only, and no page is ever written.
    ...(compile === false ? { compile: false as const } : {}),
    // A forgotten subject reads no page and is compiled no page.
    isForgotten: (subject) => forgotten.isForgotten(subject),
    // The user older memory is attributed to reads the pages an earlier version compiled as their own.
    legacyOwnerKey: async () => legacyOwnerKey,
    // Each subject's compile runs on its chain, after its writes; close() compiles what is stored at its deadline.
    runScope: (scopeId, work) => (closing ? work() : onSubject(scopeId, work)),
  }));
  if (compile === false) memoryLog.warn('memory.compile_skipped', { reason: 'compile_off' });

  // attachMemoryWiki appends read_memory_page to an array. Use the augmented
  // array when tools were an array (or absent); pass map/registry inputs through
  // unchanged (the rare non-array AdaptableToolInput shapes).
  const tools = (
    priorTools && !Array.isArray(priorTools) ? priorTools : augmentedTools
  ) as AgentOptions['tools'];

  /** The agent's own route, as its options give it. */
  const agentRoute: CallRoute = { provider: rest.provider, model: rest.model, apiKey: rest.apiKey, baseUrl: rest.baseUrl };
  const agentOptions: AgentOptions = {
    ...rest,
    ...(budget ? { budget } : {}),
    // Each pick of the agent's model router is recorded where it sends the text, as a call's own route is. The GMI
    // runtime tells each attempt as its gateway resolved it (below), a router's pick and a call's own credentials
    // applied, so its router is left as given.
    ...(rest.router && rest.runtime !== 'gmi' ? { router: recordingPicks(rest.router, 'model', () => agentRoute) } : {}),
    memoryProvider: provider,
    tools,
  };
  /**
   * The embedding the GMI runtime's cognitive memory was built with, as its build told it; noted again at each call, so
   * a write of it that failed is tried again without resolving the default provider again.
   */
  let builtEmbedding: MemoryRecipient | undefined;
  if (rest.runtime === 'gmi') {
    // Where the GMI runtime sends text, as it sends it: each model attempt where its gateway resolved it, and the
    // embedding its cognitive memory was built with (a default provider changed after the agent opened included).
    shareRouteObserver(agentOptions, {
      attempt: ({ providerId, modelId, hop }) =>
        noteRoute(routeRecipient(hop === 0 ? 'model' : 'fallback-model', { provider: providerId, model: modelId })),
      embedding: (route) => {
        builtEmbedding = routeRecipient('embedding', route);
        noteRoute(builtEmbedding);
      },
    });
  }
  // A learning layer gmi() builds from these options writes and reads the store's ledger.
  shareForgottenLedger(agentOptions, forgotten);
  if (rest.runtime === 'gmi') {
    // The GMI runtime reads the soul's store by the same options object, cognitive memory on or off: each session
    // turn's view of the memory rules, whether the end user's id goes to the model provider, and the Brain its
    // cognitive memory files into, with the managers it builds there and the writes close() waits for.
    shareSoulStore(agentOptions, {
      agentId,
      sendUserIdToProvider: sendUserIdToProvider === true,
      forTurn: soulTurnOf,
      brain: soulBrain,
      mechanisms: soulMechanismsOf(rest as CognitionInputs),
      memoryBuilt: (manager) => {
        mindManagers.add(manager);
      },
      memoryClosed: (manager) => {
        mindManagers.delete(manager);
      },
      drainWrites: async () => {
        await waitForWrites(mindFilings, closeWaitLeft());
      },
    });
  }
  const built = (await closingOnThrow(() => agent(agentOptions))) as SouledAgent;

  /**
   * Records where a call sends a person's text when the options do not name it: its own `provider` or `model` (the
   * agent's for the one it leaves out), or the agent's own route where the credential layer sends it elsewhere; on the
   * default runtime its own model router; and each fallback hop it may take, its own on the default runtime, else the
   * options'. The route is recorded before the call starts. Returns the call's own route.
   */
  const noteCallRoute = (call: unknown): CallRoute => {
    const given = (call !== null && typeof call === 'object' ? call : {}) as {
      provider?: unknown;
      model?: unknown;
      apiKey?: unknown;
      baseUrl?: unknown;
      router?: unknown;
      fallbackProviders?: unknown;
    };
    const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
    const callProvider = text(given.provider);
    const callModel = text(given.model);
    // A call whose model's `provider:` prefix names another provider does not take the agent's.
    const routeProvider =
      callProvider ??
      (callModel !== undefined && rest.provider !== undefined && modelNamesAnotherProvider(rest.provider, callModel)
        ? undefined
        : rest.provider);
    const routeModel = callModel ?? rest.model;
    // The agent's key and base URL go with a call only to the provider they were set for.
    const agentCredentialsGo = credentialsGoWith(
      { provider: rest.provider, model: rest.model },
      { provider: routeProvider, model: routeModel },
    );
    const own: CallRoute = {
      provider: routeProvider,
      model: routeModel,
      apiKey: text(given.apiKey) ?? (agentCredentialsGo ? rest.apiKey : undefined),
      baseUrl: text(given.baseUrl) ?? (agentCredentialsGo ? rest.baseUrl : undefined),
    };
    noteRoute(routeRecipient('model', destinationOf(own, true)));
    // The GMI runtime refuses a call's own router and fallbackProviders before any model call.
    const ownLegs = rest.runtime !== 'gmi';
    if (ownLegs && given.router !== undefined && given.router !== null) {
      noteRoute(routeRecipient('model', { provider: PROVIDER_FROM_THE_ROUTER }));
    }
    const hops: CallRoute[] | undefined =
      ownLegs && Array.isArray(given.fallbackProviders)
        ? (given.fallbackProviders as unknown[]).flatMap((hop): CallRoute[] => {
            const entry = (hop !== null && typeof hop === 'object' ? hop : {}) as Record<string, unknown>;
            const provider = text(entry.provider);
            return provider === undefined
              ? []
              : [{ provider, model: text(entry.model), apiKey: text(entry.apiKey), baseUrl: text(entry.baseUrl) }];
          })
        : optionHops;
    for (const hop of hops ?? []) noteRoute(routeRecipient('fallback-model', destinationOf(hop, true)));
    if (builtEmbedding) noteRoute(builtEmbedding);
    return own;
  };
  /**
   * A call's options with its own model router recording each pick it makes, on the default runtime; unchanged
   * otherwise, and on the GMI runtime, which refuses a call's own router.
   */
  const withRecordedRouter = <E>(extra: E, own: CallRoute): E => {
    if (rest.runtime === 'gmi') return extra;
    const given = extra !== null && typeof extra === 'object' ? (extra as Record<string, unknown>) : undefined;
    // The router the call runs with: its own (`router: undefined` turns the agent's off), else the agent's.
    const router = given && 'router' in given ? given.router : rest.router;
    if (router === null || typeof router !== 'object' || typeof (router as IModelRouter).selectModel !== 'function') {
      return extra;
    }
    return { ...(given ?? {}), router: recordingPicks(router as IModelRouter, 'model', () => own) } as unknown as E;
  };
  /**
   * Who receives a person's text: where the options' routes go in this process now, then every route a call took
   * that the options do not name, stored or of this process.
   */
  const listRecipients = async (): Promise<MemoryRecipient[]> =>
    recipientsOf(routesOf(true), [...(await recordedRecipients(brainOf(memory))), ...calledRoutes.values()]);

  // Every turn joins what close() waits for: its promise, or a stream's settled usage. The default runtime's own close
  // does not wait for a running turn, and the GMI runtime's does not wait for a one-shot call. A call's own route is
  // recorded before it starts.
  const generateTurn = built.generate.bind(built);
  built.generate = (prompt, extra) => {
    const own = noteCallRoute(extra);
    return awaitedOnClose(generateTurn(prompt, withRecordedRouter(extra, own)));
  };
  const streamTurn = built.stream.bind(built);
  built.stream = (prompt, extra) => {
    const own = noteCallRoute(extra);
    return awaitStreamOnClose(streamTurn(prompt, withRecordedRouter(extra, own)), extra?.abortSignal);
  };
  const openSession = built.session.bind(built);
  const trackedSessions = new WeakSet<AgentSession>();
  /** The sessions this handle gave out and has not closed, by the key of the subject each one's memory is kept under. */
  const sessionsBySubject = new Map<string, Set<AgentSession>>();
  /**
   * The key a session's memory is kept under: its user's when it named one, else the session's own; undefined for an
   * id no key can be built from, whose turns file nothing.
   */
  const sessionKeyOf = (sessionId: string, userId: unknown): string | undefined => {
    const subject: MemorySubject =
      typeof userId === 'string' && !isAnonymousUserId(userId, anonymousUserIds)
        ? { kind: 'user', id: userId }
        : { kind: 'session', id: sessionId };
    try {
      return conversationScopeKey(agentId, subjectOf(subject));
    } catch {
      return undefined;
    }
  };
  /** The key an open session this handle gave out is kept under, by the session's id; undefined when none is open. */
  const openSessionKeyOf = (sessionId: string | undefined): string | undefined => {
    if (sessionId === undefined) return undefined;
    for (const [key, held] of sessionsBySubject) {
      for (const session of held) if (session.id === sessionId) return key;
    }
    return undefined;
  };
  built.session = (id, sessionOptions) => {
    // The runtime hands an open session asked for by its id alone back as the user it runs as: so is its subject.
    const userId: unknown = sessionOptions?.userId;
    const namesUser = typeof userId === 'string' && !isAnonymousUserId(userId, anonymousUserIds);
    const reopened = namesUser ? undefined : openSessionKeyOf(id);
    if (sharedUser !== undefined) {
      // One person's memory: a session runs as that user, by name or by naming nobody.
      const asked: unknown = sessionOptions?.userId;
      if (typeof asked === 'string' && asked !== sharedUser && !isAnonymousUserId(asked, anonymousUserIds)) {
        throw new Error('souledAgent: sharedMemory runs every session as one user; this session named another');
      }
    }
    // A second subject needs a retention choice, and a tombstone key unless the ledger already holds unkeyed
    // tombstones. A session opened with no id is a new session, and so a new subject, unless it names a user or runs
    // as the one user of sharedMemory.
    const asked = reopened ?? sessionKeyOf(id ?? '', sessionOptions?.userId);
    const count = asked !== undefined && subjects.has(asked) ? subjects.size : subjects.size + 1;
    if (retention === undefined && count > 1) throw new Error(RETENTION_REQUIRED);
    assertSubjectAllowed(count);
    const session = openSession(id, sessionOptions);
    const subjectKey = reopened ?? sessionKeyOf(session.id, sessionOptions?.userId);
    if (subjectKey !== undefined) {
      subjects.add(subjectKey);
      const ofSubject = sessionsBySubject.get(subjectKey) ?? new Set<AgentSession>();
      ofSubject.add(session);
      sessionsBySubject.set(subjectKey, ofSubject);
    }
    // A runtime that hands the same session object back is wrapped once.
    if (!trackedSessions.has(session)) {
      trackedSessions.add(session);
      const send = session.send.bind(session) as (...args: unknown[]) => Promise<unknown>;
      session.send = ((...args: unknown[]) => {
        noteCallRoute(args[1]);
        return awaitedOnClose(send(...args));
      }) as AgentSession['send'];
      // A closed session keeps nothing of its account's policy: its next opening asks again.
      const closeSession = (session as { close?: (...args: unknown[]) => Promise<unknown> }).close?.bind(session);
      if (closeSession) {
        (session as { close: (...args: unknown[]) => Promise<unknown> }).close = (...args: unknown[]) => {
          sessionPolicies.delete(session.id);
          // Its next opening loads its person's rows into the mind again, with any another process filed meanwhile.
          mindLoads.delete(session.id);
          offSaid.delete(session.id);
          sessionCloses.set(session.id, (sessionCloses.get(session.id) ?? 0) + 1);
          for (const [key, held] of sessionsBySubject) {
            held.delete(session);
            if (held.size === 0) sessionsBySubject.delete(key);
          }
          return closeSession(...args);
        };
      }
      const streamSession = session.stream.bind(session);
      session.stream = (input, streamOpts) => {
        noteCallRoute(streamOpts);
        return awaitStreamOnClose(streamSession(input, streamOpts), streamOpts?.abortSignal);
      };
    }
    // Once the session is registered and wrapped: a logger that opens a session of its own finds this one in place.
    noteUnkeyed(count);
    return session;
  };

  /** Waits for a subject's pending writes and compiles, up to the deadline close() waits by. */
  const drainSubject = async (key: string): Promise<{ drained: number; pendingAtDeadline: number }> => {
    const held = pendingBySubject.get(key);
    if (!held || held.size === 0) return { drained: 0, pendingAtDeadline: 0 };
    const before = held.size;
    const left = await waitForWrites(held, waitMs);
    return { drained: Math.max(before - left, 0), pendingAtDeadline: left };
  };
  /**
   * Whether the store holds memory from before per-user scope that nobody attributed: traces under the agent's plain
   * id, in either form it was written in, or page files under memory/ that are not the operator's, while no user owns
   * them; and, whoever owns the rest, a page file whose front matter cannot be read, which is never attributed.
   */
  const legacyUnattributed = async (): Promise<boolean> => {
    const withheld = await operatorPages.withheldPages();
    if (withheld.some((page) => page.origin === 'uncertain')) return true;
    if ((await memory.legacyOwner(agentId)) !== undefined) return false;
    // A soft-deleted trace still holds its words until a delete for good.
    for (const form of legacyForms) if ((await memory.countScope(LEGACY_SCOPE, form, { includeDeleted: true })) > 0) return true;
    return withheld.length > 0;
  };
  /** The older pages under memory/: those an earlier version compiled (`parsed`), and those that cannot be read. */
  const legacyPageEntries = async (): Promise<Array<{ id: string; parsed: boolean }>> =>
    (await operatorPages.withheldPages()).map((page) => ({ id: page.id, parsed: page.origin === 'compiled' }));
  /** The pages an earlier version compiled under memory/, read whole. */
  const legacyCompiledPages = async (): Promise<WikiPage[]> => {
    const pages: WikiPage[] = [];
    for (const entry of await legacyPageEntries()) {
      if (!entry.parsed) continue;
      const page = await operatorPages.readPage(entry.id);
      if (page) pages.push(page);
    }
    return pages;
  };
  /** What a deletion of the owner of the older memory also deletes; any other subject's deletion leaves it. */
  const legacyDeletionOf = async (): Promise<NonNullable<ForgetUserMemoryOptions['legacy']>> => ({
    ownerKey: await memory.legacyOwner(agentId),
    forms: legacyForms,
    pages: { list: legacyPageEntries, deletePage: (id) => operatorPages.deletePage(id) },
    clearOwner: async () => {
      await memory.clearLegacyOwner(agentId);
      legacyOwnerKey = undefined;
    },
  });
  /**
   * The mind side of the agent on the GMI runtime, cognitive memory on or off: a deletion empties the open sessions
   * of its subject through it. It waits for a session's running turn as long as close() waits for its turns and
   * writes.
   */
  const soulMind = rest.runtime === 'gmi' ? createSoulMind({ managers: () => mindManagers, deadlineMs: waitMs }) : undefined;
  /**
   * What a deletion of one subject does to the sessions this handle holds open for the subject, as an entry of the
   * report's stores and as the deletion's `sessions` part. The default runtime keeps a session's history in this
   * process: each is cleared and counted. On the GMI runtime each is emptied (its messages, and its GMI's history,
   * reasoning trace, sentiment trend, working-memory slots and metaprompt imprints) and counted; a session whose turn
   * is still running at the deadline is emptied once that turn ends, and the part is missed meanwhile. A session
   * opened with history off holds nothing between its turns and is not counted. It never rejects: an emptying that
   * fails is the part missed, with the error's message.
   */
  const sessionHistoryOf = async (key: string): Promise<{ entry: ForgetMemoryReport['stores'][number]; part: PartOutcome }> => {
    const open = sessionsBySubject.get(key) ?? new Set<AgentSession>();
    const store = 'session history in this process';
    const both = (part: PartOutcome) => ({ entry: { store, ...part }, part });
    if (soulMind) {
      try {
        const { evicted, running } = await soulMind.evictSessions([...open]);
        if (running === 0) return both({ reached: true, deleted: evicted });
        return both({
          reached: false,
          reason:
            running === 1
              ? '1 open session was still running a turn at the deadline'
              : `${running} open sessions were still running a turn at the deadline`,
        });
      } catch (err) {
        return both({ reached: false, reason: messageOf(err) });
      }
    }
    let cleared = 0;
    for (const session of open) {
      session.clear();
      cleared += 1;
    }
    return both({ reached: true, deleted: cleared });
  };
  /**
   * The parts of one subject's deletion that are this agent's: the wait for the subject's pending writes, its chain,
   * what the agent reached beside the store and the open sessions.
   */
  const deletionPartsOf = (
    subject: SuppressionSubject,
    extra: ReportExtras,
  ): Pick<ForgetUserMemoryOptions, 'drain' | 'onChain' | 'extraStores' | 'alsoIncomplete' | 'sessions'> => {
    const key = conversationScopeKey(agentId, subject);
    // The sessions are dealt with once, when the deletion first asks: after the tombstone is written and the deletes
    // are done, so a deletion that cannot write its tombstone leaves them as they are. The `sessions` part and the
    // entry among the stores tell of that one pass.
    let history: ReturnType<typeof sessionHistoryOf> | undefined;
    const historyOf = () => (history ??= sessionHistoryOf(key));
    return {
      drain: () => drainSubject(key),
      onChain: (work) => onSubject(key, work),
      sessions: async () => (await historyOf()).part,
      extraStores: async () => [...extra.stores, (await historyOf()).entry],
      alsoIncomplete: extra.incomplete,
    };
  };
  /**
   * Who receives a person's text, for a deletion's report: what `recipients()` lists. A deletion never fails on the
   * list: when the routes the store recorded cannot be read, the report lists the routes the options name and those
   * this process's calls took, names the recorded ones among its stores as not reached, and one
   * `memory.recipients_unread` line is logged.
   */
  const recipientsForReport = async (): Promise<{ recipients: MemoryRecipient[]; stores: ForgetMemoryReport['stores'] }> => {
    try {
      return { recipients: await listRecipients(), stores: [] };
    } catch (err) {
      memoryLog.warn('memory.recipients_unread', errorFields(err));
      return {
        recipients: recipientsOf(routesOf(true), [...calledRoutes.values()]),
        stores: [{ store: 'recipients recorded in the store', reached: false, reason: messageOf(err) }],
      };
    }
  };
  /**
   * Puts who receives a person's text into deletion reports, read once for all of them after their deletions ran: each
   * waited for its subject's writes and compiles, so a route one of those took meanwhile is listed.
   */
  const withRecipients = async (reports: readonly ForgetMemoryReport[]): Promise<void> => {
    if (reports.length === 0) return;
    const listed = await recipientsForReport();
    for (const report of reports) {
      report.recipients = [...listed.recipients];
      report.stores.push(...listed.stores.map((entry) => ({ ...entry })));
    }
  };
  /** Deletes one subject's memory on its own chain, after its pending writes. */
  const forgetSubject = async (subject: SuppressionSubject, extra: ReportExtras): Promise<ForgetMemoryReport> =>
    forgetUserMemory({
      memory,
      ledger: forgotten,
      wiki: { storeFor: pagesOf },
      subject,
      agentId,
      ...deletionPartsOf(subject, extra),
      legacy: await legacyDeletionOf(),
      legacyUnattributed,
    });
  /**
   * The learning layer's own `forgetUser`, kept before `agent.learning.forgetUser` is replaced below by a call that
   * runs the agent's whole deletion: the deletion calls this one, never the replacement.
   */
  const layerForget = built.learning?.forgetUser?.bind(built.learning);
  /** The learning layer's own entry behind each entry of a deletion report made from it, which sums its counts. */
  const layerEntryOf = new WeakMap<object, ForgetReport['stores'][number]>();
  /**
   * What the agent's learning layer deleted of a user, as entries of a deletion report, beside the layer's own
   * report; with no layer, one entry saying so.
   */
  const forgetLearner = async (
    userId: string,
  ): Promise<{ stores: ForgetMemoryReport['stores']; incomplete: boolean; learned?: ForgetReport }> => {
    if (!layerForget) {
      return {
        stores: [{ store: 'learning store', reached: false, reason: 'this agent runs no learning layer' }],
        incomplete: false,
      };
    }
    const learned = await layerForget(userId);
    const stores = learned.stores.map((given): ForgetMemoryReport['stores'][number] => {
      // The layer says a session keeps its messages; the sessions this handle holds open are emptied by the deletion's
      // sessions part, so what is left out is a session held elsewhere.
      const entry =
        !given.reached && given.store === CONVERSATION_HISTORY ? { ...given, reason: HISTORY_HELD_ELSEWHERE } : given;
      const made: ForgetMemoryReport['stores'][number] = entry.reached
        ? {
            store: entry.store,
            reached: true,
            deleted: typeof entry.deleted === 'number' ? entry.deleted : Object.values(entry.deleted).reduce((sum, n) => sum + n, 0),
          }
        : { store: entry.store, reached: false, reason: entry.reason };
      layerEntryOf.set(made, entry);
      return made;
    });
    return { stores, incomplete: learned.stores.some((entry) => entry.store === 'learning store' && !entry.reached), learned };
  };
  /**
   * One person's deletion with each linked session's, as one report, and the learning layer's own report of the same
   * run when the agent runs a layer.
   */
  const deleteUser = (
    userId: string,
    options: { linkedSessions?: readonly string[] } | undefined,
  ): Promise<{ report: ForgetMemoryReport; learned?: ForgetReport }> => {
    const linked: unknown = options?.linkedSessions ?? [];
    // A closed store takes no delete: refused before the learning layer's part, so nothing is half deleted.
    if (storeClosed) {
      return Promise.reject(new Error('souledAgent: the agent was closed; open it again to delete a person from its store'));
    }
    if (typeof userId !== 'string' || userId === '') {
      return Promise.reject(new TypeError('souledAgent: forgetUser needs a non-empty user id'));
    }
    if (!Array.isArray(linked) || linked.some((id) => typeof id !== 'string' || id === '')) {
      return Promise.reject(new TypeError('souledAgent: forgetUser needs each linked session as a non-empty id'));
    }
    const sessions = [...new Set(linked as string[])];
    // An id no memory key can be built from (a NUL, a lone surrogate) is refused before the learning layer or the
    // store is reached: a deletion that stopped at its key would have deleted the learner's rows alone.
    try {
      conversationScopeKey(agentId, { kind: 'user', id: userId });
      for (const id of sessions) conversationScopeKey(agentId, { kind: 'session', id });
    } catch {
      return Promise.reject(
        new TypeError('souledAgent: forgetUser needs a user id and linked session ids with no NUL and no lone surrogate'),
      );
    }
    const run = async (): Promise<{ report: ForgetMemoryReport; learned?: ForgetReport }> => {
      const { learned, ...ofLearner } = await forgetLearner(userId);
      const ofUser = await forgetSubject({ kind: 'user', id: userId }, ofLearner);
      // A subject the store holds nothing more of no longer counts toward the retention requirement.
      const forgottenSubjects: SuppressionSubject[] = [{ kind: 'user', id: userId }, ...sessions.map((id) => ({ kind: 'session' as const, id }))];
      const report: ForgetMemoryReport = {
        ...ofUser,
        stores: [...ofUser.stores],
        pages: { ...ofUser.pages, failed: [...ofUser.pages.failed] },
        parts: [...ofUser.parts],
      };
      for (const sessionId of sessions) {
        const ofSession = await forgetSubject({ kind: 'session', id: sessionId }, { stores: [], incomplete: false });
        report.stores.push(...ofSession.stores.map((entry) => ({ ...entry, store: `${entry.store} (linked session)` })));
        report.pages.deleted += ofSession.pages.deleted;
        report.pages.failed.push(...ofSession.pages.failed);
        report.drained += ofSession.drained;
        report.pendingAtDeadline += ofSession.pendingAtDeadline;
        report.complete = report.complete && ofSession.complete;
        // A linked session's counts add into the same four parts; a part either of them missed is not reached.
        report.parts = report.parts.map((part, at) => addPart(part, ofSession.parts[at]));
        // The deletion ends when its last subject's does.
        report.completedAt = ofSession.completedAt;
      }
      if (storeHoldsNoMore(report)) for (const subject of forgottenSubjects) subjects.delete(conversationScopeKey(agentId, subject));
      // Read once for the person and the linked sessions, the list being the agent's: after the waits above.
      await withRecipients([report]);
      return learned ? { report, learned } : { report };
    };
    // close() waits for a deletion that is running, as it waits for a write.
    return awaitedOnClose(run());
  };
  built.forgetUser = (userId, options) => deleteUser(userId, options).then(({ report }) => report);
  // With a learning layer, agent.learning.forgetUser runs the same deletion and resolves to its report with the three
  // fields the layer's report type requires, taken from the layer's own report of that run, and the layer's own entries
  // with their counts table by table. agent.forgetUser's report stays free of the id.
  if (built.learning && layerForget) {
    built.learning.forgetUser = (userId) =>
      deleteUser(userId, undefined).then(({ report, learned }) => ({
        ...report,
        stores: report.stores.map((entry) => layerEntryOf.get(entry) ?? entry),
        userId: learned?.userId ?? userId,
        namespace: learned?.namespace ?? '',
        plainFormLeft: learned?.plainFormLeft ?? 0,
      }));
  }
  /**
   * Brings the ledger up to date from its copy and deletes again whatever the store holds of a forgotten subject. A
   * forgotten user's learner rows are deleted again by the learning layer first, when the agent runs one.
   */
  const applyTombstones = async (): Promise<ForgetMemoryReport[]> => {
    /** The subjects deleted again, in the order of their reports. */
    const reapplied: SuppressionSubject[] = [];
    const reports = await reapplyTombstones({
      memory,
      ledger: forgotten,
      wiki: { storeFor: pagesOf },
      agentId,
      legacyUnattributed,
      forSubject: async (subject) => {
        reapplied.push(subject);
        const ofLearner = subject.kind === 'user' ? await forgetLearner(subject.id) : { stores: [], incomplete: false };
        return {
          ...deletionPartsOf(subject, ofLearner),
          legacy: await legacyDeletionOf(),
        };
      },
      // A trace a correction deleted, and a correction filed again, are handled in the person's turn, after the
      // writes and compiles of theirs that are running; once close() is waiting for those, at once.
      onKey: (key, work) => (closing ? work() : onSubject(key, work)),
      retentionDaysOf: (key, kind) => (retention === undefined ? undefined : retentionDaysOf(retention, kind, policyDays.get(key))),
      // A trace deleted again is counted as a correction's own deletion is: a running turn of the person that recalled
      // it does not file a reply restating it.
      changing: (key) => {
        correctionCounts.set(key, (correctionCounts.get(key) ?? 0) + 1);
      },
    });
    // A subject the store holds nothing more of no longer counts toward the retention requirement.
    reports.forEach((report, at) => {
      const subject = reapplied[at];
      if (storeHoldsNoMore(report) && subject) subjects.delete(conversationScopeKey(agentId, subject));
    });
    // Read once for every subject deleted again, after all of them: most re-applications delete nobody.
    await withRecipients(reports);
    // Read once the ledger is up to date from its copy: at the open, and again while it held none. Only a tombstone
    // found turns the flag on: a read that began before a deletion wrote can answer after it, with none.
    if (!forgotten.keyed && !ledgerHoldsTombstones && (await forgotten.size()) > 0) ledgerHoldsTombstones = true;
    return reports;
  };
  built.applyTombstones = () => awaitedOnClose(applyTombstones());
  /** Deletes what the agent's retention no longer keeps, each subject on its own chain. */
  const sweep = async (): Promise<{ traces: number; pages: number; scopes: number }> => {
    if (retention === undefined) return { traces: 0, pages: 0, scopes: 0 };
    return sweepRetention({
      memory,
      wiki: { storeFor: pagesOf },
      retention,
      daysFor: (scopeId) => policyDays.get(scopeId),
      onChain: (scopeId, work) => (closing ? work() : onSubject(scopeId, work)),
    });
  };
  built.sweepRetention = () => awaitedOnClose(sweep());
  built.recipients = () => awaitedOnClose(listRecipients());
  /** Whether the agent scores a person's messages for sentiment at all: on the GMI runtime, with sentiment on. */
  const scoresSentiment = (() => {
    if (rest.runtime !== 'gmi') return false;
    try {
      return resolveCognition(rest as CognitionInputs).sentiment;
    } catch {
      return false;
    }
  })();
  /**
   * Whether a subject's messages are scored for sentiment, as the host's latest answer for the subject in this process
   * leaves the agent's switch: a subject not asked about yet is scored when the switch is on.
   */
  const sentimentOf = (scopeId: string): 'on' | 'off' => {
    if (!scoresSentiment) return 'off';
    const latest = latestAnswers.get(scopeId);
    return latest === undefined || soulAnswerOf(latest).sentiment ? 'on' : 'off';
  };
  built.exportUserMemory = (userId) => {
    if (typeof userId !== 'string' || userId === '') {
      return Promise.reject(new TypeError('souledAgent: exportUserMemory needs a non-empty user id'));
    }
    const subject: SuppressionSubject = { kind: 'user', id: userId };
    let key: string;
    try {
      key = conversationScopeKey(agentId, subject);
    } catch (err) {
      return Promise.reject(err);
    }
    const run = async (): Promise<UserMemoryExport> => {
      // The owner of the older memory gets it in their export too.
      const owns = legacyOwnerKey !== undefined && key === legacyOwnerKey;
      const days = policyDays.get(key);
      const exportLearned = built.learning?.exportLearnedState;
      return exportSubjectMemory({
        memory,
        wiki: { storeFor: pagesOf },
        agentId,
        subject,
        ...(owns ? { legacy: { forms: legacyForms, pages: legacyCompiledPages } } : {}),
        recipients: listRecipients,
        retention: { period: retention?.traces ?? 'none', ...(days !== undefined ? { policyDays: days } : {}) },
        profilingOf: sentimentOf,
        ...(exportLearned ? { learner: () => exportLearned.call(built.learning, userId) } : {}),
      });
    };
    // The read runs on the person's chain, after the writes their turns started and their compiles: a turn whose
    // send() resolved before the call is in the export. Once close() is waiting for those writes it reads at once.
    return awaitedOnClose(closing ? run() : onSubject(key, run));
  };
  const correctUser = (
    userId: string,
    correction: { traceIds: readonly string[]; text?: string },
  ): Promise<{ deleted: number; pagesDeleted: number; correctionTraceId?: string; recipients: MemoryRecipient[] }> => {
    if (typeof userId !== 'string' || userId === '') {
      return Promise.reject(new TypeError('souledAgent: correctUserMemory needs a non-empty user id'));
    }
    const subject: SuppressionSubject = { kind: 'user', id: userId };
    const countChange = () => {
      const key = conversationScopeKey(agentId, subject);
      correctionCounts.set(key, (correctionCounts.get(key) ?? 0) + 1);
    };
    let changing = false;
    // The change runs on the person's chain, after their writes and compiles; close() waits for it.
    return awaitedOnClose(
      correctSubjectMemory({
        memory,
        wiki: { storeFor: pagesOf },
        agentId,
        subject,
        correction,
        // As a deletion's report lists them: the call never fails on the list.
        recipients: async () => (await recipientsForReport()).recipients,
        // Counted on the person's chain once the named traces are known to be theirs, and again when the change has
        // settled, before the chain runs the person's next write: a reply of theirs written after this, from a turn
        // that began before the change or while it ran, is not filed.
        beforeChange: () => {
          changing = true;
          countChange();
        },
        onChain: (work) =>
          onSubject(conversationScopeKey(agentId, subject), () =>
            work().finally(() => {
              if (changing) countChange();
            }),
          ),
      }),
    );
  };
  // The one implementation answers each signature of the call: its result holds `correctionTraceId` exactly when the
  // call passed `text`.
  built.correctUserMemory = correctUser as NonNullable<SouledAgent['correctUserMemory']>;

  // On teardown: close the agent (with runtime: 'gmi' that stops its running session turns and shuts its sessions
  // down); wait, within one deadline, for the turns still running and then for the memory writes of its turns; fold
  // the conversation into the wiki; then close the backing store. The compile is best-effort (a failed LLM merge must
  // never block teardown) and a failure is logged; closing prevents leaked SQLite handles in long-lived hosts. An
  // error from the agent's own close is thrown once the store is closed.
  const originalClose = built.close.bind(built);
  built.close = async () => {
    let closeFailed = false;
    let closeError: unknown;
    // One deadline for the close, counted from here: the agent's own close waits within it for the mind's writes.
    closeStartedAt ??= Date.now();
    try {
      await originalClose();
    } catch (err) {
      closeFailed = true;
      closeError = err;
    }
    try {
      const stillPending = await waitForWrites(pending, closeWaitLeft());
      if (stillPending > 0) {
        console.warn(
          `[agentos] souledAgent: close() waited ${waitMs} ms for its turns still running and the memory writes of ` +
            `its turns; still pending: ${stillPending}. The wiki compile takes what is stored, and a write that ` +
            'reaches the store once it is closed is not stored.',
        );
      }
      closing = true;
      if (retention !== undefined) {
        try {
          // Expired memory goes before the compile, so no page is built from it.
          await sweep();
        } catch {
          // A failed sweep never blocks the close. No error text: it may hold what a store said.
          console.warn(
            '[agentos] souledAgent: the retention sweep on close failed; expired memory stays in the store until the next sweep.',
          );
        }
      }
      try {
        // The subjects this agent's turns wrote to; a trace stored another way waits for memory.compileWiki(). With
        // `compile: false` no wiki is attached, and this compiles nothing.
        await memory.compileWiki({ reason: 'session-end', scopes: [...written] });
      } catch (err) {
        // A subject's watermark moves only past compiled traces, so the next compile takes these up again.
        // The reason goes in as text alone: the console's inspection of an error can throw, and close must go on.
        console.warn(
          `[agentos] souledAgent: the memory wiki compile on close failed (${messageOf(err)}); ` +
            'the conversation traces stay in the store for the next compile.',
        );
      }
    } finally {
      // A compile above can record a route it took: its write lands before the store closes.
      await waitForWrites(routeWrites, waitMs);
      await closeStore();
    }
    if (closeFailed) throw closeError;
  };

  // Expose the store so callers can fold conversation into the wiki mid-session
  // (`await agent.memory.compileWiki()`) without waiting for close().
  built.memory = memory;

  // Every open applies the tombstones again, before the agent serves a turn: a store put back from a backup taken
  // before a deletion, and a deletion that did not finish, hold nothing of a forgotten subject once this returns. A
  // ledger whose copy cannot be read fails the open, and no memory is served.
  try {
    await applyTombstones();
    // The checks of who the store holds read it once the tombstones are applied: a forgotten subject a restore put
    // back is deleted again first, and counts for neither.
    if (sharedUser !== undefined) {
      // One person's memory: a store that holds another user's, or a session's, is not opened as theirs.
      const others = (await memory.listScopes()).filter((row) => {
        if (row.kind === 'operator') return false;
        const subject = parseConversationScopeKey(row.scopeId)?.subject;
        return !(subject?.kind === 'user' && subject.id === sharedUser);
      });
      if (others.length > 0) {
        throw new Error(
          "souledAgent: sharedMemory runs one person's memory, and this store already holds memory of another user or session",
        );
      }
    }
    for (const row of await memory.listScopes()) {
      if (row.kind !== 'user' && row.kind !== 'session') continue;
      const key = ownKeyOf(row.scopeId);
      if (key !== undefined) subjects.add(key);
    }
    if (retention === undefined && subjects.size > 1) throw new Error(RETENTION_REQUIRED);
    assertSubjectAllowed(subjects.size);
    // On a single person's own machine the older memory is attributed to its one user, once the tombstones are
    // applied: a forgotten user, an attribution to another user, and a store that records anyone else refuse the open.
    if (legacyMemory !== undefined) {
      await attributeLegacyMemory({
        memory,
        ledger: forgotten,
        agentId,
        attributeTo: legacyMemory.attributeTo,
        reason: legacyMemory.reason,
        legacyPages: legacyPageEntries,
        isAnonymous: (id) => isAnonymousUserId(id, anonymousUserIds),
      });
    }
    legacyOwnerKey = await memory.legacyOwner(agentId);
    // An attributed owner already has memory even if no turn has registered their conversation scope yet.
    if (legacyOwnerKey !== undefined) subjects.add(legacyOwnerKey);
    if (retention === undefined && subjects.size > 1) throw new Error(RETENTION_REQUIRED);
    assertSubjectAllowed(subjects.size);
    noteUnkeyed(subjects.size);
  } catch (err) {
    await originalClose().catch(() => undefined);
    await closeStore().catch(() => undefined);
    throw err;
  }

  return built;
}
