/**
 * @file learning-store.contract.ts
 * The contract every LearningStore keeps; each store's test file runs it (learning-store.test.ts for the in-process
 * store). Ledger rows read back in sequence order, by candidate and by learner; a chain head is advanced by
 * compare-and-swap, moved only in its last row, hash and seq, and refused once marked forgotten; trait rows are updated
 * by version; freezes, sessions and tombstones are kept, freezes listed in one order and a session row's start kept
 * when it is written again; a user's rows are deleted in one namespace only, and the tombstone stays; a transaction
 * that throws takes back every write it made, a deletion included, and no read sees one of them; and every row a store
 * is given or hands out is a copy.
 */
import { describe, expect, it } from 'vitest';
import type {
  ChainHead,
  FreezeRow,
  LearningStore,
  SessionRow,
  StoredLedgerRow,
  StoredTraitRow,
} from '../LearningStore.js';

const NOW = '2026-10-12T12:00:00.000Z';
const LATER = '2026-10-12T13:00:00.000Z';

export function ledgerRow(over: Partial<StoredLedgerRow> = {}): StoredLedgerRow {
  return {
    id: over.id ?? `01J${Math.random().toString(36).slice(2, 12).toUpperCase()}`,
    chainKey: 'u|A|tutor|42',
    seq: 1,
    rowType: 'candidate',
    candidateId: over.id ?? 'c-1',
    namespace: 'A',
    agentKey: 'tutor',
    userId: '42',
    turnUserId: null,
    sessionId: 's-1',
    kind: 'memory_write',
    subject: 't-1',
    verdict: 'pending',
    body: '{}',
    prevHash: '0'.repeat(64),
    hash: 'h-1',
    stateDigest: null,
    createdAt: NOW,
    ...over,
  };
}

export function traitRow(over: Partial<StoredTraitRow> = {}): StoredTraitRow {
  return { namespace: 'A', agentKey: 'tutor', userId: '42', personaId: 'tutor', state: '{"current":{}}', version: 1, updatedAt: NOW, ...over };
}

export function headRow(over: Partial<ChainHead> = {}): ChainHead {
  return {
    chainKey: 'u|A|tutor|42',
    namespace: 'A',
    agentKey: 'tutor',
    userId: '42',
    lastId: 'r-1',
    lastHash: 'h-1',
    seq: 1,
    forgotten: false,
    ...over,
  };
}

export function freezeRow(over: Partial<FreezeRow> = {}): FreezeRow {
  return { scopeKey: 'agent|tutor', mode: 'frozen', namespace: '', agentKey: 'tutor', userId: null, setBy: 'operator:ops', createdAt: NOW, ...over };
}

export function sessionRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    namespace: 'A',
    agentKey: 'tutor',
    sessionId: 's-1',
    userId: '42',
    kind: 'learner',
    personaId: 'tutor',
    conversationIds: ['c-1'],
    brainIds: ['b-1'],
    startedAt: NOW,
    version: 1,
    ...over,
  };
}

/** What a store holds of the rows the transaction cases write, read back through each of its reads. */
async function everything(store: LearningStore) {
  return {
    chain: await store.chainRows('u|A|tutor|42'),
    otherChain: await store.chainRows('u|A|tutor|7'),
    candidate: await store.candidateRows('r-1'),
    learner: await store.learnerLedgerRows('A', 'tutor', '42'),
    otherLearner: await store.learnerLedgerRows('A', 'tutor', '7'),
    verdict: await store.ledgerRow('r-2'),
    head: await store.head('u|A|tutor|42'),
    otherHead: await store.head('u|A|tutor|7'),
    trait: await store.traitRow('A', 'tutor', '42'),
    otherTrait: await store.traitRow('A', 'tutor', '7'),
    freezes: await store.freezeRows(),
    sessions: await store.sessionRowsOf('A', '42'),
    forgotten: await store.isForgotten('hash-42'),
  };
}

