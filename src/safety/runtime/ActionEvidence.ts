/**
 * @module safety/runtime/ActionEvidence
 *
 * The evidence a governed tool call carries, and the check that holds it to the host's own store: the quoted messages
 * exist, the account the action is about wrote them, each quote is in its message character for character, and the
 * rule and the verdicts cited are ones the host holds. It proves a quote and its author. It does not prove the rule
 * applies.
 */
import { createHash } from 'node:crypto';
import type { JSONSchemaObject } from '../../core/tools/ITool.js';
import { isModerationId } from '../guardrails/ModerationContext.js';

/** One quoted message: its id in the host's store, and the words quoted from it. */
export interface ActionEvidenceQuote {
  messageId: string;
  quote: string;
}

/** What every governed call carries, under the argument name `evidence`. */
export interface ActionEvidence {
  /** The account the action is about: the author of every quoted message. */
  targetId: string;
  /** The room the quoted messages are in. */
  roomId?: string;
  /** The rule the action rests on, and the version of the policy text it was read from. */
  ruleId: string;
  policyVersion: string;
  quotes: ActionEvidenceQuote[];
  /** The host's ids of the guard verdicts that led here. */
  verdictRefs?: string[];
}

/** A message as the host's store holds it. */
export interface StoredMessage {
  id: string;
  authorId: string;
  roomId?: string;
  text: string;
}

/**
 * The host's own store. `getMessage` answers null when no such message exists; `hasVerdict` confirms a verdict id the
 * host keeps, and without it no evidence may cite one.
 */
export interface EvidenceSource {
  getMessage(messageId: string): Promise<StoredMessage | null>;
  hasVerdict?(verdictRef: string): Promise<boolean>;
}

/** The policy versions an actor may cite, each with its rule ids: the host's private configuration. */
export type RuleBook = Readonly<Record<string, readonly string[]>>;

/** Why evidence did not hold. */
export type EvidenceFailure =
  | 'NO_QUOTES' | 'QUOTE_TOO_SHORT' | 'MESSAGE_NOT_FOUND' | 'AUTHOR_MISMATCH'
  | 'ROOM_MISMATCH' | 'QUOTE_MISMATCH' | 'SOURCE_UNAVAILABLE'
  | 'UNKNOWN_POLICY_VERSION' | 'UNKNOWN_RULE' | 'VERDICT_NOT_FOUND';

/** How much evidence a call needs: quotes from at least `minQuotes` distinct messages (default 1, at most 20), each `minQuoteLength` code units or more (default 12) unless it quotes its message whole. */
export interface EvidenceRule {
  minQuotes?: number;
  minQuoteLength?: number;
}

/** The answer of {@link verifyActionEvidence}. */
export interface EvidenceCheck {
  ok: boolean;
  failure?: EvidenceFailure;
  /**
   * The index in `evidence.quotes` of the quote that failed: a number, so a message id the model made up and the
   * store does not know is never handed back as a string a host might log.
   */
  failedQuoteIndex?: number;
  /** What an audit record keeps of each quote: never the quote. */
  quotes: Array<{ messageId: string; quoteSha256: string; quoteLength: number }>;
}

const ID_FIELD = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.:/-]+$' } as const;
/** The most quotes one call may carry: each one is a read of the host's store. */
const MAX_QUOTES = 20;
/** The longest quote, in code units. */
const MAX_QUOTE_LENGTH = 4000;

/** JSON Schema (draft-07) of {@link ActionEvidence}, merged into a governed tool's input schema. */
export const ACTION_EVIDENCE_SCHEMA: JSONSchemaObject = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['targetId', 'ruleId', 'policyVersion', 'quotes'],
  properties: {
    targetId: { ...ID_FIELD, description: 'The account the action is about: the author of every quoted message.' },
    roomId: { ...ID_FIELD, description: 'The room the quoted messages are in.' },
    ruleId: { ...ID_FIELD, description: 'The rule the action rests on.' },
    policyVersion: { ...ID_FIELD, description: 'The version of the policy text the rule was read from.' },
    quotes: {
      type: 'array',
      description: 'The messages the action rests on, each quoted exactly as it was written.',
      maxItems: MAX_QUOTES,
      items: {
        type: 'object', additionalProperties: false, required: ['messageId', 'quote'],
        properties: { messageId: { ...ID_FIELD }, quote: { type: 'string', minLength: 1, maxLength: MAX_QUOTE_LENGTH } },
      },
    },
    verdictRefs: { type: 'array', description: 'The ids of the guard verdicts that led here.', items: { ...ID_FIELD } },
  },
});

/**
 * Whether a value has the shape of {@link ActionEvidence}, every id in it an id (letters, digits and `_ . : / -`, at
 * most 128), with at most 20 quotes of at most 4,000 code units each.
 *
 * @internal Read by the governed tool before anything else; not exported from the folder's index.
 */
export function isActionEvidence(value: unknown): value is ActionEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  if (!isModerationId(evidence.targetId) || !isModerationId(evidence.ruleId) || !isModerationId(evidence.policyVersion)) return false;
  if (evidence.roomId !== undefined && !isModerationId(evidence.roomId)) return false;
  if (!Array.isArray(evidence.quotes) || evidence.quotes.length > MAX_QUOTES) return false;
  for (const entry of evidence.quotes) {
    if (typeof entry !== 'object' || entry === null) return false;
    const quote = entry as Record<string, unknown>;
    if (!isModerationId(quote.messageId) || typeof quote.quote !== 'string' || quote.quote.length > MAX_QUOTE_LENGTH) return false;
  }
  return evidence.verdictRefs === undefined || (Array.isArray(evidence.verdictRefs) && evidence.verdictRefs.every((ref) => isModerationId(ref)));
}

