import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { planEntries, sha256Hex, type PlanEntryInput, type PlannedEntry, type PlanRules } from '../browser.js';

const MB = 1_048_576;

const WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const SLIDES = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** What the nested archive holds: two Markdown files, one in a folder named as a Notion export names it, and a ZIP. */
const NESTED: PlanEntryInput[] = [
  { path: 'Inner One.md', size: 500 },
  { path: 'Area fedcba9876543210fedcba9876543210/Inner Two.md', size: 700 },
  { path: 'deeper.zip', size: 900 },
];

/** A caller's rules: its document types, its transcript and recording extensions, 10 MB for anything, and its opener. */
const RULES: PlanRules = {
  documentTypes: { '.md': 'text/markdown', '.txt': 'text/plain', '.pdf': 'application/pdf', '.docx': WORD, '.pptx': SLIDES },
  transcriptExtensions: ['.vtt', '.srt'],
  recordingExtensions: ['.m4a', '.mp3'],
  maxBytes: () => 10 * MB,
  openArchive: async (path) => (path === 'nested.zip' ? NESTED : []),
};

/** Twelve entries of a ZIP or a folder, as a caller lists them. The two agenda files hold the same two bytes. */
const ENTRIES: PlanEntryInput[] = [
  { path: 'notes/Plan 0123456789abcdef0123456789abcdef.md', size: 2_048 },
  { path: 'notes/Budget.pdf', size: 3 * MB },
  { path: 'notes/Team.docx', size: 40_000 },
  { path: 'notes/sub/Deck.pptx', size: 5 * MB },
  { path: 'calls/standup.vtt', size: 9_000 },
  { path: 'calls/voice.m4a', size: 8 * MB },
  { path: 'calls/weird.xyz', size: 10 },
  { path: 'nested.zip', size: 30_000 },
  { path: 'notes/Agenda.txt', size: 2 },
  { path: 'notes/Agenda copy.txt', size: 2 },
  { path: 'notes/Scan.pdf', size: 10 * MB + 1 },
  { path: '../outside.md', size: 100 },
];

/** One planned entry as a row: its path, the archive it came from, what it becomes, why not, its title, folder and type. */
function row(entry: PlannedEntry): Array<string | null> {
  return [entry.path, entry.within, entry.becomes, entry.reason, entry.title, entry.folder, entry.mediaType];
}

