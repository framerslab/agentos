/**
 * @module guardrails/ModerationContext
 *
 * Where a piece of content appears and who wrote it, as ids and words a guard can read. The moderation entry points
 * check the fields before any guard runs: the ids become limiter keys and audit keys, so none may hold a separator, a
 * space or a sentence.
 */

/** Well-known surfaces. A host may name its own; any value must be a word (letters, digits, `_ . : -`, at most 64). */
export type ModerationSurface =
  | 'public_room' | 'private_chat' | 'group_chat' | 'discussion_page'
  | 'agent_turn' | 'generated_media' | 'upload' | 'report_evidence';

export interface ModerationContext {
  surface: ModerationSurface | (string & {});
  /** The place the content appears in: a room, a thread, a page. */
  roomId?: string;
  /** The place's content rating, in the host's own words (`safe`, `standard`, ...). A word. */
  rating?: string;
  /** The content's own id in the host's store. */
  messageId?: string;
  /** Who wrote the content, when that is not the `userId` the call runs for. */
  sender?: { id: string; kind?: 'account' | 'guest' | 'agent' };
}

const WORD = /^[A-Za-z0-9_.:-]{1,64}$/;
const ID = /^[A-Za-z0-9_.:/-]{1,128}$/;
const SENDER_KINDS: ReadonlySet<string> = new Set(['account', 'guest', 'agent']);

/** Whether a value is an id: 1 to 128 characters of letters, digits and `_ . : / -`. */
export function isModerationId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

/**
 * Throws a TypeError naming the field (never its value) when a field is not a word or an id.
 *
 * @param value - The `moderation` field of a guard context.
 * @throws TypeError naming the first field that does not fit.
 */
export function assertModerationContext(value: unknown): asserts value is ModerationContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('context.moderation must be an object');
  const fields = value as Record<string, unknown>;
  const word = (name: string, field: unknown, required: boolean): void => {
    if (field === undefined && !required) return;
    if (typeof field !== 'string' || !WORD.test(field)) throw new TypeError(`context.moderation.${name} must be a word: letters, digits and _ . : - (at most 64)`);
  };
  const id = (name: string, field: unknown, required: boolean): void => {
    if (field === undefined && !required) return;
    if (!isModerationId(field)) throw new TypeError(`context.moderation.${name} must be an id: letters, digits and _ . : / - (at most 128)`);
  };
  word('surface', fields.surface, true);
  id('roomId', fields.roomId, false);
  word('rating', fields.rating, false);
  id('messageId', fields.messageId, false);
  if (fields.sender !== undefined) {
    if (typeof fields.sender !== 'object' || fields.sender === null || Array.isArray(fields.sender)) throw new TypeError('context.moderation.sender must be an object');
    const sender = fields.sender as Record<string, unknown>;
    id('sender.id', sender.id, true);
    if (sender.kind !== undefined && !(typeof sender.kind === 'string' && SENDER_KINDS.has(sender.kind))) throw new TypeError('context.moderation.sender.kind must be account, guest or agent');
  }
}