/**
 * Rejects evidence thresholds that could disable a comparison, including NaN, and a `minQuotes` above the 20 quotes
 * a call may carry, which no call could meet.
 * @internal Shared with the governed wrapper's policy check; not exported from the folder's index.
 */
export function assertEvidenceRule(rule: EvidenceRule = {}): void {
  for (const value of [rule.minQuotes, rule.minQuoteLength]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new TypeError('Evidence thresholds must be positive safe integers.');
    }
  }
  if (rule.minQuotes !== undefined && rule.minQuotes > MAX_QUOTES) {
    throw new TypeError(`minQuotes must be at most ${MAX_QUOTES}.`);
  }
}

/**
 * Holds evidence to the host's store and rule book. Every comparison is exact: no trimming, no case folding, no
 * Unicode normalisation. The answer keeps a hash and a length of each quote, never the quote, and names a failed
 * quote by its index, never by an id the store did not confirm.
 *
 * @param evidence - The evidence, already of the right shape.
 * @param source - The host's store.
 * @param ruleBook - The policy versions a call may cite, each with its rule ids.
 * @param rule - `minQuotes` (default 1) and `minQuoteLength` in code units (default 12).
 * @returns Whether the evidence holds, and why not when it does not.
 * @throws TypeError when an evidence threshold is not a positive safe integer, or `minQuotes` is over 20, and when the
 * evidence carries more than 20 quotes or a quote over 4,000 code units, before the store is read.
 */
export async function verifyActionEvidence(evidence: ActionEvidence, source: EvidenceSource, ruleBook: RuleBook, rule: EvidenceRule = {}): Promise<EvidenceCheck> {
  assertEvidenceRule(rule);
  // Each quote is a read of the host's store: a caller that skipped the shape check is held to the same caps.
  const given: unknown = evidence?.quotes;
  if (Array.isArray(given) && (given.length > MAX_QUOTES || given.some((item) => typeof item?.quote === 'string' && item.quote.length > MAX_QUOTE_LENGTH))) {
    throw new TypeError(`Evidence may carry at most ${MAX_QUOTES} quotes of at most ${MAX_QUOTE_LENGTH} code units each.`);
  }
  // A host can retain and change the input while its store is answering. Check one snapshot throughout.
  evidence = structuredClone(evidence);
  const minQuotes = rule.minQuotes ?? 1;
  const minQuoteLength = rule.minQuoteLength ?? 12;
  const fail = (failure: EvidenceFailure, failedQuoteIndex?: number): EvidenceCheck =>
    ({ ok: false, failure, ...(failedQuoteIndex !== undefined ? { failedQuoteIndex } : {}), quotes: [] });

  // the rule book: an own key and a listed id, compared exactly, so a rule id copied from a message is refused
  if (!Object.prototype.hasOwnProperty.call(ruleBook, evidence.policyVersion)) return fail('UNKNOWN_POLICY_VERSION');
  const rules = ruleBook[evidence.policyVersion];
  if (!Array.isArray(rules) || !rules.includes(evidence.ruleId)) return fail('UNKNOWN_RULE');

  for (const ref of evidence.verdictRefs ?? []) {
    if (typeof source.hasVerdict !== 'function') return fail('VERDICT_NOT_FOUND');
    let known: boolean;
    try {
      known = (await source.hasVerdict(ref)) === true;
    } catch {
      return fail('SOURCE_UNAVAILABLE');
    }
    if (!known) return fail('VERDICT_NOT_FOUND');
  }

  // quotes count by the messages they come from: one message quoted twice is one quote
  if (new Set(evidence.quotes.map((item) => item.messageId)).size < minQuotes) return fail('NO_QUOTES');
  const quotes: EvidenceCheck['quotes'] = [];
  for (const [index, item] of evidence.quotes.entries()) {
    let stored: StoredMessage | null | undefined;
    try {
      stored = await source.getMessage(item.messageId);
    } catch {
      return fail('SOURCE_UNAVAILABLE', index);
    }
    // a store that matches ids loosely answers a message under another id: not the message asked for
    if (stored === null || stored === undefined || stored.id !== item.messageId) return fail('MESSAGE_NOT_FOUND', index);
    if (stored.authorId !== evidence.targetId) return fail('AUTHOR_MISMATCH', index);
    if (evidence.roomId !== undefined && stored.roomId !== evidence.roomId) return fail('ROOM_MISMATCH', index);
    if (typeof stored.text !== 'string' || item.quote.length === 0 || !stored.text.includes(item.quote)) return fail('QUOTE_MISMATCH', index);
    if (item.quote.length < minQuoteLength && item.quote !== stored.text) return fail('QUOTE_TOO_SHORT', index);
    quotes.push({ messageId: stored.id, quoteSha256: createHash('sha256').update(item.quote, 'utf8').digest('hex'), quoteLength: item.quote.length });
  }
  return { ok: true, quotes };
}
