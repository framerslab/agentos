/**
 * @file ledger.test.ts
 * The ledger over the in-process store and SQLite: a candidate and its verdict chain under the learner's key and
 * verify; a change and its rows are one transaction; an append whose compare-and-swap loses retries onto the head, and
 * answers `conflict` once it has lost four times; a forgotten user's chain takes nothing; an append that finds the
 * tombstone after it committed runs the user's deletion again, and an error in that second read or deletion never
 * turns a committed append into a failed one; a freeze, the host's or the process's, refuses a new candidate and lets
 * an operator act; a verdict follows only a candidate it can decide, and a revert's verdict only a kept candidate of
 * its own chain; rows with no learner chain per agent and per visitor. On SQLite, edits made outside the layer: a
 * row's text, an indexed column, a row moved to another chain, the newest row deleted, a row whose text is no ledger
 * entry, and a chain recomputed without the key; and an operator's reanchor, from which a broken chain verifies again.
 * (The cases of two adapters appending to one chain on Postgres run in learning-store.sql.test.ts.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { InMemoryLearningStore } from '../../store/InMemoryLearningStore.js';
import { SqlLearningStore } from '../../store/SqlLearningStore.js';
import type { LearningStore, LearningStoreTx } from '../../store/LearningStore.js';
import { chainKeyOf, Ledger, tombstoneHash, type ProposeOptions, type ProposeResult } from '../Ledger.js';
import { canonicalJson, sha256Hex } from '../canonical.js';
import { ulid } from '../ids.js';

const LEARNER = { namespace: 'A', agentKey: 'tutor', userId: '42' };
const candidate = (subject = 'traits') => ({
  learner: LEARNER,
  kind: 'operator_set' as const,
  actor: 'operator:ops',
  subject,
  before: { openness: 0.5 },
  after: { openness: 0.6 },
  evidence: { note: 'test' },
  sessionId: 's-1',
});
const idOf = (result: ProposeResult): string => ('candidate' in result ? result.candidate.id : '');

/** The SQLite adapters a case opened; each is closed once the case has run. */
const adapters: StorageAdapter[] = [];
const openSqlite = async (): Promise<StorageAdapter> => {
  const adapter = await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });
  adapters.push(adapter);
  return adapter;
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const adapter of adapters.splice(0)) await adapter.close();
});

