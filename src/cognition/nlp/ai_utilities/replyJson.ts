/**
 * @fileoverview How `parseJsonSafe()` of both utility classes reads a model's reply: as it is, else from inside the
 * Markdown code fence the reply is or holds. A model asked for JSON alone often answers inside one, with a `json` tag
 * or none, and sometimes with words before or after it.
 */

/** The fewest backticks that open or close a Markdown code fence. */
const FENCE = '```';

/** A language tag alone on a fence's opening line, such as `json` or `JSON`, or nothing. */
const LANGUAGE_TAG = /^[\w+.-]*$/;

/**
 * Where the backticks begin on the first line from `from` on that starts, after white space, with at least `length`
 * backticks, or -1: the line that closes a fence opened with `length` backticks, as CommonMark closes one, here also
 * with words after the backticks. No line of JSON starts with a backtick, since a JSON string holds no line break, so
 * backticks inside a string never close the fence. The lines are read in one pass.
 */
function closingLineAt(reply: string, from: number, length: number): number {
  let lineStart = from;
  while (lineStart <= reply.length) {
    const newline = reply.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? reply.length : newline;
    let at = lineStart;
    while (at < lineEnd && (reply[at] === ' ' || reply[at] === '\t' || reply[at] === '\r')) at += 1;
    let run = at;
    while (run < lineEnd && reply[run] === '`') run += 1;
    if (run - at >= length) return at;
    lineStart = lineEnd + 1;
  }
  return -1;
}

/**
 * The texts a reply holds inside its first code fence, trimmed and each once, ending where the fence closes, in the
 * order tried: at the first later line that starts with at least as many backticks as opened the fence; at the last
 * backticks, when the whole reply is one fence; at the first three backticks after the opening, for a reply that
 * closes the fence on the line its JSON ends on. The opening backticks are read whole, and a language tag alone on
 * the opening line is left out; any other text there is read as the start of the JSON. Found with `indexOf` and one
 * pass over the lines, so the time a reply takes grows with its length alone, also for a reply that opens a fence and
 * never closes it.
 */
function fencedTexts(text: string): string[] {
  const reply = text.trim();
  const open = reply.indexOf(FENCE);
  if (open === -1) return [];
  let start = open + FENCE.length;
  while (reply[start] === '`') start += 1;
  const opening = start - open;
  const lineEnd = reply.indexOf('\n', start);
  if (lineEnd !== -1 && LANGUAGE_TAG.test(reply.slice(start, lineEnd).trim())) start = lineEnd + 1;
  const ends = [closingLineAt(reply, start, opening)];
  if (open === 0 && reply.endsWith(FENCE)) {
    let last = reply.length;
    while (last > start && reply[last - 1] === '`') last -= 1;
    ends.push(last);
  }
  ends.push(reply.indexOf(FENCE, start));
  const texts: string[] = [];
  for (const end of ends) {
    if (end < start) continue;
    const inside = reply.slice(start, end).trim();
    if (!texts.includes(inside)) texts.push(inside);
  }
  return texts;
}

/**
 * `JSON.parse` of a model's reply: the reply as it is, else the text inside the first Markdown code fence the reply
 * holds, with a language tag such as `json` or none and with words before or after it, trimmed. The fence ends at the
 * first later line that starts with as many backticks as opened it or more, so backticks inside one of its JSON
 * strings stay in that string. A reply that parses as it is reads as `JSON.parse` reads it, so a fence inside one of
 * its strings stays there too.
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
