/**
 * The session events table of `docs/features/VOICE_PIPELINE.md`, read against the code: every name of
 * `VOICE_SESSION_EVENT_NAMES` has one row in the table under "Session events", and the table has no other row. The
 * browser entry carries the same names.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VOICE_SESSION_EVENT_NAMES } from '../types.js';
import { VOICE_SESSION_EVENT_NAMES as BROWSER_EVENT_NAMES } from '../browser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = path.resolve(here, '../../../../docs/features/VOICE_PIPELINE.md');

/**
 * The event names of the first table under `heading`: the first cell of each row after the header and its separator,
 * without the backticks around it.
 *
 * @param markdown - The page.
 * @param heading - The heading's line, as written.
 * @returns The names, in the table's order.
 */
function tableNames(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  expect(start, `the page has the heading ${heading}`).toBeGreaterThanOrEqual(0);
  const rows: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6} /.test(line)) break;
    if (line.trim().startsWith('|')) rows.push(line.trim());
    else if (rows.length > 0) break;
  }
  // The header row and the separator row come first.
  return rows.slice(2).map((row) => row.split('|')[1]!.trim().replace(/^`|`$/g, ''));
}

describe('the session events table of the voice pipeline page', () => {
  it('has one row for every session event, and no other row', () => {
    const names = tableNames(readFileSync(page, 'utf8'), '### Session events');
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...VOICE_SESSION_EVENT_NAMES].sort());
  });

  it('lists the events of VoiceSessionEventMap once each, and the browser entry carries the same list', () => {
    expect(VOICE_SESSION_EVENT_NAMES).toEqual([
      'agent_state_changed',
      'user_state_changed',
      'user_input_transcribed',
      'conversation_item_added',
      'speech_created',
      'barge_in',
      'error',
      'session_error',
      'close',
      'state_change',
      'turn_complete',
    ]);
    expect(Object.isFrozen(VOICE_SESSION_EVENT_NAMES)).toBe(true);
    expect(BROWSER_EVENT_NAMES).toBe(VOICE_SESSION_EVENT_NAMES);
  });
});
