/**
 * @fileoverview How `parseJsonSafe()` of both utility classes reads a model's reply: as it is, else from inside the
 * Markdown code fence the reply is or holds. A model asked for JSON alone often answers inside one, with a `json` tag
 * or none, and sometimes with words before or after it.
 */

/** The backticks that open and close a Markdown code fence. */
const FENCE = '```';

/** A language tag alone on a fence's opening line, such as `json` or `JSON`, or nothing. */
const LANGUAGE_TAG = /^[\w+.-]*$/;

/**
 * The texts a reply holds inside a code fence, trimmed and each once: inside the fence the whole reply is, up to its
 * last backticks, so a value that holds backticks of its own stays whole; then inside the first fence the reply
 * holds, with words before or after it. A language tag alone on the opening line is left out; any other text there
 * is read as the start of the JSON. Found with `indexOf`, so the time a reply takes grows with its length alone, also
 * for a reply that opens a fence and never closes it.
 */
function fencedTexts(text: string): string[] {
  const reply = text.trim();
  const open = reply.indexOf(FENCE);
  if (open === -1) return [];
  let start = open + FENCE.length;
  const lineEnd = reply.indexOf('\n', start);
  if (lineEnd !== -1 && LANGUAGE_TAG.test(reply.slice(start, lineEnd).trim())) start = lineEnd + 1;
  const texts: string[] = [];
  const last = reply.length - FENCE.length;
  if (open === 0 && last >= start && reply.endsWith(FENCE)) texts.push(reply.slice(start, last).trim());
  const close = reply.indexOf(FENCE, start);
  if (close !== -1) {
    const inside = reply.slice(start, close).trim();
    if (!texts.includes(inside)) texts.push(inside);
  }
  return texts;
}

/**
 * `JSON.parse` of a model's reply: the reply as it is, else the text inside the Markdown code fence the whole reply
 * is, else inside the first code fence the reply holds, with a language tag such as `json` or none and with words
 * before or after it, trimmed. A reply that parses as it is reads as `JSON.parse` reads it, so a fence inside one of
 * its strings stays in that string.
 *
 * @param text - The reply.
 * @returns The value the reply holds.
 * @throws {SyntaxError} The reply's own parse error, when neither the reply nor a text inside a fence parses.
 */
export function parseReplyJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (typeof text === 'string') {
      for (const inside of fencedTexts(text)) {
        try {
          return JSON.parse(inside);
        } catch {
          // The next text inside a fence, when there is one.
        }
      }
    }
    throw error;
  }
}
