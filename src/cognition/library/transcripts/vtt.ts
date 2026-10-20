/**
 * @fileoverview WebVTT (`.vtt`): a `WEBVTT` first line and its header, then blocks apart by blank lines, a cue being
 * an optional identifier line, a timing line and its text. A cue's speaker is its voice span, `<v Name>`; a file with
 * no voice span anywhere, as a tool writes that puts the name into the cue's text, is read by the shared `Name: `
 * rule.
 * @module agentos/cognition/library/transcripts/vtt
 */

import { blocksOf, cueTimes, cuesOf, finish, namedSegments, squash, type Segment } from './shared.js';
import { TranscriptReadError, type ReadTranscript } from './types.js';

/** The first line: `WEBVTT`, alone or followed by a space or a tab and any text. */
const SIGNATURE = /^WEBVTT(?:[ \t\n]|$)/;

/** A tag of a cue's text: a start or end tag named by a letter, or a timestamp tag. */
const TAG = /<\/?[a-z0-9][^<>]*>/gi;

/** A voice span's start tag, `<v Name>` or `<v.class Name>`: what follows the tag's name and classes is its speaker. */
const VOICE_START = /^<v(?:\.[^\s<>]*)?(?:\s+([^<>]*))?>$/i;

/** A voice span's end tag. */
const VOICE_END = /^<\/v\s*>$/i;

/** The character references decoded by name. */
const NAMED_REFERENCES = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', '\u00a0'],
  ['lrm', '\u200e'],
  ['rlm', '\u200f'],
]);

/**
 * A cue text's character references decoded once: the named ones above and every numeric one. A reference this
 * reader does not know, or a number that names no character, stays as written.
 */
export function decodeReferences(text: string): string {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      const named = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return named ? String.fromCodePoint(code) : whole;
    }
    return NAMED_REFERENCES.get(body) ?? whole;
  });
}

/** A cue's text cut at its voice spans: each part's words, and its speaker when a voice span holds it. */
function voiceParts(cueText: string): { parts: Array<{ label: string | null; text: string }>; voiced: boolean } {
  const parts: Array<{ label: string | null; text: string }> = [];
  let voiced = false;
  let label: string | null = null;
  let words = '';
  const close = (): void => {
    const text = squash(words);
    if (text.length > 0) parts.push({ label, text });
    words = '';
  };
  let from = 0;
  for (const match of cueText.matchAll(TAG)) {
    const at = match.index ?? 0;
    words += decodeReferences(cueText.slice(from, at));
    from = at + match[0].length;
    const voice = VOICE_START.exec(match[0]);
    if (voice !== null) {
      close();
      voiced = true;
      label = squash(decodeReferences(voice[1] ?? '')) || null;
    } else if (VOICE_END.test(match[0])) {
      close();
      label = null;
    }
    // Any other tag (a class, italics, bold, underline, ruby, language or timestamp tag) is removed with its words kept.
  }
  words += decodeReferences(cueText.slice(from));
  close();
  return { parts, voiced };
}

/**
 * Reads WebVTT. The header (the first line and the lines after it up to a blank line or the first timing line) and
 * every block that is no cue (a `NOTE`, `STYLE` or `REGION` block) are left out. Cues are cut as WebVTT's parser cuts
 * them, so cues written with no blank line before them read as cues. A cue's settings are ignored, and its text's lines
 * are joined with spaces. Its markup is removed and its character references decoded. Two voice spans in one cue are
 * two turns with the cue's times.
 *
 * @param text - The file's text, its line ends already line feeds and its byte order mark dropped.
 * @throws {@link TranscriptReadError} when the first line is not `WEBVTT`.
 */
export function readVtt(text: string): ReadTranscript {
  if (!SIGNATURE.test(text)) throw new TranscriptReadError('vtt', 'the first line is not WEBVTT');
  const lines = text.split('\n');
  let start = 1;
  while (start < lines.length && lines[start].trim() !== '' && cueTimes(lines[start]) === null) start += 1;
  const segments: Segment[] = [];
  let voiced = false;
  for (const cue of cuesOf(blocksOf(lines.slice(start).join('\n')), false)) {
    const parts = voiceParts(cue.lines.join('\n'));
    if (parts.voiced) voiced = true;
    for (const part of parts.parts) segments.push({ startMs: cue.startMs, endMs: cue.endMs, text: part.text, label: part.label });
  }
  return finish('vtt', voiced ? segments : namedSegments(segments));
}