export function runLearningStoreContract(name: string, open: () => Promise<LearningStore>): void {
  describe(`${name}: the learning store contract`, () => {
    const withStore = async (body: (store: LearningStore) => Promise<void>) => {
      const store = await open();
      try {
        await body(store);
      } finally {
        await store.close();
      }
    };

    it('reads a chain back in sequence order, and a candidate with its verdicts', () =>
      withStore(async (store) => {
        await store.insertLedgerRow(ledgerRow({ id: 'r-2', seq: 2, rowType: 'verdict', candidateId: 'r-1', verdict: 'kept' }));
        await store.insertLedgerRow(ledgerRow({ id: 'r-1', seq: 1, candidateId: 'r-1' }));
        await store.insertLedgerRow(ledgerRow({ id: 'r-9', chainKey: 'a|A|tutor', seq: 1, userId: null, candidateId: 'r-9' }));
        expect((await store.chainRows('u|A|tutor|42')).map((r) => r.id)).toEqual(['r-1', 'r-2']);
        expect((await store.candidateRows('r-1')).map((r) => r.id)).toEqual(['r-1', 'r-2']);
        expect(await store.ledgerRow('r-9')).toMatchObject({ chainKey: 'a|A|tutor', userId: null, turnUserId: null });
        expect((await store.learnerLedgerRows('A', 'tutor', '42')).map((r) => r.id)).toEqual(['r-1', 'r-2']);
        await expect(store.insertLedgerRow(ledgerRow({ id: 'r-3', seq: 2 }))).rejects.toThrow();
        await expect(store.insertLedgerRow(ledgerRow({ id: 'r-1', chainKey: 'u|A|tutor|7', userId: '7' }))).rejects.toThrow();
        expect(await store.chainRows('u|A|tutor|7')).toEqual([]);
      }));

    it("reads one learner's rows chain by chain in sequence order, and no other agent's, namespace's or visitor's", () =>
      withStore(async (store) => {
        await store.insertLedgerRow(ledgerRow({ id: 'x-1', chainKey: 'x|A|tutor|42', seq: 1 }));
        await store.insertLedgerRow(ledgerRow({ id: 'u-2', seq: 2, rowType: 'verdict', candidateId: 'u-1', verdict: 'kept' }));
        await store.insertLedgerRow(ledgerRow({ id: 'u-1', seq: 1 }));
        await store.insertLedgerRow(ledgerRow({ id: 'coach-1', chainKey: 'u|A|coach|42', agentKey: 'coach' }));
        await store.insertLedgerRow(ledgerRow({ id: 'b-1', chainKey: 'u|B|tutor|42', namespace: 'B' }));
        await store.insertLedgerRow(ledgerRow({ id: 'visit-1', chainKey: 't|A|tutor|42', userId: null, turnUserId: '42' }));
        expect((await store.learnerLedgerRows('A', 'tutor', '42')).map((r) => r.id)).toEqual(['u-1', 'u-2', 'x-1']);
        expect((await store.learnerLedgerRows('A', 'coach', '42')).map((r) => r.id)).toEqual(['coach-1']);
        expect(await store.learnerLedgerRows('A', 'tutor', '7')).toEqual([]);
      }));

    it('advances a chain head by compare-and-swap, and refuses a forgotten head', () =>
      withStore(async (store) => {
        const head = { chainKey: 'u|A|tutor|42', namespace: 'A', agentKey: 'tutor', userId: '42', lastId: 'r-1', lastHash: 'h-1', seq: 1, forgotten: false };
        expect(await store.insertHead(head)).toBe(true);
        expect(await store.insertHead(head)).toBe(false);
        expect(await store.advanceHead('u|A|tutor|42', 1, { lastId: 'r-2', lastHash: 'h-2', seq: 2 })).toBe(true);
        expect(await store.advanceHead('u|A|tutor|42', 1, { lastId: 'r-x', lastHash: 'h-x', seq: 2 })).toBe(false);
        expect(await store.head('u|A|tutor|42')).toMatchObject({ lastId: 'r-2', lastHash: 'h-2', seq: 2, forgotten: false });
        expect(await store.markHeadsForgotten('A', '42')).toBe(1);
        expect(await store.advanceHead('u|A|tutor|42', 2, { lastId: 'r-3', lastHash: 'h-3', seq: 3 })).toBe(false);
        expect((await store.head('u|A|tutor|42'))?.forgotten).toBe(true);
        expect(await store.advanceHead('u|A|tutor|9', 0, { lastId: 'r-1', lastHash: 'h-1', seq: 1 })).toBe(false);
      }));

    it("marks the heads of one user in one namespace forgotten, and no other user's or namespace's", () =>
      withStore(async (store) => {
        await store.insertHead(headRow());
        await store.insertHead(headRow({ chainKey: 't|A|tutor|42', lastId: 'v-1' }));
        await store.insertHead(headRow({ chainKey: 'u|B|tutor|42', namespace: 'B' }));
        await store.insertHead(headRow({ chainKey: 'u|A|tutor|7', userId: '7' }));
        await store.insertHead(headRow({ chainKey: 'a|A|tutor', userId: null }));
        expect(await store.markHeadsForgotten('A', '42')).toBe(2);
        const forgotten = async (chainKey: string) => (await store.head(chainKey))?.forgotten;
        expect(await forgotten('u|A|tutor|42')).toBe(true);
        expect(await forgotten('t|A|tutor|42')).toBe(true);
        expect(await forgotten('u|B|tutor|42')).toBe(false);
        expect(await forgotten('u|A|tutor|7')).toBe(false);
        expect(await forgotten('a|A|tutor')).toBe(false);
        expect(await store.advanceHead('u|A|tutor|7', 1, { lastId: 'r-2', lastHash: 'h-2', seq: 2 })).toBe(true);
      }));

    it("moves only a head's last row, hash and seq, whatever else the object it is given holds", () =>
      withStore(async (store) => {
        await store.insertHead(headRow());
        const next = headRow({ chainKey: 'u|B|tutor|7', namespace: 'B', agentKey: 'coach', userId: '7', lastId: 'r-2', lastHash: 'h-2', seq: 2 });
        expect(await store.advanceHead('u|A|tutor|42', 1, next)).toBe(true);
        expect(await store.head('u|A|tutor|42')).toEqual(headRow({ lastId: 'r-2', lastHash: 'h-2', seq: 2 }));
        expect(await store.head('u|B|tutor|7')).toBeUndefined();
        await store.markHeadsForgotten('A', '42');
        expect(await store.advanceHead('u|A|tutor|42', 2, headRow({ ...next, seq: 3 }))).toBe(false);
        expect(await store.head('u|A|tutor|42')).toEqual(headRow({ lastId: 'r-2', lastHash: 'h-2', seq: 2, forgotten: true }));
      }));

    it('updates a trait row only at the version it read', () =>
      withStore(async (store) => {
        expect(await store.insertTraitRow(traitRow())).toBe(true);
        expect(await store.insertTraitRow(traitRow())).toBe(false);
        expect(await store.updateTraitRow(traitRow({ state: '{"current":{"openness":0.6}}', version: 2 }), 1)).toBe(true);
        expect(await store.updateTraitRow(traitRow({ state: '{"stale":true}', version: 2 }), 1)).toBe(false);
        expect(await store.traitRow('A', 'tutor', '42')).toMatchObject({ state: '{"current":{"openness":0.6}}', version: 2 });
        expect(await store.traitRow('B', 'tutor', '42')).toBeUndefined();
        expect(await store.updateTraitRow(traitRow({ namespace: 'B', version: 2 }), 1)).toBe(false);
        expect(await store.traitRow('B', 'tutor', '42')).toBeUndefined();
      }));

    it('keeps freezes, sessions and tombstones', () =>
      withStore(async (store) => {
        const freeze = freezeRow();
        await store.insertFreeze(freeze);
        await store.insertFreeze({ ...freeze, setBy: 'operator:other' });
        await store.insertFreeze({ ...freeze, mode: 'off' });
        expect((await store.freezeRows()).map((f) => `${f.scopeKey}:${f.mode}:${f.setBy}`).sort()).toEqual([
          'agent|tutor:frozen:operator:ops',
          'agent|tutor:off:operator:ops',
        ]);
        expect(await store.deleteFreeze('agent|tutor', 'frozen')).toBe(true);
        expect(await store.deleteFreeze('agent|tutor', 'frozen')).toBe(false);

        const session = sessionRow();
        await store.putSessionRow(session);
        await store.putSessionRow({ ...session, conversationIds: ['c-1', 'c-2'], version: 2 });
        await store.putSessionRow({ ...session, sessionId: 's-9', kind: 'visitor' });
        await store.putSessionRow({ ...session, namespace: 'B' });
        expect((await store.sessionRowsOf('A', '42')).map((r) => [r.sessionId, r.kind, r.conversationIds])).toEqual([
          ['s-1', 'learner', ['c-1', 'c-2']],
          ['s-9', 'visitor', ['c-1']],
        ]);
        expect(await store.sessionRow('A', 'tutor', 's-1', '42', 'learner')).toMatchObject({ version: 2 });
        expect(await store.sessionRow('A', 'tutor', 's-1', '42', 'visitor')).toBeUndefined();

        expect(await store.isForgotten('hash-1')).toBe(false);
        await store.insertForgotten('hash-1', NOW);
        await store.insertForgotten('hash-1', LATER);
        expect(await store.isForgotten('hash-1')).toBe(true);
      }));

    it('lists freezes by scope key and mode', () =>
      withStore(async (store) => {
        const scopes = [
          ['learner|a|tutor|42', 'off'],
          ['all', 'frozen'],
          ['agent|tutor', 'off'],
          ['agent|tutor', 'frozen'],
        ] as const;
        for (const [scopeKey, mode] of scopes) await store.insertFreeze(freezeRow({ scopeKey, mode }));
        expect((await store.freezeRows()).map((row) => `${row.scopeKey}:${row.mode}`)).toEqual([
          'agent|tutor:frozen',
          'agent|tutor:off',
          'all:frozen',
          'learner|a|tutor|42:off',
        ]);
      }));

    it("keeps a session row's first start when the row is written again", () =>
      withStore(async (store) => {
        await store.putSessionRow(sessionRow());
        const again = { personaId: 'coach', conversationIds: ['c-1', 'c-2'], brainIds: ['b-1', 'b-2'], version: 2 };
        await store.putSessionRow(sessionRow({ ...again, startedAt: LATER }));
        expect(await store.sessionRow('A', 'tutor', 's-1', '42', 'learner')).toEqual(sessionRow(again));
      }));

    it("deletes a user's rows in one namespace, keyed by user or by turnUserId, and keeps the tombstone", () =>
      withStore(async (store) => {
        await store.insertLedgerRow(ledgerRow({ id: 'a-1' }));
        await store.insertLedgerRow(ledgerRow({ id: 'a-2', chainKey: 't|A|tutor|42', userId: null, turnUserId: '42' }));
        await store.insertLedgerRow(ledgerRow({ id: 'b-1', chainKey: 'u|B|tutor|42', namespace: 'B' }));
        await store.insertLedgerRow(ledgerRow({ id: 'x-1', chainKey: 'u|A|tutor|7', userId: '7' }));
        await store.insertHead(headRow({ lastId: 'a-1', lastHash: 'h', forgotten: true }));
        await store.insertHead(headRow({ chainKey: 't|A|tutor|42', lastId: 'a-2', lastHash: 'h', forgotten: true }));
        await store.insertTraitRow(traitRow());
        await store.insertTraitRow(traitRow({ namespace: 'B' }));
        await store.putSessionRow(sessionRow({ conversationIds: [], brainIds: [] }));
        await store.insertFreeze(freezeRow({ scopeKey: 'learner|A|tutor|42', mode: 'off', namespace: 'A', userId: '42' }));
        await store.insertForgotten('hash-42', NOW);

        const deleted = await store.deleteUserRows('A', '42');

        expect(deleted).toEqual({ ledger: 2, heads: 2, traits: 1, outcomes: 0, lessons: 0, skills: 0, sessions: 1, freezes: 1 });
        expect((await store.chainRows('u|A|tutor|42')).length).toBe(0);
        expect((await store.chainRows('t|A|tutor|42')).length).toBe(0);
        expect(await store.candidateRows('a-1')).toEqual([]);
        expect(await store.learnerLedgerRows('A', 'tutor', '42')).toEqual([]);
        expect(await store.ledgerRow('b-1')).toBeDefined();
        expect(await store.ledgerRow('x-1')).toBeDefined();
        expect(await store.traitRow('B', 'tutor', '42')).toBeDefined();
        expect(await store.head('u|A|tutor|42')).toBeUndefined();
        expect(await store.isForgotten('hash-42')).toBe(true);
      }));

    it('leaves nothing behind when a transaction throws', () =>
      withStore(async (store) => {
        await expect(
          store.transaction(async (tx) => {
            await tx.insertLedgerRow(ledgerRow({ id: 'gone' }));
            await tx.insertTraitRow(traitRow());
            throw new Error('the change failed');
          }),
        ).rejects.toThrow('the change failed');
        expect(await store.ledgerRow('gone')).toBeUndefined();
        expect(await store.traitRow('A', 'tutor', '42')).toBeUndefined();
        expect(
          await store.transaction(async (tx) => {
            await tx.insertLedgerRow(ledgerRow({ id: 'kept' }));
            return tx.ledgerRow('kept');
          }),
        ).toMatchObject({ id: 'kept' });
      }));

    it('takes back every kind of write when a transaction throws', () =>
      withStore(async (store) => {
        await store.insertLedgerRow(ledgerRow({ id: 'r-1' }));
        await store.insertHead(headRow());
        await store.insertTraitRow(traitRow());
        await store.insertFreeze(freezeRow());
        await store.putSessionRow(sessionRow());
        const before = await everything(store);
        expect(before).toMatchObject({
          chain: [{ id: 'r-1' }],
          head: { seq: 1, forgotten: false },
          trait: { version: 1 },
          freezes: [{ scopeKey: 'agent|tutor', mode: 'frozen' }],
          sessions: [{ sessionId: 's-1', conversationIds: ['c-1'] }],
          forgotten: false,
        });

        await expect(
          store.transaction(async (tx) => {
            await tx.insertLedgerRow(ledgerRow({ id: 'r-2', seq: 2, rowType: 'verdict', candidateId: 'r-1', verdict: 'kept' }));
            await tx.insertLedgerRow(ledgerRow({ id: 'r-7', chainKey: 'u|A|tutor|7', userId: '7' }));
            await tx.advanceHead('u|A|tutor|42', 1, { lastId: 'r-2', lastHash: 'h-2', seq: 2 });
            await tx.insertHead(headRow({ chainKey: 'u|A|tutor|7', userId: '7', lastId: 'r-7' }));
            await tx.markHeadsForgotten('A', '42');
            await tx.updateTraitRow(traitRow({ state: '{"current":{"openness":0.6}}', version: 2 }), 1);
            await tx.insertTraitRow(traitRow({ userId: '7' }));
            await tx.deleteFreeze('agent|tutor', 'frozen');
            await tx.insertFreeze(freezeRow({ scopeKey: 'all' }));
            await tx.putSessionRow(sessionRow({ conversationIds: ['c-1', 'c-2'], version: 2 }));
            await tx.putSessionRow(sessionRow({ sessionId: 's-2' }));
            await tx.insertForgotten('hash-42', NOW);
            throw new Error('the change failed');
          }),
        ).rejects.toThrow('the change failed');

        expect(await everything(store)).toEqual(before);
      }));

    it("takes back a user's deletion when its transaction throws, and the chain goes on from its rows", () =>
      withStore(async (store) => {
        await store.insertLedgerRow(ledgerRow({ id: 'r-1' }));
        await store.insertLedgerRow(ledgerRow({ id: 'v-1', chainKey: 't|A|tutor|42', userId: null, turnUserId: '42' }));
        await store.insertHead(headRow());
        await store.insertTraitRow(traitRow());
        await store.insertFreeze(freezeRow({ scopeKey: 'learner|A|tutor|42', mode: 'off', namespace: 'A', userId: '42' }));
        await store.putSessionRow(sessionRow());
        const before = await everything(store);
        const visits = await store.chainRows('t|A|tutor|42');
        expect(visits.map((r) => r.id)).toEqual(['v-1']);

        await expect(
          store.transaction(async (tx) => {
            expect(await tx.deleteUserRows('A', '42')).toMatchObject({ ledger: 2, heads: 1, traits: 1, sessions: 1, freezes: 1 });
            expect(await tx.chainRows('u|A|tutor|42')).toEqual([]);
            throw new Error('the deletion failed');
          }),
        ).rejects.toThrow('the deletion failed');

        expect(await everything(store)).toEqual(before);
        expect(await store.chainRows('t|A|tutor|42')).toEqual(visits);
        await expect(store.insertLedgerRow(ledgerRow({ id: 'r-again', seq: 1 }))).rejects.toThrow();
        await store.insertLedgerRow(ledgerRow({ id: 'r-2', seq: 2, rowType: 'verdict', candidateId: 'r-1', verdict: 'kept' }));
        expect((await store.chainRows('u|A|tutor|42')).map((r) => r.id)).toEqual(['r-1', 'r-2']);
        expect((await store.candidateRows('r-1')).map((r) => r.id)).toEqual(['r-1', 'r-2']);
        expect((await store.learnerLedgerRows('A', 'tutor', '42')).map((r) => r.id)).toEqual(['r-1', 'r-2']);
      }));

    it('lets no read see a write that a transaction takes back', () =>
      withStore(async (store) => {
        let wrote!: () => void;
        const written = new Promise<void>((resolve) => {
          wrote = resolve;
        });
        let fail!: () => void;
        const failing = new Promise<void>((resolve) => {
          fail = resolve;
        });
        const transaction = store.transaction(async (tx) => {
          await tx.insertLedgerRow(ledgerRow({ id: 'taken-back' }));
          await tx.insertTraitRow(traitRow());
          wrote();
          await failing;
          throw new Error('the change failed');
        });
        await Promise.race([written, transaction]);

        const reads = Promise.all([store.ledgerRow('taken-back'), store.chainRows('u|A|tutor|42'), store.traitRow('A', 'tutor', '42')]);
        fail();
        await Promise.all([
          expect(transaction).rejects.toThrow('the change failed'),
          expect(reads).resolves.toEqual([undefined, [], undefined]),
        ]);
      }));

    it('hands out copies, and keeps copies of the rows it is given', () =>
      withStore(async (store) => {
        const given = ledgerRow({ id: 'r-1' });
        await store.insertLedgerRow(given);
        given.subject = 'changed';
        const handedOut = [
          ...(await store.chainRows('u|A|tutor|42')),
          ...(await store.candidateRows('r-1')),
          ...(await store.learnerLedgerRows('A', 'tutor', '42')),
        ];
        const one = await store.ledgerRow('r-1');
        for (const row of [...handedOut, ...(one ? [one] : [])]) row.subject = 'changed';
        expect(await store.ledgerRow('r-1')).toEqual(ledgerRow({ id: 'r-1' }));
        expect(await store.chainRows('u|A|tutor|42')).toEqual([ledgerRow({ id: 'r-1' })]);
        expect(await store.candidateRows('r-1')).toEqual([ledgerRow({ id: 'r-1' })]);

        const head = headRow();
        await store.insertHead(head);
        head.seq = 9;
        const headOut = await store.head('u|A|tutor|42');
        if (headOut) headOut.forgotten = true;
        expect(await store.head('u|A|tutor|42')).toEqual(headRow());

        const trait = traitRow();
        await store.insertTraitRow(trait);
        trait.state = 'changed';
        const traitOut = await store.traitRow('A', 'tutor', '42');
        if (traitOut) traitOut.version = 9;
        expect(await store.traitRow('A', 'tutor', '42')).toEqual(traitRow());

        const freeze = freezeRow();
        await store.insertFreeze(freeze);
        freeze.setBy = 'changed';
        for (const row of await store.freezeRows()) row.mode = 'off';
        expect(await store.freezeRows()).toEqual([freezeRow()]);

        const session = sessionRow();
        await store.putSessionRow(session);
        session.conversationIds.push('c-9');
        (await store.sessionRow('A', 'tutor', 's-1', '42', 'learner'))?.brainIds.push('b-9');
        for (const row of await store.sessionRowsOf('A', '42')) row.conversationIds.push('c-8');
        expect(await store.sessionRow('A', 'tutor', 's-1', '42', 'learner')).toEqual(sessionRow());
        expect(await store.sessionRowsOf('A', '42')).toEqual([sessionRow()]);
      }));

    it('reads an empty list of outcomes, lessons and skills for a learner that has none', () =>
      withStore(async (store) => {
        for (const table of ['outcomes', 'lessons', 'skills'] as const) {
          expect(await store.learnerDocs(table, 'A', 'tutor', '42')).toEqual([]);
        }
      }));
  });
}
