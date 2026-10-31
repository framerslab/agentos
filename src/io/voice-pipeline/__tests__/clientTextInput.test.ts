/**
 * The text input message's check. A user who types sends `{ type: 'text_input', text }` in place of speech, and the
 * server reads it as untrusted input: `isClientTextInputMessage()` accepts a text of 1 to 4,000 characters that holds
 * a character besides whitespace, and refuses every other value.
 */

import { describe, it, expect } from 'vitest';
import { isClientTextInputMessage, MAX_TEXT_INPUT_LENGTH } from '../clientTextInput.js';

describe('isClientTextInputMessage', () => {
  it('accepts a text of 1 to 4,000 characters', () => {
    expect(MAX_TEXT_INPUT_LENGTH).toBe(4_000);
    expect(isClientTextInputMessage({ type: 'text_input', text: 'hi' })).toBe(true);
    expect(isClientTextInputMessage({ type: 'text_input', text: 'x'.repeat(4_000) })).toBe(true);
  });

  it.each<[string, unknown]>([
    ['a non-object', 'text_input'],
    ['null', null],
    ['an array', [{ type: 'text_input', text: 'hi' }]],
    ['another type', { type: 'transcript', text: 'hi' }],
    ['a non-string text', { type: 'text_input', text: 42 }],
    ['an empty text', { type: 'text_input', text: '' }],
    ['whitespace alone', { type: 'text_input', text: ' \n\t ' }],
    ['4,001 characters', { type: 'text_input', text: 'x'.repeat(4_001) }],
  ])('refuses %s', (_name, value) => {
    expect(isClientTextInputMessage(value)).toBe(false);
  });
});
