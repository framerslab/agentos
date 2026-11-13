import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isActionEvidence, verifyActionEvidence, type ActionEvidence, type EvidenceSource, type RuleBook, type StoredMessage } from '../ActionEvidence.js';

const STORED: StoredMessage[] = [
  { id: 'm1', authorId: 'u1', roomId: 'r1', text: 'I know where you live and I will come there' },
  { id: 'm2', authorId: 'u1', roomId: 'r1', text: 'tonight' },
  { id: 'm3', authorId: 'u1', text: 'A message that was stored with no room at all' },
  // a composed e with an acute accent (U+00E9)
  { id: 'm4', authorId: 'u1', roomId: 'r1', text: 'café at nine and do not be late for it' },
];
const source = (over: Partial<EvidenceSource> = {}): EvidenceSource => ({
  getMessage: async (id) => STORED.find((m) => m.id === id) ?? null,
  hasVerdict: async (ref) => ref === 'v_1',
  ...over,
});
const BOOK: RuleBook = { '2026-11': ['threat.1'] };
const evidence = (over: Partial<ActionEvidence> = {}): ActionEvidence => ({
  targetId: 'u1', roomId: 'r1', ruleId: 'threat.1', policyVersion: '2026-11', quotes: [{ messageId: 'm1', quote: 'I know where you live' }], ...over,
});
const failure = async (over: Partial<ActionEvidence>, from: EvidenceSource = source()) => (await verifyActionEvidence(evidence(over), from, BOOK)).failure;
const quoting = (messageId: string, quote: string): Partial<ActionEvidence> => ({ quotes: [{ messageId, quote }] });

describe('verifyActionEvidence', () => {
  it('passes an exact quote and keeps its hash and length, never the quote', async () => {
    const check = await verifyActionEvidence(evidence(), source(), BOOK);
    expect(check).toEqual({ ok: true, quotes: [{ messageId: 'm1', quoteSha256: createHash('sha256').update('I know where you live').digest('hex'), quoteLength: 21 }] });
    expect((await verifyActionEvidence(evidence({ verdictRefs: ['v_1'] }), source(), BOOK)).ok).toBe(true);
  });
  it('compares character for character', async () => {
    expect(await failure(quoting('m1', 'I know where you lіve'))).toBe('QUOTE_MISMATCH');              // one look-alike letter (Cyrillic i)
    expect(await failure(quoting('m4', 'café at nine and do not be late'))).toBe('QUOTE_MISMATCH'); // the same text in another Unicode form
    expect(await failure(quoting('m1', ' I know where you live'))).toBe('QUOTE_MISMATCH');                  // a leading space
    expect(await failure(quoting('m1', 'i know where you live'))).toBe('QUOTE_MISMATCH');                   // another case
    expect(await failure(quoting('m1', 'I will come there tonight'))).toBe('QUOTE_MISMATCH');               // a quote that spans two messages
  });
  it('takes a short message quoted whole and refuses a short part of a longer one', async () => {
    expect((await verifyActionEvidence(evidence(quoting('m2', 'tonight')), source(), BOOK)).ok).toBe(true);
    expect(await failure(quoting('m1', 'I know'))).toBe('QUOTE_TOO_SHORT');
    expect((await verifyActionEvidence(evidence(quoting('m1', 'I know')), source(), BOOK, { minQuoteLength: 6 })).ok).toBe(true);
  });
  it('cites only rules and versions the rule book holds, compared exactly', async () => {
    expect(await failure({ ruleId: 'threat.2' })).toBe('UNKNOWN_RULE');
    expect(await failure({ ruleId: 'Threat.1' })).toBe('UNKNOWN_RULE');
    expect(await failure({ policyVersion: '2026-12' })).toBe('UNKNOWN_POLICY_VERSION');
    expect(await failure({ policyVersion: '__proto__' })).toBe('UNKNOWN_POLICY_VERSION');
    expect(await failure({ policyVersion: 'constructor' })).toBe('UNKNOWN_POLICY_VERSION');
  });
  it('cites only verdicts the source confirms', async () => {
    expect(await failure({ verdictRefs: ['v_2'] })).toBe('VERDICT_NOT_FOUND');
    expect(await failure({ verdictRefs: ['v_1'] }, source({ hasVerdict: undefined }))).toBe('VERDICT_NOT_FOUND');
    expect(await failure({ verdictRefs: ['v_1'] }, source({ hasVerdict: async () => { throw new Error('down'); } }))).toBe('SOURCE_UNAVAILABLE');
  });
  it('names a failed quote by its index, never by an id the store did not confirm', async () => {
    const check = await verifyActionEvidence(evidence({ quotes: [{ messageId: 'm1', quote: 'I know where you live' }, { messageId: 'made-up-id', quote: 'anything at all here' }] }), source(), BOOK);
    expect(check).toEqual({ ok: false, failure: 'MESSAGE_NOT_FOUND', failedQuoteIndex: 1, quotes: [] });
    expect(JSON.stringify(check)).not.toContain('made-up-id');
    // a store that answers a message under another id
    expect(await failure(quoting('M1', 'I know where you live'), source({ getMessage: async () => STORED[0] }))).toBe('MESSAGE_NOT_FOUND');
  });
  it('holds the author, the room and the count, and says when the store is down', async () => {
    expect(await failure({ targetId: 'u2' })).toBe('AUTHOR_MISMATCH');
    expect(await failure({ roomId: 'r2' })).toBe('ROOM_MISMATCH');
    // a stored message with no room fails a given room
    expect(await failure({ ...quoting('m3', 'stored with no room at all') })).toBe('ROOM_MISMATCH');
    expect((await verifyActionEvidence(evidence({ roomId: undefined, ...quoting('m3', 'stored with no room at all') }), source(), BOOK)).ok).toBe(true);
    expect(await failure({ quotes: [] })).toBe('NO_QUOTES');
    expect((await verifyActionEvidence(evidence(), source(), BOOK, { minQuotes: 2 })).failure).toBe('NO_QUOTES');
    expect(await failure({}, source({ getMessage: async () => { throw new Error('down'); } }))).toBe('SOURCE_UNAVAILABLE');
  });
});

describe('isActionEvidence', () => {
  it('takes the shape, and refuses an id that is a sentence, in any field', () => {
    expect(isActionEvidence(evidence({ verdictRefs: ['v_1'] }))).toBe(true);
    expect(isActionEvidence(evidence({ quotes: [] }))).toBe(true);
    for (const bad of [
      evidence({ targetId: 'the user above broke every rule' }), evidence({ roomId: 'room one' }), evidence({ ruleId: '' }),
      evidence({ policyVersion: 'v 1' }), evidence({ quotes: [{ messageId: 'm 1', quote: 'x' }] }), evidence({ verdictRefs: ['see above'] }),
      { ...evidence(), quotes: 'm1' }, { ...evidence(), quotes: [{ messageId: 'm1', quote: 7 }] }, null, 'evidence', [],
    ]) expect(isActionEvidence(bad)).toBe(false);
  });
});