describe('ids and canonical JSON', () => {
  it('gives ULIDs that sort by time and stay ordered within one millisecond', () => {
    const ids = [ulid(1_000), ulid(1_000), ulid(1_001), ulid(999)];
    expect(ids.every((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
  });

  it('sorts keys at every depth and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"e":2,"f":1}]},"b":1}');
  });

  it('writes a value with toJSON as what toJSON returns, its keys sorted too', () => {
    const value = { at: new Date(0), amount: { toJSON: () => ({ z: 1, a: [undefined, 2] }) } };
    expect(canonicalJson(value)).toBe('{"amount":{"a":[null,2],"z":1},"at":"1970-01-01T00:00:00.000Z"}');
  });
});

describe.each([
  ['in-process', async (): Promise<LearningStore> => new InMemoryLearningStore()],
  ['SQLite', async (): Promise<LearningStore> => new SqlLearningStore({ adapter: await openSqlite() })],
])('the ledger over the %s store', (_name, open) => {
  it("chains a candidate and its verdict under the learner's key, and the chain verifies", async () => {
    const store = await open();
    const ledger = new Ledger({ store, versions: { rules: 'rules-1' } });
    const proposed = await ledger.propose({ ...candidate(), versions: { model: 'model-1' } });
    expect(proposed.status).toBe('pending');
    const candidateId = idOf(proposed);
    expect((await ledger.decide(candidateId, 'kept', 'no rendered change')).status).toBe('kept');

    const key = chainKeyOf(LEARNER);
    expect(key).toBe('u|A|tutor|42');
    const rows = await store.chainRows(key);
    expect(rows.map((r) => [r.seq, r.rowType, r.verdict])).toEqual([[1, 'candidate', 'pending'], [2, 'verdict', 'kept']]);
    expect(rows[0]!.prevHash).toBe('0'.repeat(64));
    expect(rows[1]!.prevHash).toBe(rows[0]!.hash);
    expect(rows[0]!.hash).toBe(await sha256Hex(rows[0]!.body));
    expect(JSON.parse(rows[1]!.body).versions).toEqual({
      agentos: expect.stringMatching(/^\d+\.\d+\.\d+/),
      rules: 'rules-1',
      renderer: 1,
      probes: 'none',
      model: 'model-1',
    });
    expect(await ledger.latestVerdict(candidateId)).toBe('kept');
    expect(await ledger.latestVerdict('01J00000000000000000000000')).toBeUndefined();
    expect(await ledger.verifyChain(key)).toEqual({ ok: true, keyed: false });
  });

  it('writes nothing when the change in its transaction throws', async () => {
    const store = await open();
    const ledger = new Ledger({ store });
    await expect(
      ledger.propose(candidate(), {
        verdict: 'kept',
        change: async () => {
          throw new Error('the trait row could not be written');
        },
      }),
    ).rejects.toThrow('the trait row could not be written');
    expect(await store.chainRows(chainKeyOf(LEARNER))).toEqual([]);
    expect(await store.head(chainKeyOf(LEARNER))).toBeUndefined();
  });

  it('retries onto the head when its compare-and-swap loses, and leaves one linear chain', async () => {
    const store = await open();
    const ledger = new Ledger({ store });
    await ledger.propose(candidate('one'), { verdict: 'kept' });
    let stale = true;
    const racing = Object.assign(Object.create(store) as LearningStore, {
      transaction: <T>(fn: (tx: LearningStoreTx) => Promise<T>) =>
        store.transaction((tx) => {
          if (!stale) return fn(tx);
          stale = false;
          // The head as it stood before another writer's append: this attempt's swap loses.
          return fn(
            Object.assign(Object.create(tx) as LearningStoreTx, {
              head: async (key: string) => {
                const head = await tx.head(key);
                return head ? { ...head, seq: head.seq - 1, lastHash: 'stale' } : head;
              },
            }),
          );
        }),
    });
    const result = await new Ledger({ store: racing }).propose(candidate('two'), { verdict: 'kept' });
    expect(result.status).toBe('kept');
    expect((await store.chainRows(chainKeyOf(LEARNER))).map((r) => [r.seq, JSON.parse(r.body).subject])).toEqual([
      [1, 'one'], [2, 'one'], [3, 'two'], [4, 'two'],
    ]);
    expect((await ledger.verifyChain(chainKeyOf(LEARNER))).ok).toBe(true);
  });

  it('answers conflict and writes nothing when its compare-and-swap loses four times in a row', async () => {
    const store = await open();
    await new Ledger({ store }).propose(candidate('one'), { verdict: 'kept' });
    let attempts = 0;
    const busy = Object.assign(Object.create(store) as LearningStore, {
      transaction: <T>(fn: (tx: LearningStoreTx) => Promise<T>) =>
        store.transaction((tx) => {
          attempts += 1;
          // Another writer moves the head before each attempt's swap.
          return fn(Object.assign(Object.create(tx) as LearningStoreTx, { advanceHead: async () => false }));
        }),
    });
    expect(await new Ledger({ store: busy }).propose(candidate('two'), { verdict: 'kept' })).toEqual({ status: 'conflict' });
    expect(attempts).toBe(4);
    expect((await store.chainRows(chainKeyOf(LEARNER))).map((r) => r.seq)).toEqual([1, 2]);
    expect(await store.head(chainKeyOf(LEARNER))).toMatchObject({ seq: 2 });
  });

  it('writes nothing for a forgotten user, on a forgotten head and on a new chain', async () => {
    const store = await open();
    const ledger = new Ledger({ store });
    await ledger.propose(candidate(), { verdict: 'kept' });
    await store.markHeadsForgotten('A', '42');
    expect(await ledger.propose(candidate('after'), { verdict: 'kept' })).toEqual({ status: 'forgotten' });

    await store.insertForgotten(await tombstoneHash('A', '7'), new Date().toISOString());
    expect(await ledger.propose({ ...candidate(), learner: { ...LEARNER, userId: '7' } }, { verdict: 'kept' })).toEqual({ status: 'forgotten' });
    expect(await store.head(chainKeyOf({ ...LEARNER, userId: '7' }))).toBeUndefined();
  });

  it('runs again the deletion of a user whose tombstone an append finds after it committed', async () => {
    const store = await open();
    const deleted: string[] = [];
    const ledger = new Ledger({
      store,
      onForgottenAfterCommit: async (namespace, userId) => {
        deleted.push(`${namespace}/${userId}`);
        await store.deleteUserRows(namespace, userId);
      },
    });
    const tomb = await tombstoneHash('A', '42');
    // The tombstone commits between the append's check and its commit: written inside the append's transaction here.
    const result = await ledger.propose(candidate(), {
      verdict: 'kept',
      change: async (tx) => tx.insertForgotten(tomb, new Date().toISOString()),
    });
    expect(result).toEqual({ status: 'forgotten' });
    expect(deleted).toEqual(['A/42']);
    expect(await store.chainRows(chainKeyOf(LEARNER))).toEqual([]);
    expect(await store.head(chainKeyOf(LEARNER))).toBeUndefined();
  });

  it("deletes the user's rows itself when it finds the tombstone after it committed and was given no deletion", async () => {
    const store = await open();
    const tomb = await tombstoneHash('A', '42');
    const result = await new Ledger({ store }).propose(candidate(), {
      verdict: 'kept',
      change: async (tx) => tx.insertForgotten(tomb, new Date().toISOString()),
    });
    expect(result).toEqual({ status: 'forgotten' });
    expect(await store.chainRows(chainKeyOf(LEARNER))).toEqual([]);
    expect(await store.head(chainKeyOf(LEARNER))).toBeUndefined();
    expect(await store.isForgotten(tomb)).toBe(true);
  });

  it('keeps an append that committed when its second read of the tombstone fails, and says so without the user', async () => {
    const store = await open();
    const learner = { ...LEARNER, userId: 'ana-7731' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(store, 'isForgotten').mockRejectedValueOnce(new Error('the connection was reset'));
    const result = await new Ledger({ store }).propose({ ...candidate(), learner }, { verdict: 'kept' });
    expect(result.status).toBe('kept');
    expect((await store.chainRows(chainKeyOf(learner))).map((r) => r.verdict)).toEqual(['pending', 'kept']);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toMatch(/^\[agentos\] learning: .*the connection was reset/);
    expect(line).not.toContain('ana-7731');
  });

  it('answers forgotten when the deletion it runs again fails, naming the tombstone and never the user', async () => {
    const store = await open();
    const learner = { ...LEARNER, userId: 'ana-7731' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ledger = new Ledger({
      store,
      onForgottenAfterCommit: async () => {
        throw new Error('the database is not reachable');
      },
    });
    const tomb = await tombstoneHash('A', 'ana-7731');
    const result = await ledger.propose(
      { ...candidate(), learner },
      { verdict: 'kept', change: async (tx) => tx.insertForgotten(tomb, new Date().toISOString()) },
    );
    expect(result).toEqual({ status: 'forgotten' });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toMatch(/^\[agentos\] learning: /);
    expect(line).toContain(tomb.slice(0, 16));
    expect(line).toContain('the database is not reachable');
    expect(line).not.toContain('ana-7731');
  });

  it('refuses a new candidate under a freeze, and lets an operator act', async () => {
    const ledger = new Ledger({ store: await open(), isFrozen: () => true });
    expect(await ledger.propose(candidate())).toEqual({ status: 'frozen' });
    expect((await ledger.propose(candidate(), { verdict: 'kept', operator: true })).status).toBe('kept');
  });

  it('refuses a new candidate while AGENTOS_LEARNING_FREEZE=1 freezes the process, and lets an operator act', async () => {
    const ledger = new Ledger({ store: await open() });
    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
    expect(await ledger.propose(candidate())).toEqual({ status: 'frozen' });
    expect((await ledger.propose(candidate(), { verdict: 'kept', operator: true })).status).toBe('kept');
    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '0');
    expect((await ledger.propose(candidate())).status).toBe('pending');
  });

  it("writes a verdict only where it can follow the candidate's current one", async () => {
    const store = await open();
    const ledger = new Ledger({ store });

    const rejected = idOf(await ledger.propose(candidate('one')));
    expect((await ledger.decide(rejected, 'rejected', 'write_failed')).status).toBe('rejected');
    expect(await ledger.decide(rejected, 'kept', 'written')).toEqual({ status: 'refused', current: 'rejected' });
    expect(await ledger.decide(rejected, 'reverted', 'by an operator')).toEqual({ status: 'refused', current: 'rejected' });
    expect(await ledger.latestVerdict(rejected)).toBe('rejected');

    const kept = idOf(await ledger.propose(candidate('two')));
    expect(await ledger.decide(kept, 'pending', 'again')).toEqual({ status: 'refused', current: 'pending' });
    expect((await ledger.decide(kept, 'kept', 'written')).status).toBe('kept');
    expect(await ledger.decide(kept, 'kept', 'written')).toEqual({ status: 'refused', current: 'kept' });
    expect(await ledger.decide(kept, 'rejected', 'write_failed')).toEqual({ status: 'refused', current: 'kept' });
    expect((await ledger.decide(kept, 'reverted', 'by an operator')).status).toBe('reverted');
    expect(await ledger.decide(kept, 'reverted', 'by an operator')).toEqual({ status: 'refused', current: 'reverted' });

    const retired = idOf(await ledger.propose(candidate('three')));
    expect((await ledger.decide(retired, 'reverted', 'its probe failed')).status).toBe('reverted');

    expect(await ledger.decide('01J00000000000000000000000', 'kept', 'written')).toEqual({ status: 'unknown_candidate' });
    const rows = await store.chainRows(chainKeyOf(LEARNER));
    expect(rows.map((r) => [JSON.parse(r.body).subject, r.rowType, r.verdict])).toEqual([
      ['one', 'candidate', 'pending'],
      ['one', 'verdict', 'rejected'],
      ['two', 'candidate', 'pending'],
      ['two', 'verdict', 'kept'],
      ['two', 'verdict', 'reverted'],
      ['three', 'candidate', 'pending'],
      ['three', 'verdict', 'reverted'],
    ]);
    expect(await ledger.decide(rows[1]!.id, 'kept', 'written')).toEqual({ status: 'unknown_candidate' });
    expect(await ledger.verifyChain(chainKeyOf(LEARNER))).toEqual({ ok: true, keyed: false });
  });

  it('refuses the second of two verdicts that race onto one candidate, once its swap has lost', async () => {
    const store = await open();
    const ledger = new Ledger({ store });
    const id = idOf(await ledger.propose(candidate()));
    const staleHead = await store.head(chainKeyOf(LEARNER));
    const staleRows = await store.candidateRows(id);
    // Another process decides the candidate after this one read the head and the candidate's rows.
    expect((await ledger.decide(id, 'rejected', 'write_failed')).status).toBe('rejected');
    let staleHeads = 1;
    let staleCandidates = 1;
    const racing = Object.assign(Object.create(store) as LearningStore, {
      transaction: <T>(fn: (tx: LearningStoreTx) => Promise<T>) =>
        store.transaction((tx) =>
          fn(
            Object.assign(Object.create(tx) as LearningStoreTx, {
              head: async (key: string) => (staleHeads-- > 0 ? staleHead : tx.head(key)),
              candidateRows: async (candidateId: string) => (staleCandidates-- > 0 ? staleRows : tx.candidateRows(candidateId)),
            }),
          ),
        ),
    });
    expect(await new Ledger({ store: racing }).decide(id, 'kept', 'written')).toEqual({ status: 'refused', current: 'rejected' });
    expect(staleHeads).toBeLessThan(0);
    expect(await ledger.latestVerdict(id)).toBe('rejected');
    expect((await store.chainRows(chainKeyOf(LEARNER))).map((r) => r.verdict)).toEqual(['pending', 'rejected']);
  });

  it("writes a revert's verdict on a candidate it names only while that candidate is kept and in its chain", async () => {
    const store = await open();
    const ledger = new Ledger({ store });
    const kept = idOf(await ledger.propose(candidate('one'), { verdict: 'kept' }));
    const revert = (alsoDecide: NonNullable<ProposeOptions['alsoDecide']>) =>
      ledger.propose(candidate('one'), { verdict: 'kept', operator: true, alsoDecide });

    const first = await revert([{ candidateId: kept, verdict: 'reverted', reason: 'reverted' }]);
    expect(first.status).toBe('kept');
    expect('verdict' in first && first.verdict?.candidateId).toBe(idOf(first));
    expect(await ledger.latestVerdict(kept)).toBe('reverted');
    await expect(revert([{ candidateId: kept, verdict: 'reverted', reason: 'reverted' }])).rejects.toThrow(/its verdict is reverted/);

    const pending = idOf(await ledger.propose(candidate('two')));
    await expect(
      revert([
        { candidateId: pending, verdict: 'reverted', reason: 'reverted' },
        { candidateId: pending, verdict: 'reverted', reason: 'reverted' },
      ]),
    ).rejects.toThrow(/more than once/);

    const other = idOf(await ledger.propose({ ...candidate('three'), learner: { ...LEARNER, userId: '7' } }, { verdict: 'kept' }));
    await expect(revert([{ candidateId: other, verdict: 'reverted', reason: 'reverted' }])).rejects.toThrow(/not a candidate of this chain/);
    expect(await ledger.latestVerdict(other)).toBe('kept');
    expect(await ledger.latestVerdict(pending)).toBe('pending');
    expect((await store.chainRows(chainKeyOf(LEARNER))).length).toBe(6);
    expect(await ledger.verifyChain(chainKeyOf(LEARNER))).toEqual({ ok: true, keyed: false });
  });

  it("reads a chain's pending candidates, its newest row with a state digest, and its entries", async () => {
    const store = await open();
    const ledger = new Ledger({ store });
    const key = chainKeyOf(LEARNER);
    await ledger.propose(candidate('one'), { verdict: 'kept', stateDigest: 'digest-1' });
    await ledger.propose(candidate('two'));
    await ledger.propose({ ...candidate('three'), kind: 'memory_write' }, { stateDigest: 'digest-3' });

    expect((await ledger.pendingCandidates(key)).map((entry) => entry.subject)).toEqual(['two', 'three']);
    expect(await ledger.latestStateRow(key, ['operator_set'])).toMatchObject({ rowType: 'verdict', subject: 'one', stateDigest: 'digest-1' });
    expect(await ledger.latestStateRow(key, ['memory_write'])).toMatchObject({ rowType: 'candidate', subject: 'three', stateDigest: 'digest-3' });
    expect(await ledger.latestStateRow(key, ['trait'])).toBeUndefined();
    expect((await ledger.entries(key)).map((entry) => [entry.seq, entry.rowType, entry.subject])).toEqual([
      [1, 'candidate', 'one'],
      [2, 'verdict', 'one'],
      [3, 'candidate', 'two'],
      [4, 'candidate', 'three'],
    ]);
  });

  it('chains a row with no learner per agent, and a visitor row per that user', async () => {
    const store = await open();
    const ledger = new Ledger({ store });
    await ledger.propose({ ...candidate(), learner: { ...LEARNER, userId: null } }, { verdict: 'kept' });
    await ledger.propose({ ...candidate(), learner: { ...LEARNER, userId: null }, turnUserId: 'bo' }, { verdict: 'kept' });
    expect((await store.chainRows('a|A|tutor')).length).toBe(2);
    expect((await store.chainRows('t|A|tutor|bo')).length).toBe(2);
    expect((await store.head('t|A|tutor|bo'))?.userId).toBe('bo');

    // A blank visitor id names no visitor: the row goes on the agent's chain, whose head names no user.
    await ledger.propose({ ...candidate(), learner: { ...LEARNER, userId: null }, turnUserId: '' }, { verdict: 'kept' });
    expect((await store.chainRows('a|A|tutor')).map((r) => r.turnUserId)).toEqual([null, null, null, null]);
    expect((await store.head('a|A|tutor'))?.userId).toBeNull();
    expect(await ledger.verifyChain('a|A|tutor')).toEqual({ ok: true, keyed: false });
  });
});

describe('an edit made outside the layer, on SQLite', () => {
  const openSql = async () => {
    const adapter = await openSqlite();
    return { adapter, store: new SqlLearningStore({ adapter }) };
  };
  const rewrite = (
    adapter: StorageAdapter,
    row: { id: string; body: string; subject: string; prevHash: string; hash: string },
  ) =>
    adapter.run('UPDATE agentos_learning_ledger SET body = ?, subject = ?, prev_hash = ?, hash = ? WHERE id = ?', [
      row.body, row.subject, row.prevHash, row.hash, row.id,
    ]);

  it("breaks on an edited row's text, an edited column and a deleted newest row", async () => {
    const one = await openSql();
    const a = new Ledger({ store: one.store });
    await a.propose(candidate(), { verdict: 'kept' });
    const [first] = await one.store.chainRows(chainKeyOf(LEARNER));
    await rewrite(one.adapter, { ...first!, body: first!.body.replace('"openness":0.6', '"openness":0.9') });
    expect(await a.verifyChain(chainKeyOf(LEARNER))).toMatchObject({ ok: false, reason: expect.stringMatching(/hash/) });

    const two = await openSql();
    const b = new Ledger({ store: two.store });
    await b.propose(candidate(), { verdict: 'kept' });
    const [row] = await two.store.chainRows(chainKeyOf(LEARNER));
    await rewrite(two.adapter, { ...row!, subject: 'honesty' });
    expect(await b.verifyChain(chainKeyOf(LEARNER))).toMatchObject({ ok: false, reason: expect.stringMatching(/column/) });

    const three = await openSql();
    const c = new Ledger({ store: three.store });
    await c.propose(candidate('one'), { verdict: 'kept' });
    await c.propose(candidate('two'), { verdict: 'kept' });
    const rows = await three.store.chainRows(chainKeyOf(LEARNER));
    await three.adapter.run('DELETE FROM agentos_learning_ledger WHERE id = ?', [rows[rows.length - 1]!.id]);
    expect(await c.verifyChain(chainKeyOf(LEARNER))).toMatchObject({ ok: false, reason: expect.stringMatching(/head/) });
  });

  it('breaks on rows moved to another chain, even with a head made for them there', async () => {
    const { adapter, store } = await openSql();
    const ledger = new Ledger({ store });
    await ledger.propose(candidate(), { verdict: 'kept' });
    const [first] = await store.chainRows(chainKeyOf(LEARNER));
    const moved = chainKeyOf({ ...LEARNER, userId: '7' });
    await adapter.run('UPDATE agentos_learning_ledger SET chain_key = ?', [moved]);
    await adapter.run('UPDATE agentos_learning_heads SET chain_key = ?, user_id = ?', [moved, '7']);
    expect(await ledger.verifyChain(moved)).toEqual({ ok: false, keyed: false, reason: `row ${first!.id}: column chainKey` });
  });

  it('reads a row whose text is no ledger entry as a broken chain, never as an error', async () => {
    const { adapter, store } = await openSql();
    const ledger = new Ledger({ store });
    const id = idOf(await ledger.propose(candidate()));
    const [row] = await store.chainRows(chainKeyOf(LEARNER));
    // A writer without a key replaces the row's text and recomputes its hash.
    await rewrite(adapter, { ...row!, body: 'null', hash: await sha256Hex('null') });
    expect(await ledger.verifyChain(chainKeyOf(LEARNER))).toEqual({ ok: false, keyed: false, reason: `row ${id}: unreadable` });
    await expect(ledger.decide(id, 'kept', 'written')).rejects.toThrow(/unreadable/);
    await expect(ledger.entries(chainKeyOf(LEARNER))).rejects.toThrow(/unreadable/);
  });

  it("verifies again from an operator's reanchor, whatever the rows before it hold", async () => {
    const key = chainKeyOf(LEARNER);
    const reanchor = (ledger: Ledger) => ledger.propose(candidate('traits'), { verdict: 'kept', reason: 'reanchor', operator: true });

    // Every row deleted, the head kept: the reanchor is the chain's first row and goes on from the head.
    const one = await openSql();
    const a = new Ledger({ store: one.store });
    await a.propose(candidate('one'), { verdict: 'kept' });
    await one.adapter.run('DELETE FROM agentos_learning_ledger');
    expect(await a.verifyChain(key)).toEqual({ ok: false, keyed: false, reason: 'head with no rows' });
    expect((await reanchor(a)).status).toBe('kept');
    expect((await one.store.chainRows(key)).map((r) => r.seq)).toEqual([3, 4]);
    expect(await a.verifyChain(key)).toEqual({ ok: true, keyed: false });

    // The head deleted, the rows kept: the reanchor goes on from the newest row.
    const two = await openSql();
    const b = new Ledger({ store: two.store });
    await b.propose(candidate('one'), { verdict: 'kept' });
    await two.adapter.run('DELETE FROM agentos_learning_heads');
    expect(await b.verifyChain(key)).toEqual({ ok: false, keyed: false, reason: 'head' });
    expect((await reanchor(b)).status).toBe('kept');
    expect((await two.store.chainRows(key)).map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(await b.verifyChain(key)).toEqual({ ok: true, keyed: false });

    // An older row's text unreadable.
    const three = await openSql();
    const c = new Ledger({ store: three.store });
    await c.propose(candidate('one'), { verdict: 'kept' });
    const [oldest] = await three.store.chainRows(key);
    await three.adapter.run('UPDATE agentos_learning_ledger SET body = ? WHERE id = ?', ['{', oldest!.id]);
    expect(await c.verifyChain(key)).toEqual({ ok: false, keyed: false, reason: `row ${oldest!.id}: unreadable` });
    expect((await reanchor(c)).status).toBe('kept');
    expect(await c.verifyChain(key)).toEqual({ ok: true, keyed: false });
  });

  it('with a key, breaks on a chain recomputed without it; without a key the same chain verifies, unkeyed', async () => {
    const { adapter, store } = await openSql();
    const keyed = new Ledger({ store, ledgerKey: 'k-secret' });
    expect(keyed.keyed).toBe(true);
    await keyed.propose(candidate(), { verdict: 'kept' });
    expect(await keyed.verifyChain(chainKeyOf(LEARNER))).toEqual({ ok: true, keyed: true });
    // A writer without the key recomputes every hash with plain SHA-256 and moves the head to match.
    let prev = '0'.repeat(64);
    let last = { id: '', hash: '', seq: 0 };
    for (const row of await store.chainRows(chainKeyOf(LEARNER))) {
      const body = canonicalJson({ ...JSON.parse(row.body), prevHash: prev });
      const hash = await sha256Hex(body);
      await rewrite(adapter, { ...row, body, prevHash: prev, hash });
      prev = hash;
      last = { id: row.id, hash, seq: row.seq };
    }
    await adapter.run('UPDATE agentos_learning_heads SET last_id = ?, last_hash = ?, seq = ?', [last.id, last.hash, last.seq]);
    expect((await keyed.verifyChain(chainKeyOf(LEARNER))).ok).toBe(false);
    expect(await new Ledger({ store }).verifyChain(chainKeyOf(LEARNER))).toEqual({ ok: true, keyed: false });
  });
});
