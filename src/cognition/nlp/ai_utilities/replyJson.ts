/**
 * @fileoverview How `parseJsonSafe()` of both utility classes reads a model's reply: as it is, else from inside the
 * Markdown code fence the reply is or holds. A model asked for JSON alone often answers inside one, with a `json` tag
 * or none, and sometimes with words before or after it.
 */

/** The fewest backticks that open or close a Markdown code fence. */
const FENCE = '```';

/** A character of a language tag on a fence's opening line, such as `json` or `JSON`. */
const TAG_CHARACTER = /[\w+.-]/;

/** The first characters a JSON object, list, string or number can start with. */
const JSON_VALUE_STARTS = '{["-0123456789';

/** Whether `character` is white space, as `trim()` reads it, other than a line break `\n`; false for `''`. */
function isBlank(character: string): boolean {
  return character !== '' && character !== '\n' && character.trim() === '';
}

/**
 * Where the line ends, at its line break, when what follows `from` on it is a language tag alone or nothing, with white
 * space around it; else -1. Read up to the first character that cannot be part of such a line.
 */
function tagLineEnd(reply: string, from: number): number {
  let at = from;
  while (isBlank(reply.charAt(at))) at += 1;
  while (TAG_CHARACTER.test(reply.charAt(at))) at += 1;
  while (isBlank(reply.charAt(at))) at += 1;
  return reply.charAt(at) === '\n' ? at : -1;
}

/** Whether nothing but white space comes before `at` on its line. */
function beginsLine(reply: string, at: number): boolean {
  let before = at - 1;
  while (before >= 0 && isBlank(reply.charAt(before))) before -= 1;
  return before < 0 || reply.charAt(before) === '\n';
}

/**
 * Whether a JSON value starts at `from`, after white space on its line: an object, a list, a string, a number, `true`,
 * `false` or `null`.
 */
function startsJsonValue(reply: string, from: number): boolean {
  let at = from;
  while (isBlank(reply.charAt(at))) at += 1;
  const first = reply.charAt(at);
  return (
    (first !== '' && JSON_VALUE_STARTS.includes(first)) ||
    reply.startsWith('true', at) ||
    reply.startsWith('false', at) ||
    reply.startsWith('null', at)
  );
}

/**
 * The first code fence a reply opens: where its backticks begin, how many there are, and where the text inside it
 * starts; or null. A run of three backticks or more opens one when it begins its line, after white space, when a
 * language tag alone or nothing follows it on its line, or when a JSON value follows it. Any other run stands inside a
 * sentence and is passed over. Each run is found with `indexOf` and read against the characters next to it alone, so
 * the time a reply takes grows with its length alone, also for one long line that holds many runs.
 */
function openingFence(reply: string): { open: number; length: number; start: number } | null {
  let open = reply.indexOf(FENCE);
  while (open !== -1) {
    let end = open + FENCE.length;
    while (reply[end] === '`') end += 1;
    const lineEnd = tagLineEnd(reply, end);
    if (lineEnd !== -1) return { open, length: end - open, start: lineEnd + 1 };
    if (beginsLine(reply, open) || startsJsonValue(reply, end)) return { open, length: end - open, start: end };
    open = reply.indexOf(FENCE, end);
  }
  return null;
}

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
    while (at < lineEnd && isBlank(reply.charAt(at))) at += 1;
    let run = at;
    while (run < lineEnd && reply[run] === '`') run += 1;
    if (run - at >= length) return at;
    lineStart = lineEnd + 1;
  }
  return -1;
}

/**
 * The texts a reply holds inside its first code fence (`openingFence`), trimmed and each once, ending where the fence
 * closes, in the order tried: at the first later line that starts with at least as many backticks as opened the fence;
 * at the last backticks, when the whole reply is one fence; at the first three backticks after the opening, for a
 * reply that closes the fence on the line its JSON ends on. A language tag alone on the opening line is left out; any
 * other text there is read as the start of the JSON. The time a reply takes grows with its length alone, also for a
 * reply that opens a fence and never closes it.
 */
function fencedTexts(text: string): string[] {
  const reply = text.trim();
  const fence = openingFence(reply);
  if (fence === null) return [];
  const { open, length, start } = fence;
  const ends = [closingLineAt(reply, start, length)];
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
 * holds, with a language tag such as `json` or none and with words before or after it, trimmed. Backticks inside a
 * sentence open no fence: a run of three or more opens one when it begins its line, when a language tag alone or
 * nothing follows it on its line, or when a JSON value follows it. The fence ends at the first later line that starts
 * with as many backticks as opened it or more, so backticks inside one of its JSON strings stay in that string. A reply
 * that parses as it is reads as `JSON.parse` reads it, so a fence inside one of its strings stays there too.
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