describe('planEntries', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says what each entry becomes, with its title, its folder, and a nested archive opened one level deep', async () => {
    const planned = await planEntries(ENTRIES, RULES);

    expect(planned.map(row)).toEqual([
      // A Notion export's trailing id is no part of a title.
      ['notes/Plan 0123456789abcdef0123456789abcdef.md', null, 'document', null, 'Plan', 'notes', 'text/markdown'],
      ['notes/Budget.pdf', null, 'document', null, 'Budget', 'notes', 'application/pdf'],
      ['notes/Team.docx', null, 'document', null, 'Team', 'notes', WORD],
      ['notes/sub/Deck.pptx', null, 'document', null, 'Deck', 'notes/sub', SLIDES],
      ['calls/standup.vtt', null, 'transcript', null, 'standup', 'calls', null],
      ['calls/voice.m4a', null, 'recording', null, 'voice', 'calls', null],
      ['calls/weird.xyz', null, 'skipped', 'type', 'weird', 'calls', null],
      // The nested archive's entries stand where it stood, under its name; a ZIP inside it is not opened.
      ['Inner One.md', 'nested.zip', 'document', null, 'Inner One', null, 'text/markdown'],
      ['Area fedcba9876543210fedcba9876543210/Inner Two.md', 'nested.zip', 'document', null, 'Inner Two', 'Area', 'text/markdown'],
      ['deeper.zip', 'nested.zip', 'skipped', 'nested', 'deeper', null, null],
      // Two copies of one text are planned alike: the plan reads no file, so a duplicate is the caller's to mark.
      ['notes/Agenda.txt', null, 'document', null, 'Agenda', 'notes', 'text/plain'],
      ['notes/Agenda copy.txt', null, 'document', null, 'Agenda copy', 'notes', 'text/plain'],
      ['notes/Scan.pdf', null, 'skipped', 'size', 'Scan', 'notes', null],
      ['../outside.md', null, 'skipped', 'path', 'outside', '..', null],
    ]);
  });

  it('hashes a text\'s UTF-8 bytes with SHA-256, so a caller finds two copies of one text', async () => {
    // The digest of the two bytes 0x61 0x0a, and FIPS 180-4's digests of "abc" and of nothing.
    expect(await sha256Hex('a\n')).toBe('87428fc522803d31065e7bce3cf03fe475096631e5e07bbd7a0fde60c4cf25c7');
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

    // Characters of two, three and four bytes are hashed as UTF-8, as Node's own hash reads a string.
    const text = 'Señor 张伟 said: 😀';
    expect(await sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));

    // The agenda and its copy hold these two bytes, so they share the digest above; one more byte is another text.
    expect(await sha256Hex('a\r\n')).not.toBe(await sha256Hex('a\n'));
  });

  it('answers the same digest where the platform has no crypto.subtle, as a page outside a secure context has none', async () => {
    const text = 'Señor 张伟 said: 😀';
    const withWebCrypto = await sha256Hex(text);

    vi.stubGlobal('crypto', {});
    expect(globalThis.crypto.subtle).toBeUndefined();
    expect(await sha256Hex(text)).toBe(withWebCrypto);
    expect(await sha256Hex('a\n')).toBe('87428fc522803d31065e7bce3cf03fe475096631e5e07bbd7a0fde60c4cf25c7');

    vi.stubGlobal('crypto', undefined);
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('skips what is past the caller\'s count, and an archive when the caller gives no opener', async () => {
    const planned = await planEntries(ENTRIES, { ...RULES, openArchive: undefined, maxEntries: 9 });

    expect(planned.map((entry) => [entry.path, entry.becomes, entry.reason])).toEqual([
      ['notes/Plan 0123456789abcdef0123456789abcdef.md', 'document', null],
      ['notes/Budget.pdf', 'document', null],
      ['notes/Team.docx', 'document', null],
      ['notes/sub/Deck.pptx', 'document', null],
      ['calls/standup.vtt', 'transcript', null],
      ['calls/voice.m4a', 'recording', null],
      ['calls/weird.xyz', 'skipped', 'type'],
      ['nested.zip', 'skipped', 'nested'],
      ['notes/Agenda.txt', 'document', null],
      // Nine are planned: the rest are counted out, before their type, size or path is read.
      ['notes/Agenda copy.txt', 'skipped', 'count'],
      ['notes/Scan.pdf', 'skipped', 'count'],
      ['../outside.md', 'skipped', 'count'],
    ]);

    // With the opener, a nested archive's entries count toward the same bound.
    const opened = await planEntries(ENTRIES, { ...RULES, maxEntries: 9 });
    expect(opened.map((entry) => entry.reason)).toEqual([null, null, null, null, null, null, 'type', null, null, 'count', 'count', 'count', 'count', 'count']);
  });

  it('skips a path on a drive, a size that is no byte count, and a nested archive past its bound without opening it', async () => {
    const asked: string[] = [];
    const planned = await planEntries(
      [
        { path: 'C:/outside.md', size: 100 },
        { path: 'c:outside.md', size: 100 },
        { path: 'notes/Unknown.md', size: Number.NaN },
        { path: 'notes/Negative.md', size: -1 },
        { path: 'notes/Endless.md', size: Number.POSITIVE_INFINITY },
        { path: 'big.zip', size: 10 * MB + 1 },
        { path: 'nested.zip', size: 10 * MB },
        { path: 'notes/Kept.md', size: 100 },
      ],
      {
        ...RULES,
        openArchive: async (path) => {
          asked.push(path);
          return [{ path: 'Inner.md', size: 500 }];
        },
      },
    );

    expect(planned.map((entry) => [entry.path, entry.within, entry.becomes, entry.reason])).toEqual([
      ['C:/outside.md', null, 'skipped', 'path'],
      ['c:outside.md', null, 'skipped', 'path'],
      ['notes/Unknown.md', null, 'skipped', 'size'],
      ['notes/Negative.md', null, 'skipped', 'size'],
      ['notes/Endless.md', null, 'skipped', 'size'],
      // A nested archive is bounded by maxBytes('archive') before it is opened, and one within the bound is opened.
      ['big.zip', null, 'skipped', 'size'],
      ['Inner.md', 'nested.zip', 'document', null],
      ['notes/Kept.md', null, 'document', null],
    ]);
    expect(asked).toEqual(['nested.zip']);
  });

  it('refuses a count or a bound that is not a number of 0 or more', async () => {
    await expect(planEntries(ENTRIES, { ...RULES, maxEntries: Number.NaN })).rejects.toThrow(RangeError);
    await expect(planEntries(ENTRIES, { ...RULES, maxEntries: -1 })).rejects.toThrow(RangeError);
    await expect(planEntries(ENTRIES, { ...RULES, maxBytes: () => Number.NaN })).rejects.toThrow(RangeError);
    await expect(planEntries(ENTRIES, { ...RULES, maxBytes: (kind) => (kind === 'recording' ? -1 : MB) })).rejects.toThrow(RangeError);
    // A count of 0 plans nothing, and a bound of 0 takes empty files alone.
    expect((await planEntries(ENTRIES, { ...RULES, maxEntries: 0 })).every((entry) => entry.reason === 'count')).toBe(true);
    const empty = await planEntries([{ path: 'a.md', size: 0 }, { path: 'b.md', size: 1 }], { ...RULES, maxBytes: () => 0 });
    expect(empty.map((entry) => entry.reason)).toEqual([null, 'size']);
  });

  it('refuses a count or a bound that is no number at all, though JavaScript compares it as one', async () => {
    // Compared as numbers, null is 0, a numeric text its number and true 1: a count of null would plan every entry, and
    // a bound of null would skip every file that holds a byte. A caller reading its rules from JSON can pass any of them.
    const noNumbers: unknown[] = [null, '5', true];
    for (const value of noNumbers) {
      const count = value as number;
      await expect(planEntries(ENTRIES, { ...RULES, maxEntries: count })).rejects.toThrow(RangeError);
      await expect(planEntries(ENTRIES, { ...RULES, maxBytes: () => count })).rejects.toThrow(RangeError);
      await expect(planEntries(ENTRIES, { ...RULES, maxBytes: (kind) => (kind === 'archive' ? count : MB) })).rejects.toThrow(RangeError);
    }
    await expect(planEntries(ENTRIES, { ...RULES, maxEntries: null as unknown as number })).rejects.toThrow(
      'planEntries: maxEntries must be a number of 0 or more, not null',
    );
    await expect(planEntries(ENTRIES, { ...RULES, maxBytes: () => '5' as unknown as number })).rejects.toThrow(
      `planEntries: maxBytes('document') must answer a number of 0 or more, not "5"`,
    );

    // Left out, the count is Infinity, and every entry is planned.
    expect(await planEntries(ENTRIES, { ...RULES, maxEntries: undefined })).toHaveLength(14);
  });

  it('names a count or a bound that is no number without running its own code, so the plan rejects with a RangeError', async () => {
    // An object becomes text through its own toString, which can throw; one made with no prototype has none to call.
    const throwing = {
      valueOf: (): number => 5,
      toString: (): string => {
        throw new Error('toString ran');
      },
    };
    for (const value of [throwing, Object.create(null) as object]) {
      const count = value as unknown as number;
      await expect(planEntries(ENTRIES, { ...RULES, maxEntries: count })).rejects.toThrow(RangeError);
      await expect(planEntries(ENTRIES, { ...RULES, maxEntries: count })).rejects.toThrow(
        'planEntries: maxEntries must be a number of 0 or more, not an object',
      );
      await expect(planEntries(ENTRIES, { ...RULES, maxBytes: () => count })).rejects.toThrow(RangeError);
    }
    // A bigint reads apart from the number it holds, as a numeric text does.
    await expect(planEntries(ENTRIES, { ...RULES, maxEntries: 5n as unknown as number })).rejects.toThrow(
      'planEntries: maxEntries must be a number of 0 or more, not 5n',
    );
  });
});
