import { readFileSync } from 'node:fs';

import mammoth from 'mammoth';
import { describe, expect, it } from 'vitest';

import { zipOf } from '../../memory/io/ingestion/__tests__/helpers/documents.js';
import {
  readTranscript,
  readWordTranscript,
  transcriptFormatOf,
  TranscriptReadError,
  type ExtractRawText,
  type ReadTranscript,
  type TranscriptFormat,
} from '../browser.js';

/** A vector's text, as it is under `vectors/`: written for these tests, or a real export (`vectors/SOURCES.md`). */
function vector(name: string): string {
  return readFileSync(new URL(`./vectors/${name}`, import.meta.url), 'utf8');
}

/** What a vector reads into, written by hand beside it. */
function expected(name: string): ReadTranscript {
  const { format, turns, labels, durationMs } = JSON.parse(vector(`${name}.expected.json`)) as ReadTranscript;
  return { format, turns, labels, durationMs };
}

/** The one meeting every vector holds, in its own layout. */
const LAYOUTS: ReadonlyArray<{ file: string; format: Exclude<TranscriptFormat, 'docx'> }> = [
  { file: 'meeting.srt', format: 'srt' },
  { file: 'meeting.vtt', format: 'vtt' },
  { file: 'otter.txt', format: 'otter' },
  { file: 'fireflies.json', format: 'fireflies' },
  { file: 'lines.txt', format: 'lines' },
];

const WORDS = [
  'Good morning. Shall we start with the budget?',
  'Yes. Travel is ten percent over plan.',
  'Can we move the offsite to May?',
  'May works, and the venue holds forty people.',
  'Then book it. Research & design present first.',
  'Agreed. I will send the notes today.',
];

const SPEAKERS = ['Ana Silva', 'Leo Park', 'Ana Silva', 'Leo Park', 'Ana Silva', 'Leo Park'];

/** An SRT of one cue a text, two seconds apart. */
function srtOf(texts: readonly string[]): string {
  const clock = (seconds: number, thousandths: string): string => `00:00:${String(seconds).padStart(2, '0')},${thousandths}`;
  return texts.map((text, at) => `${at + 1}\n${clock(at * 2, '000')} --> ${clock(at * 2 + 1, '500')}\n${text}\n`).join('\n');
}

/** XML's three escapes for text. */
function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A Word file of one paragraph a line: its content types, its package relationships and its main document part. */
function wordFileOf(lines: readonly string[]): Buffer {
  return zipOf([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ' +
          'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>',
        'utf8',
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" ' +
          'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
          'Target="word/document.xml"/>' +
          '</Relationships>',
        'utf8',
      ),
    },
    {
      name: 'word/document.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
          lines.map((line) => `<w:p><w:r><w:t>${xml(line)}</w:t></w:r></w:p>`).join('') +
          '</w:body></w:document>',
        'utf8',
      ),
    },
  ]);
}

/** The six `Name: words` lines of `lines.txt`. */
const SIX_LINES = vector('lines.txt').split('\n').filter((line) => line.length > 0);

/** A text's UTF-16 bytes in the byte order given, after its byte order mark. */
function utf16(text: string, order: 'le' | 'be'): Buffer {
  const units = Buffer.from(text, 'utf16le');
  if (order === 'be') units.swap16();
  return Buffer.concat([Buffer.from(order === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]), units]);
}

/** What a call threw, or `null` when it threw nothing. */
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return null;
}

describe('readTranscript', () => {
  it('reads each layout into the same six turns, numbered from 1, with the speakers apart from the words', () => {
    for (const { file, format } of LAYOUTS) {
      const text = vector(file);
      const read = readTranscript(text, format);

      expect(read, file).toEqual(expected(file));
      // What every layout shares, whatever its times: the six texts, the two speakers by turn, and no name in the words.
      expect(read.turns.map((turn) => turn.seq), file).toEqual([1, 2, 3, 4, 5, 6]);
      expect(read.turns.map((turn) => turn.text), file).toEqual(WORDS);
      expect(read.labels, file).toEqual(SPEAKERS.map((label, at) => ({ seq: at + 1, label })));
      expect(read.turns.filter((turn) => /Ana Silva|Leo Park/.test(turn.text)), file).toEqual([]);

      // The same file as a Windows tool saves it (a byte order mark, CRLF line ends), and its bytes, read the same.
      const windows = `\ufeff${text.replace(/\n/g, '\r\n')}`;
      expect(readTranscript(windows, format), `${file} with a byte order mark and CRLF`).toEqual(read);
      expect(readTranscript(new TextEncoder().encode(windows), format), `${file} as bytes`).toEqual(read);
      // Saved as UTF-16 with its byte order mark, in either byte order, as some Windows tools save text.
      expect(readTranscript(utf16(text, 'le'), format), `${file} as UTF-16 LE`).toEqual(read);
      expect(readTranscript(utf16(text, 'be'), format), `${file} as UTF-16 BE`).toEqual(read);
    }

    // Times are milliseconds: a cue's start and end, a header's start alone, and none for plain lines.
    expect(readTranscript(vector('meeting.srt'), 'srt').turns[3]).toMatchObject({ startMs: 14_000, endMs: 19_500 });
    expect(readTranscript(vector('meeting.vtt'), 'vtt').turns[1]).toMatchObject({ startMs: 4_500, endMs: 9_000 });
    expect(readTranscript(vector('fireflies.json'), 'fireflies').durationMs).toBe(28_900);
    expect(readTranscript(vector('otter.txt'), 'otter').turns[5]).toMatchObject({ startMs: 24_000, endMs: null });
    expect(readTranscript(vector('lines.txt'), 'lines').turns.every((turn) => turn.startMs === null && turn.endMs === null)).toBe(true);
  });

  it('removes a VTT cue\'s markup, decodes its character references, and gives a cue with no voice span no label', () => {
    const read = readTranscript(
      [
        'WEBVTT',
        '',
        'NOTE a comment block is not a cue',
        '',
        'intro',
        '00:01.000 --> 00:03.500 line:0',
        '<v.first Ana Silva><b>Tom &amp; Jerry</b> said 3 &lt; 5, isn&#39;t it&nbsp;so? <00:02.000>Yes &#x263A;</v>',
        '',
        '00:00:04.000 --> 00:00:06.000',
        'A caption with <i>no</i> voice.',
        '',
        '00:00:07.000 --> 00:00:09.000',
        '<v Ana &amp; Leo>Both &lrm;speak&rlm; &unknown; &amp;amp;</v>',
        '',
        '00:00:10.000 --> 00:00:12.000',
        '<v Ana Silva>Shall we?</v> <v Leo Park>Yes.</v>',
      ].join('\n'),
      'vtt',
    );

    expect(read.turns).toEqual([
      { seq: 1, startMs: 1_000, endMs: 3_500, text: 'Tom & Jerry said 3 < 5, isn\'t it so? Yes \u263a' },
      { seq: 2, startMs: 4_000, endMs: 6_000, text: 'A caption with no voice.' },
      // A reference this reader does not know stays as written, and a decoded one is not decoded again.
      { seq: 3, startMs: 7_000, endMs: 9_000, text: 'Both \u200espeak\u200f &unknown; &amp;' },
      // Two voices in one cue are two turns with the cue's times.
      { seq: 4, startMs: 10_000, endMs: 12_000, text: 'Shall we?' },
      { seq: 5, startMs: 10_000, endMs: 12_000, text: 'Yes.' },
    ]);
    expect(read.labels).toEqual([
      { seq: 1, label: 'Ana Silva' },
      { seq: 3, label: 'Ana & Leo' },
      { seq: 4, label: 'Ana Silva' },
      { seq: 5, label: 'Leo Park' },
    ]);
  });

  it('takes an SRT\'s "Name: " as the speaker only when at least four cues in five carry one and the names are at most twelve', () => {
    // One cue in five opens with a capitalized word and a colon: it is words, not a speaker.
    const note = readTranscript(srtOf(['We open with the numbers.', 'Note: the budget', 'It grew by a tenth.', 'Hiring opens in May.', 'That is all.']), 'srt');
    expect(note.labels).toEqual([]);
    expect(note.turns[1]).toEqual({ seq: 2, startMs: 2_000, endMs: 3_500, text: 'Note: the budget' });

    // Four in five hold: the four are speakers, and the fifth keeps its text and has no label.
    const four = readTranscript(srtOf(['Ana Silva: One.', 'Leo Park: Two.', 'Ana Silva: Three.', 'Leo Park: Four.', '(laughter)']), 'srt');
    expect(four.turns.map((turn) => turn.text)).toEqual(['One.', 'Two.', 'Three.', 'Four.', '(laughter)']);
    expect(four.labels).toEqual([
      { seq: 1, label: 'Ana Silva' },
      { seq: 2, label: 'Leo Park' },
      { seq: 3, label: 'Ana Silva' },
      { seq: 4, label: 'Leo Park' },
    ]);

    // Three in four do not: every cue keeps its text whole.
    const three = readTranscript(srtOf(['Ana Silva: One.', 'Leo Park: Two.', 'Ana Silva: Three.', 'A line with no name.']), 'srt');
    expect(three.labels).toEqual([]);
    expect(three.turns[0].text).toBe('Ana Silva: One.');

    // Twelve names are speakers; thirteen are some other kind of line.
    const named = (count: number): string[] => Array.from({ length: count }, (_, at) => `Speaker ${String.fromCharCode(65 + at)}: Turn ${at + 1}.`);
    expect(readTranscript(srtOf(named(12)), 'srt').labels).toHaveLength(12);
    const thirteen = readTranscript(srtOf(named(13)), 'srt');
    expect(thirteen.labels).toEqual([]);
    expect(thirteen.turns[12].text).toBe('Speaker M: Turn 13.');
  });

  it('reads a Word file through the extractor the caller passes', async () => {
    const file = wordFileOf(SIX_LINES);
    const handed: ArrayBuffer[] = [];
    // mammoth's Node build opens { buffer } and its browser build { arrayBuffer }: this is the Node form of the
    // function a page passes as it is.
    const extractRawText: ExtractRawText = ({ arrayBuffer }) => {
      handed.push(arrayBuffer);
      return mammoth.extractRawText({ buffer: Buffer.from(arrayBuffer) });
    };
    const want = { ...expected('lines.txt'), format: 'docx' };

    expect(await readWordTranscript(new Uint8Array(file), { extractRawText })).toEqual(want);

    // A Node Buffer is a view over memory it may share with other buffers, and so is a part of a larger array: the
    // extractor is handed the file's own bytes and no others.
    const within = new Uint8Array(file.length + 11);
    within.set(file, 4);
    expect(await readWordTranscript(file, { extractRawText })).toEqual(want);
    expect(await readWordTranscript(within.subarray(4, 4 + file.length), { extractRawText })).toEqual(want);
    expect(handed.map((buffer) => buffer.byteLength)).toEqual([file.length, file.length, file.length]);
  });

  it('reads a Word file laid out as Otter\'s text by its headers, and one header-like line in other text as plain lines', async () => {
    const extractRawText: ExtractRawText = ({ arrayBuffer }) => mammoth.extractRawText({ buffer: Buffer.from(arrayBuffer) });

    const otter = wordFileOf(vector('otter.txt').split('\n').filter((line) => line.length > 0));
    expect(await readWordTranscript(otter, { extractRawText })).toEqual({ ...expected('otter.txt'), format: 'docx' });

    const agenda = wordFileOf(['Agenda for the call', 'Budget review first', 'Break  10:30', 'Ana Silva: hello', 'Leo Park: hi']);
    expect(await readWordTranscript(agenda, { extractRawText })).toMatchObject({
      turns: [
        { text: 'Agenda for the call' },
        { text: 'Budget review first' },
        { text: 'Break 10:30' },
        { text: 'Ana Silva: hello' },
        { text: 'Leo Park: hi' },
      ],
      labels: [],
    });
  });

  it('reads Otter\'s layout by its headers when a turn runs over two paragraphs, or one turn closes with Otter\'s line, so no name is read into the words', async () => {
    const extractRawText: ExtractRawText = ({ arrayBuffer }) => mammoth.extractRawText({ buffer: Buffer.from(arrayBuffer) });
    const paragraphs = ['Ana Silva  0:01', 'Good morning.', 'Shall we start with the budget?', 'Leo Park  0:04', 'Yes.'];

    expect(await readWordTranscript(wordFileOf(paragraphs), { extractRawText })).toEqual({
      format: 'docx',
      turns: [
        { seq: 1, startMs: 1_000, endMs: null, text: 'Good morning. Shall we start with the budget?' },
        { seq: 2, startMs: 4_000, endMs: null, text: 'Yes.' },
      ],
      labels: [
        { seq: 1, label: 'Ana Silva' },
        { seq: 2, label: 'Leo Park' },
      ],
      durationMs: null,
    });
    // The same text as a file is named Otter's.
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
    expect(transcriptFormatOf('call.txt', bytes('Ana Silva  0:01\nGood morning.\nShall we start with the budget?\n\nLeo Park  0:04\nYes.\n'))).toBe('otter');

    // One turn is Otter's when the text closes with Otter's line.
    expect(transcriptFormatOf('memo.txt', bytes('Ana Silva  0:01\nA note to myself.\n\nTranscribed by https://otter.ai\n'))).toBe('otter');
    expect(await readWordTranscript(wordFileOf(['Ana Silva  0:01', 'A note to myself.', 'Transcribed by https://otter.ai']), { extractRawText })).toMatchObject({
      turns: [{ seq: 1, startMs: 1_000, text: 'A note to myself.' }],
      labels: [{ seq: 1, label: 'Ana Silva' }],
    });

    // Without that line one turn is not told from other text: a caller that knows the file's source names its layout.
    const memo = wordFileOf(['Ana Silva  0:01', 'A note to myself.']);
    expect(await readWordTranscript(memo, { extractRawText })).toMatchObject({
      turns: [{ text: 'Ana Silva 0:01' }, { text: 'A note to myself.' }],
      labels: [],
    });
    const asOtter = { extractRawText, layout: 'otter' as const };
    expect(await readWordTranscript(memo, asOtter)).toMatchObject({
      turns: [{ seq: 1, startMs: 1_000, text: 'A note to myself.' }],
      labels: [{ seq: 1, label: 'Ana Silva' }],
    });
    const asLines = { extractRawText, layout: 'lines' as const };
    expect(await readWordTranscript(wordFileOf(paragraphs), asLines)).toMatchObject({ format: 'docx', labels: [] });
  });

  it('throws TranscriptReadError when the extractor throws or answers no text, and reads a Word file with no text as no turns', async () => {
    const failure = new Error('not a Word file');
    const thrown = await readWordTranscript(new Uint8Array([1, 2, 3]), {
      extractRawText: async () => {
        throw failure;
      },
    }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(TranscriptReadError);
    expect(thrown).toMatchObject({ format: 'docx', cause: failure });

    const nothing = await readWordTranscript(new Uint8Array([1]), { extractRawText: async () => ({}) as { value: string } }).catch(
      (error: unknown) => error,
    );
    expect(nothing).toBeInstanceOf(TranscriptReadError);
    expect(nothing).toMatchObject({ format: 'docx', message: 'docx: the extractor answered no text' });

    expect(await readWordTranscript(new Uint8Array([1]), { extractRawText: async () => ({ value: '' }) })).toEqual({
      format: 'docx',
      turns: [],
      labels: [],
      durationMs: null,
    });
  });

  it('reads no time from a clock whose minutes or seconds pass 59, or whose milliseconds pass the largest safe integer', () => {
    // A timing line with such a clock is no timing line, so its block is no cue.
    expect(readTranscript('1\n00:00:01,000 --> 00:00:75,000\nAna Silva: One.\n', 'srt').turns).toEqual([]);
    expect(readTranscript('WEBVTT\n\n00:61.000 --> 00:62.000\n<v Ana Silva>One.\n', 'vtt').turns).toEqual([]);
    const huge = '9'.repeat(400);
    expect(readTranscript(`1\n${huge}:00:00,000 --> ${huge}:00:01,000\nAna Silva: One.\n`, 'srt')).toEqual({
      format: 'srt',
      turns: [],
      labels: [],
      durationMs: null,
    });

    // Fireflies's times: a clock past 59, seconds past the largest safe integer of milliseconds, as text or as a number,
    // give no time, and the sentence is still a turn.
    const read = readTranscript(
      JSON.stringify([
        { sentence: 'One.', speaker_name: 'Ana Silva', startTime: '00:75', endTime: huge },
        { sentence: 'Two.', speaker_name: 'Leo Park', startTime: 1e300, endTime: '01:15:32' },
      ]),
      'fireflies',
    );
    expect(read.turns).toEqual([
      { seq: 1, startMs: null, endMs: null, text: 'One.' },
      { seq: 2, startMs: null, endMs: 4_532_000, text: 'Two.' },
    ]);
    expect(read.durationMs).toBe(4_532_000);

    // Otter's header with seconds past 59 is no header.
    expect(readTranscript('Ana Silva  0:75\nOne.\n\nLeo Park  0:04\nTwo.\n', 'otter').turns).toEqual([{ seq: 1, startMs: 4_000, endMs: null, text: 'Two.' }]);
  });

  it('reads cues written with no blank line before them as WebVTT\'s parser does, and SubRip\'s alike', () => {
    // A cue straight after the WEBVTT line, and the next cue straight after it.
    const vtt = readTranscript(
      ['WEBVTT', '00:00:01.000 --> 00:00:02.000', '<v Ana Silva>One.', '00:00:03.000 --> 00:00:04.000', '<v Leo Park>Two.'].join('\n'),
      'vtt',
    );
    expect(vtt.turns).toEqual([
      { seq: 1, startMs: 1_000, endMs: 2_000, text: 'One.' },
      { seq: 2, startMs: 3_000, endMs: 4_000, text: 'Two.' },
    ]);
    expect(vtt.labels).toEqual([
      { seq: 1, label: 'Ana Silva' },
      { seq: 2, label: 'Leo Park' },
    ]);

    // Header lines before the first timing line are no cue, nor part of one.
    const headed = readTranscript(['WEBVTT', 'Kind: captions', 'Language: en', '00:00:01.000 --> 00:00:02.000', '<v Ana Silva>One.'].join('\n'), 'vtt');
    expect(headed.turns).toEqual([vtt.turns[0]]);

    // SubRip: the number on the line before a timing line starts that cue.
    const srt = readTranscript(
      ['1', '00:00:01,000 --> 00:00:02,000', 'Ana Silva: One.', '2', '00:00:03,000 --> 00:00:04,000', 'Leo Park: Two.'].join('\n'),
      'srt',
    );
    expect(srt.turns).toEqual(vtt.turns);
    expect(srt.labels).toEqual(vtt.labels);
  });

  it('names a file\'s format by its extension and its first bytes', () => {
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
    const head = (name: string): Uint8Array => bytes(vector(name)).subarray(0, 4096);
    const wordFile = wordFileOf(SIX_LINES);

    expect(transcriptFormatOf('Planning call.srt', head('meeting.srt'))).toBe('srt');
    expect(transcriptFormatOf('planning.VTT', head('meeting.vtt'))).toBe('vtt');
    expect(transcriptFormatOf('Planning call_otter_ai.txt', head('otter.txt'))).toBe('otter');
    expect(transcriptFormatOf('notes.txt', head('lines.txt'))).toBe('lines');
    expect(transcriptFormatOf('notes.md', head('lines.txt'))).toBe('lines');
    expect(transcriptFormatOf('transcript.json', head('fireflies.json'))).toBe('fireflies');
    expect(transcriptFormatOf('exports/Planning call.docx', wordFile.subarray(0, 4096))).toBe('docx');
    expect(transcriptFormatOf('bom.vtt', new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('WEBVTT\n')]))).toBe('vtt');
    expect(transcriptFormatOf('captions.srt', utf16(vector('meeting.srt'), 'le').subarray(0, 4096))).toBe('srt');
    expect(transcriptFormatOf('captions.vtt', utf16(vector('meeting.vtt'), 'be').subarray(0, 4096))).toBe('vtt');

    // Otter's text has a header before each paragraph; one line that looks like a header in other text does not make it Otter's.
    expect(transcriptFormatOf('agenda.txt', bytes('Agenda for the call\nBudget review first\nBreak  10:30\nAna Silva: hello\nLeo Park: hi'))).toBe('lines');
    // The first bytes of a file can stop inside a line, so a last line with no line feed after it is read as words, never
    // as a header: a whole short export with no line feed at its end is Otter's, and so is a head cut inside a header or
    // inside a second line of words, while a head whose second header is its cut last line holds one turn.
    const memo = 'Ana Silva  0:01\nGood morning.\n\nLeo Park  0:04\nHello.';
    expect(transcriptFormatOf('memo.txt', bytes(memo))).toBe('otter');
    expect(transcriptFormatOf('memo.txt', bytes(`${memo}\n\nAna Sil`))).toBe('otter');
    expect(transcriptFormatOf('memo.txt', bytes(`${memo}\nand a second line`))).toBe('otter');
    expect(transcriptFormatOf('memo.txt', bytes('Ana Silva  0:01\nGood morning.\n\nLeo Park  0:04'))).toBe('lines');

    // A PDF is no transcript, by its name or by its first bytes under another name.
    expect(transcriptFormatOf('transcript.pdf', bytes('%PDF-1.7\n'))).toBeNull();
    expect(transcriptFormatOf('transcript.txt', bytes('%PDF-1.7\n'))).toBeNull();

    // The first bytes must be the format the name claims.
    expect(transcriptFormatOf('captions.vtt', bytes('1\n00:00:01,000 --> 00:00:02,000\nNo first line.\n'))).toBeNull();
    expect(transcriptFormatOf('settings.json', bytes('{ "theme": "dark" }'))).toBeNull();
    expect(transcriptFormatOf('renamed.docx', bytes('Ana Silva: plain text under a Word file\'s name'))).toBeNull();
    expect(transcriptFormatOf('archive.txt', wordFile.subarray(0, 64))).toBeNull();
    expect(transcriptFormatOf('recording.m4a', new Uint8Array(0))).toBeNull();
    expect(transcriptFormatOf('no extension', bytes('Ana Silva: words'))).toBeNull();
  });

  it('answers a file past 576,000 characters of turns: a bound on length is the caller\'s', () => {
    const line = `Ana Silva: ${'word '.repeat(240).trim()}`;
    const read = readTranscript(Array.from({ length: 500 }, () => line).join('\n'), 'lines');

    expect(read.turns).toHaveLength(500);
    expect(read.turns.reduce((sum, turn) => sum + turn.text.length, 0)).toBe(599_500);
    expect(read.labels).toHaveLength(500);
  });

  it('reads a VTT with no voice span by the "Name: " rule, as a tool that writes the name into the cue text needs', () => {
    const read = readTranscript(
      [
        'WEBVTT',
        '',
        '1',
        '00:00:07.560 --> 00:00:08.970',
        'Community Board 3: Good evening.',
        '',
        '2',
        '00:00:11.880 --> 00:00:26.460',
        'Ana Silva | Design: Thanks for',
        'having us.',
        '',
        '3',
        '00:00:27.960 --> 00:00:37.620',
        'Community Board 3: Shall we begin?',
        '',
      ].join('\r\n'),
      'vtt',
    );

    expect(read.turns).toEqual([
      { seq: 1, startMs: 7_560, endMs: 8_970, text: 'Good evening.' },
      { seq: 2, startMs: 11_880, endMs: 26_460, text: 'Thanks for having us.' },
      { seq: 3, startMs: 27_960, endMs: 37_620, text: 'Shall we begin?' },
    ]);
    expect(read.labels).toEqual([
      { seq: 1, label: 'Community Board 3' },
      { seq: 2, label: 'Ana Silva | Design' },
      { seq: 3, label: 'Community Board 3' },
    ]);
    expect(read.durationMs).toBe(37_620);
  });

  it('takes a leading name of at most forty characters that starts with a capital, or with a letter of a script that has none', () => {
    const read = (text: string): ReadTranscript => readTranscript(text, 'lines');

    expect(read('张伟: 你好\n李娜: 早上好')).toMatchObject({
      turns: [{ text: '你好' }, { text: '早上好' }],
      labels: [
        { seq: 1, label: '张伟' },
        { seq: 2, label: '李娜' },
      ],
    });
    // Chinese and Japanese text writes the full-width colon, with no space after it.
    expect(read('张伟：你好\n李娜： 早上好')).toMatchObject({
      turns: [{ text: '你好' }, { text: '早上好' }],
      labels: [
        { seq: 1, label: '张伟' },
        { seq: 2, label: '李娜' },
      ],
    });
    expect(read('Dr. Ana Silva-Park (she/her): Hello.\nSpeaker 2: Hi.').labels).toEqual([
      { seq: 1, label: 'Dr. Ana Silva-Park (she/her)' },
      { seq: 2, label: 'Speaker 2' },
    ]);
    // A space before the colon is not part of the name.
    expect(read('Ana Silva : Bonjour.')).toMatchObject({ turns: [{ text: 'Bonjour.' }], labels: [{ seq: 1, label: 'Ana Silva' }] });

    // A lower-case start is a sentence, not a name.
    expect(read('note: one\nnote: two')).toMatchObject({ turns: [{ text: 'note: one' }, { text: 'note: two' }], labels: [] });
    // Forty characters are a name; forty-one are not.
    expect(read(`${'A'.repeat(40)}: words`).labels).toEqual([{ seq: 1, label: 'A'.repeat(40) }]);
    expect(read(`${'A'.repeat(41)}: words`).labels).toEqual([]);
    // The colon is followed by white space and words: a time of day is no name.
    expect(read('Ana Silva:no space\nAt 10:30 we met').labels).toEqual([]);
  });

  it('reads Otter\'s text by its headers: hours in a time, a header with no words left out, and neither the lines before the first header nor the closing line', () => {
    const lines = [
      'SUMMARY KEYWORDS',
      'budget, offsite',
      '',
      'Unknown Speaker  59:58  ',
      'Almost an hour in.',
      'Still the same turn.',
      '',
      'Ana Silva  1:00:03',
      '',
      'Leo Park  1:02:10',
      'We are over time.',
      '',
      'Transcribed by https://otter.ai',
    ];
    const read = readTranscript(lines.join('\n'), 'otter');

    expect(read.turns).toEqual([
      { seq: 1, startMs: 3_598_000, endMs: null, text: 'Almost an hour in. Still the same turn.' },
      { seq: 2, startMs: 3_730_000, endMs: null, text: 'We are over time.' },
    ]);
    expect(read.labels).toEqual([
      { seq: 1, label: 'Unknown Speaker' },
      { seq: 2, label: 'Leo Park' },
    ]);
    // A header carries a start and no end, so the file's length is not known.
    expect(read.durationMs).toBeNull();

    // An export made with Otter's branding turned off has no closing line, and reads the same.
    expect(readTranscript(lines.slice(0, -2).join('\n'), 'otter')).toEqual(read);
    // The closing line is left out only where it closes the file: said in a turn, it is that turn's words.
    expect(readTranscript('Ana Silva  0:01\nTranscribed by https://otter.ai\nIt says so at the end.', 'otter').turns[0].text).toBe(
      'Transcribed by https://otter.ai It says so at the end.',
    );
  });

  it('reads an Otter header whose speaker is named in lower case, as a name typed in Otter can be, as a header', () => {
    // Read as words, the first turn's header and words would be dropped with the lines before the first header, and
    // a later one read into the turn before it, said by the wrong speaker.
    const call = 'john  0:01\nHello.\n\nAna Silva  0:04\nHi, John.\n\nana  0:09\nThat is me too.\n\nTranscribed by https://otter.ai\n';
    expect(readTranscript(call, 'otter')).toEqual({
      format: 'otter',
      turns: [
        { seq: 1, startMs: 1_000, endMs: null, text: 'Hello.' },
        { seq: 2, startMs: 4_000, endMs: null, text: 'Hi, John.' },
        { seq: 3, startMs: 9_000, endMs: null, text: 'That is me too.' },
      ],
      labels: [
        { seq: 1, label: 'john' },
        { seq: 2, label: 'Ana Silva' },
        { seq: 3, label: 'ana' },
      ],
      durationMs: null,
    });

    // An export whose every speaker is named in lower case is Otter's, from its text or from a Word file's.
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
    expect(transcriptFormatOf('call.txt', bytes('john  0:01\nHello.\n\nana  0:04\nHi.\n'))).toBe('otter');
    expect(transcriptFormatOf('call.txt', bytes('李娜  0:01\n早上好。\n\nmaría  0:04\nHola.\n'))).toBe('otter');

    // A name still holds at most forty characters and no colon, and the `Name: words` rule keeps its capital.
    expect(readTranscript(`${'a'.repeat(41)}  0:01\nWords.\n\nana  0:04\nHi.\n`, 'otter').turns).toEqual([
      { seq: 1, startMs: 4_000, endMs: null, text: 'Hi.' },
    ]);
    expect(readTranscript('note: one\nnote: two\n', 'lines').labels).toEqual([]);
  });

  it('reads real Otter exports made with the names and the times, with the times alone and with the names alone', () => {
    // Real exports, cut from transcripts published under open licences (vectors/SOURCES.md). Otter's export can leave
    // out the speakers' names or the times, and each layout reads into the turns its headers give.
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
    for (const file of ['otter-names-times.txt', 'otter-times.txt', 'otter-names.txt']) {
      const text = vector(file);
      const read = readTranscript(text, 'otter');

      expect(read, file).toEqual(expected(file));
      // Whole, each closes with Otter's line and is named Otter's; saved on Windows, it reads the same.
      expect(transcriptFormatOf(file, bytes(text)), file).toBe('otter');
      expect(readTranscript(bytes(`\ufeff${text.replace(/\n/g, '\r\n')}`), 'otter'), `${file} with a byte order mark and CRLF`).toEqual(read);
    }
  });

  it('reads an Otter export made without times by the two spaces after each name, and one made without names by its times', () => {
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

    // With no spaces after each header and no line feed at the file's end, a time alone still heads a turn.
    const bare = vector('otter-times.txt')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trimEnd();
    expect(readTranscript(bare, 'otter')).toEqual(expected('otter-times.txt'));
    expect(transcriptFormatOf('talk.txt', bytes(bare))).toBe('otter');

    // Without the closing line, times or names on lines of their own are not told from an agenda or a page of
    // headings, so such a file is named plain lines; read with `otter`, it reads by its headers all the same.
    const unbranded = vector('otter-names.txt').replace(/Transcribed by https:\/\/otter\.ai\n$/, '');
    expect(transcriptFormatOf('call.txt', bytes(unbranded))).toBe('lines');
    expect(readTranscript(unbranded, 'otter')).toEqual(expected('otter-names.txt'));
    expect(transcriptFormatOf('agenda.md', bytes('9:00\nWelcome\n\n9:30\nBudget review\n'))).toBe('lines');
    expect(transcriptFormatOf('notes.md', bytes('Budget  \nTravel is over plan.\n\nVenue  \nIt holds forty.\n'))).toBe('lines');

    // A name with no spaces after it is a paragraph, as Otter writes a speaker's next paragraph with no header.
    expect(readTranscript('Ana Silva  \nI agree.\n\nLeo and Ana?\n\nLeo Park  \nYes.\n', 'otter')).toEqual({
      format: 'otter',
      turns: [
        { seq: 1, startMs: null, endMs: null, text: 'I agree. Leo and Ana?' },
        { seq: 2, startMs: null, endMs: null, text: 'Yes.' },
      ],
      labels: [
        { seq: 1, label: 'Ana Silva' },
        { seq: 2, label: 'Leo Park' },
      ],
      durationMs: null,
    });

    // An export has one kind of header, the kind most of its lines have, so a paragraph that is a time alone is words.
    const texts = (text: string): string[] => readTranscript(text, 'otter').turns.map((turn) => turn.text);
    expect(texts('Ana Silva  \nWhen?\n\nLeo Park  \nAt\n\n10:30\n\nAna Silva  \nGood.\n')).toEqual(['When?', 'At 10:30', 'Good.']);
    expect(texts('Ana Silva  0:01\nWhen?\n\nLeo Park  0:04\nAt\n\n10:30\n\nAna Silva  0:09\nGood.\n')).toEqual(['When?', 'At 10:30', 'Good.']);
  });

  it('reads an Otter export made with neither names nor times into its paragraphs, a time alone among them as words, without the closing line', () => {
    // Such an export is its paragraphs and Otter's closing line. A paragraph that is a time alone further down does not
    // make it an export of times: the paragraphs before it are turns, not lines before a first header.
    const neither = 'Hello.\n\nWhat time?\n\n2:30\n\nGood.\n\nTranscribed by https://otter.ai\n';
    expect(transcriptFormatOf('call.txt', new TextEncoder().encode(neither))).toBe('otter');
    expect(readTranscript(neither, 'otter')).toEqual({
      format: 'otter',
      turns: [
        { seq: 1, startMs: null, endMs: null, text: 'Hello.' },
        { seq: 2, startMs: null, endMs: null, text: 'What time?' },
        { seq: 3, startMs: null, endMs: null, text: '2:30' },
        { seq: 4, startMs: null, endMs: null, text: 'Good.' },
      ],
      labels: [],
      durationMs: null,
    });
  });

  it('reads the line straight after an Otter header as that turn\'s words, a time alone too', () => {
    // Otter writes each header's words on the line after it, so a paragraph that is a time alone, in an export made
    // without names, is the words of the header above it and heads no turn.
    const said = '0:04  \nWhat time?\n\n0:09  \n2:30\n\n0:12  \nGood.\n\nTranscribed by https://otter.ai\n';
    expect(readTranscript(said, 'otter').turns).toEqual([
      { seq: 1, startMs: 4_000, endMs: null, text: 'What time?' },
      { seq: 2, startMs: 9_000, endMs: null, text: '2:30' },
      { seq: 3, startMs: 12_000, endMs: null, text: 'Good.' },
    ]);
  });

  it('reads a Word file laid out as an Otter export made without names by its times', async () => {
    const extractRawText: ExtractRawText = ({ arrayBuffer }) => mammoth.extractRawText({ buffer: Buffer.from(arrayBuffer) });
    const paragraphs = vector('otter-times.txt')
      .split('\n')
      .filter((line) => line.trim().length > 0);

    expect(await readWordTranscript(wordFileOf(paragraphs), { extractRawText })).toEqual({ ...expected('otter-times.txt'), format: 'docx' });
  });

  it('reads the paragraph straight after an Otter header in a Word file as that turn\'s words, as Otter\'s text reads its line', async () => {
    const extractRawText: ExtractRawText = ({ arrayBuffer }) => mammoth.extractRawText({ buffer: Buffer.from(arrayBuffer) });
    // mammoth's text follows each paragraph with a blank line, so the paragraph after a header that is a time alone,
    // `2:30`, is read on the line straight after it only when the text is read a paragraph a line. An empty paragraph,
    // as a Word file of the text's every line holds, is a blank line.
    const said = '0:04  \nWhat time?\n\n0:09  \n2:30\n\n0:12  \nGood.\n\nTranscribed by https://otter.ai\n';
    const want = { ...readTranscript(said, 'otter'), format: 'docx' };

    expect(want.turns.map((turn) => turn.text)).toEqual(['What time?', '2:30', 'Good.']);
    expect(await readWordTranscript(wordFileOf(said.split('\n').filter((line) => line.length > 0)), { extractRawText })).toEqual(want);
    expect(await readWordTranscript(wordFileOf(said.trimEnd().split('\n')), { extractRawText })).toEqual(want);
  });

  it('reads an Otter header written with its two spaces as a header straight after a header with no words, in a Word file with no empty paragraphs too', async () => {
    const extractRawText: ExtractRawText = ({ arrayBuffer }) => mammoth.extractRawText({ buffer: Buffer.from(arrayBuffer) });
    // Otter ends a paragraph's line with one space at most, so a time or a name with the two spaces after it is a header
    // wherever it stands, and the header above it, with no words, is left out. A Word file with no empty paragraphs
    // holds no blank line between the two headers.
    const times = ['0:04  ', 'Hello.', '0:09  ', '0:12  ', 'Good.', 'Transcribed by https://otter.ai'];
    const want = {
      format: 'docx',
      turns: [
        { seq: 1, startMs: 4_000, endMs: null, text: 'Hello.' },
        { seq: 2, startMs: 12_000, endMs: null, text: 'Good.' },
      ],
      labels: [],
      durationMs: null,
    };

    expect(await readWordTranscript(wordFileOf(times), { extractRawText })).toEqual(want);
    // The export's text reads the same, with or without the blank lines between its turns.
    expect(readTranscript(`${times.join('\n')}\n`, 'otter')).toEqual({ ...want, format: 'otter' });
    expect(readTranscript('0:04  \nHello.\n\n0:09  \n\n0:12  \nGood.\n\nTranscribed by https://otter.ai\n', 'otter')).toEqual({ ...want, format: 'otter' });

    // A name with its two spaces is a header there too.
    const names = ['Sam  ', 'Hello.', 'Julia Kasmire  ', 'Sam  ', 'Good.', 'Transcribed by https://otter.ai'];
    expect(await readWordTranscript(wordFileOf(names), { extractRawText })).toEqual({
      format: 'docx',
      turns: [
        { seq: 1, startMs: null, endMs: null, text: 'Hello.' },
        { seq: 2, startMs: null, endMs: null, text: 'Good.' },
      ],
      labels: [
        { seq: 1, label: 'Sam' },
        { seq: 2, label: 'Sam' },
      ],
      durationMs: null,
    });
  });

  it('reads a voice note\'s Otter export, the name, one space and the time, by its headers when it closes with Otter\'s line, and a line of words that ends in a time as words', async () => {
    const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
    const note = 'Unknown 0:00\nGood morning.\n\nUnknown 0:09\nShall we start?\n\nTranscribed by https://otter.ai\n';
    expect(readTranscript(note, 'otter')).toEqual({
      format: 'otter',
      turns: [
        { seq: 1, startMs: 0, endMs: null, text: 'Good morning.' },
        { seq: 2, startMs: 9_000, endMs: null, text: 'Shall we start?' },
      ],
      labels: [
        { seq: 1, label: 'Unknown' },
        { seq: 2, label: 'Unknown' },
      ],
      durationMs: null,
    });

    // The vector is written in the layout of a voice note's export (vectors/SOURCES.md). The line straight after a header
    // is that header's words, `The venue opens at 9:30` too. The file is named Otter's, and reads the same saved on
    // Windows and as a Word file.
    const file = 'otter-names-times-one-space.txt';
    const text = vector(file);
    expect(readTranscript(text, 'otter')).toEqual(expected(file));
    expect(transcriptFormatOf(file, bytes(text))).toBe('otter');
    expect(readTranscript(bytes(`\ufeff${text.replace(/\n/g, '\r\n')}`), 'otter')).toEqual(expected(file));
    const extractRawText: ExtractRawText = ({ arrayBuffer }) => mammoth.extractRawText({ buffer: Buffer.from(arrayBuffer) });
    const paragraphs = text.split('\n').filter((line) => line.length > 0);
    expect(await readWordTranscript(wordFileOf(paragraphs), { extractRawText })).toEqual({ ...expected(file), format: 'docx' });

    // A line of words can end as such a header does, so the header heads turns only in a text that closes with Otter's
    // line: without it the note reads as plain lines and is named plain lines. A line of words that ends in a time is
    // words in an export of names and times, and in an export of paragraphs alone.
    const unbranded = note.replace('Transcribed by https://otter.ai\n', '');
    expect(transcriptFormatOf('note.txt', bytes(unbranded))).toBe('lines');
    expect(readTranscript(unbranded, 'otter')).toMatchObject({
      turns: [{ text: 'Unknown 0:00' }, { text: 'Good morning.' }, { text: 'Unknown 0:09' }, { text: 'Shall we start?' }],
      labels: [],
    });
    const texts = (said: string): string[] => readTranscript(said, 'otter').turns.map((turn) => turn.text);
    expect(texts('Ana Silva  0:01\nWhen?\n\nLeo Park  0:04\nWe meet at 10:30\n\nTranscribed by https://otter.ai\n')).toEqual(['When?', 'We meet at 10:30']);
    expect(texts('Hello.\n\nWe meet at 10:30\n\nGood.\n\nTranscribed by https://otter.ai\n')).toEqual(['Hello.', 'We meet at 10:30', 'Good.']);
  });

  it('reads a later line of a voice note\'s turn that ends in a time as words, by the blank line Otter writes after each turn', async () => {
    // Otter writes a blank line after each turn's words, so a header stands straight after a blank line, its words on
    // the line straight after it. A later line of a turn's words that ends in a time, at the turn's end or inside it, is
    // words: read as a header, it would drop those words, or head a turn said by `We meet at`.
    const note = 'Unknown 0:00\nGood morning.\nWe meet at 10:30\n\nUnknown 0:09\nShall we start?\n\nTranscribed by https://otter.ai\n';
    const want = {
      format: 'otter',
      turns: [
        { seq: 1, startMs: 0, endMs: null, text: 'Good morning. We meet at 10:30' },
        { seq: 2, startMs: 9_000, endMs: null, text: 'Shall we start?' },
      ],
      labels: [
        { seq: 1, label: 'Unknown' },
        { seq: 2, label: 'Unknown' },
      ],
      durationMs: null,
    };
    expect(readTranscript(note, 'otter')).toEqual(want);
    expect(readTranscript(note.replace('10:30\n', '10:30\nin the hall.\n'), 'otter')).toEqual({
      ...want,
      turns: [{ ...want.turns[0], text: 'Good morning. We meet at 10:30 in the hall.' }, want.turns[1]],
    });

    // A Word file of the export's every line holds an empty paragraph where the export holds a blank line, and reads the
    // same.
    const extractRawText: ExtractRawText = ({ arrayBuffer }) => mammoth.extractRawText({ buffer: Buffer.from(arrayBuffer) });
    expect(await readWordTranscript(wordFileOf(note.trimEnd().split('\n')), { extractRawText })).toEqual({ ...want, format: 'docx' });

    // So is a time alone inside a turn of an export made without names whose lines lost the spaces at their ends.
    expect(readTranscript('0:04\nWhat time?\n2:30\n\n0:09\nGood.\n\nTranscribed by https://otter.ai\n', 'otter').turns).toEqual([
      { seq: 1, startMs: 4_000, endMs: null, text: 'What time? 2:30' },
      { seq: 2, startMs: 9_000, endMs: null, text: 'Good.' },
    ]);
  });

  it('reads a voice note\'s export in a Word file with no empty paragraphs by the paragraph straight after each header, a later paragraph that ends in a time straight before a header as a header', async () => {
    // With no blank line between the turns, a line of a header's form heads a turn unless it stands straight after a
    // header, where it is that header's words. Nothing in the file tells a turn's later paragraph that ends in a time,
    // straight before the next header, from a header whose words open with the next header's line, and the order of the
    // times does not either: the second file has the same layout, its times in the same order, a header at 10:30 whose
    // words end in an earlier time, and reads right by the same rule.
    const extractRawText: ExtractRawText = ({ arrayBuffer }) => mammoth.extractRawText({ buffer: Buffer.from(arrayBuffer) });
    const closing = 'Transcribed by https://otter.ai';

    const meet = wordFileOf(['Unknown 0:00', 'Good morning.', 'We meet at 10:30', 'Unknown 0:09', 'Shall we start?', closing]);
    expect(await readWordTranscript(meet, { extractRawText })).toEqual({
      format: 'docx',
      turns: [
        { seq: 1, startMs: 0, endMs: null, text: 'Good morning.' },
        { seq: 2, startMs: 630_000, endMs: null, text: 'Unknown 0:09 Shall we start?' },
      ],
      labels: [
        { seq: 1, label: 'Unknown' },
        { seq: 2, label: 'We meet at' },
      ],
      durationMs: null,
    });

    const bus = wordFileOf(['Unknown 0:00', 'Good morning.', 'Unknown 10:30', 'The bus left at 9:09', 'Shall we start?', closing]);
    expect(await readWordTranscript(bus, { extractRawText })).toEqual({
      format: 'docx',
      turns: [
        { seq: 1, startMs: 0, endMs: null, text: 'Good morning.' },
        { seq: 2, startMs: 630_000, endMs: null, text: 'The bus left at 9:09 Shall we start?' },
      ],
      labels: [
        { seq: 1, label: 'Unknown' },
        { seq: 2, label: 'Unknown' },
      ],
      durationMs: null,
    });
  });

  it('reads an Otter export made with neither names nor times into its paragraphs when the first is a line of words that ends in a time, or a time alone', async () => {
    // A line of words can take the form of a voice note's header, `We start at 9:30`, and of a time with no spaces after
    // it, `9:30`. Otter writes a header's words on the line straight after it, and each paragraph of an export made with
    // neither with a blank line after it, so a first paragraph of such a form opens no export of those headers: the
    // paragraph is no header, and the paragraphs after it are neither its words nor headers with no words.
    const neither = 'We start at 9:30\n\nGood morning, everyone.\n\nThe venue opens at 10:30\n\nTranscribed by https://otter.ai\n';
    const want = {
      format: 'otter',
      turns: [
        { seq: 1, startMs: null, endMs: null, text: 'We start at 9:30' },
        { seq: 2, startMs: null, endMs: null, text: 'Good morning, everyone.' },
        { seq: 3, startMs: null, endMs: null, text: 'The venue opens at 10:30' },
      ],
      labels: [],
      durationMs: null,
    };
    expect(transcriptFormatOf('call.txt', new TextEncoder().encode(neither))).toBe('otter');
    expect(readTranscript(neither, 'otter')).toEqual(want);
    // A Word file of the export's every line holds an empty paragraph where the export holds a blank line, and reads the
    // same.
    const extractRawText: ExtractRawText = ({ arrayBuffer }) => mammoth.extractRawText({ buffer: Buffer.from(arrayBuffer) });
    expect(await readWordTranscript(wordFileOf(neither.trimEnd().split('\n')), { extractRawText })).toEqual({ ...want, format: 'docx' });

    expect(readTranscript('9:30\n\nGood morning.\n\nShall we start?\n\nTranscribed by https://otter.ai\n', 'otter').turns).toEqual([
      { seq: 1, startMs: null, endMs: null, text: '9:30' },
      { seq: 2, startMs: null, endMs: null, text: 'Good morning.' },
      { seq: 3, startMs: null, endMs: null, text: 'Shall we start?' },
    ]);
  });

  it('reads Fireflies\'s sentences from a list at the top, with times given as text, and a sentence with no speaker', () => {
    const read = readTranscript(
      JSON.stringify([
        { index: 0, speaker_name: 'Ana Silva', text: ' Good morning. ', start_time: '0.48', end_time: '2.5' },
        { index: 1, speaker_name: null, text: 'Hello.', start_time: 2.75, end_time: 3 },
        { index: 2, speaker_name: 'Leo Park', text: '   ', start_time: 3, end_time: 4 },
        { index: 3, speaker_name: 'Leo Park', text: 'Shall we?', start_time: 'soon', end_time: null },
        'not a sentence',
      ]),
      'fireflies',
    );

    expect(read.turns).toEqual([
      { seq: 1, startMs: 480, endMs: 2_500, text: 'Good morning.' },
      { seq: 2, startMs: 2_750, endMs: 3_000, text: 'Hello.' },
      { seq: 3, startMs: null, endMs: null, text: 'Shall we?' },
    ]);
    expect(read.labels).toEqual([
      { seq: 1, label: 'Ana Silva' },
      { seq: 3, label: 'Leo Park' },
    ]);
    // The length is the last turn's end, and the last turn here has none.
    expect(read.durationMs).toBeNull();
  });

  it('reads a file downloaded from Fireflies: a list whose entries hold "sentence", with their times as clocks', () => {
    const file = JSON.stringify(
      [
        { sentence: 'Good morning.', startTime: '00:01', endTime: '00:04', speaker_name: 'Ana Silva', speaker_id: 0 },
        { sentence: 'Yes.', startTime: '00:04', endTime: '00:09', speaker_name: 'Leo Park', speaker_id: 1 },
        // Past the hour, as minutes that run on and as hours.
        { sentence: 'Still here.', startTime: '75:30', endTime: '75:31', speaker_name: 'Ana Silva', speaker_id: 0 },
        { sentence: 'So am I.', startTime: '01:15:32', endTime: '01:15:34', speaker_name: 'Leo Park', speaker_id: 1 },
      ],
      null,
      2,
    );
    const read = readTranscript(file, 'fireflies');

    expect(read.turns).toEqual([
      { seq: 1, startMs: 1_000, endMs: 4_000, text: 'Good morning.' },
      { seq: 2, startMs: 4_000, endMs: 9_000, text: 'Yes.' },
      { seq: 3, startMs: 4_530_000, endMs: 4_531_000, text: 'Still here.' },
      { seq: 4, startMs: 4_532_000, endMs: 4_534_000, text: 'So am I.' },
    ]);
    expect(read.labels).toEqual([
      { seq: 1, label: 'Ana Silva' },
      { seq: 2, label: 'Leo Park' },
      { seq: 3, label: 'Ana Silva' },
      { seq: 4, label: 'Leo Park' },
    ]);
    expect(read.durationMs).toBe(4_534_000);
    expect(transcriptFormatOf('Planning call.json', new TextEncoder().encode(file).subarray(0, 4096))).toBe('fireflies');
  });

  it('throws TranscriptReadError for a text that is not the format, and reads a text with no turn as none', () => {
    const notJson = thrownBy(() => readTranscript('Ana Silva: not JSON', 'fireflies'));
    expect(notJson).toBeInstanceOf(TranscriptReadError);
    expect(notJson).toMatchObject({ name: 'TranscriptReadError', format: 'fireflies' });

    const noFirstLine = thrownBy(() => readTranscript('1\n00:00:01,000 --> 00:00:02,000\nNo first line.', 'vtt'));
    expect(noFirstLine).toBeInstanceOf(TranscriptReadError);
    expect(noFirstLine).toMatchObject({ format: 'vtt' });
    // The message opens with the format the text was read as.
    expect(noFirstLine instanceof Error ? noFirstLine.message : '').toMatch(/^vtt: /);

    // A Word file is bytes for readWordTranscript, never text for this function.
    expect(thrownBy(() => readTranscript('', 'docx' as never))).toBeInstanceOf(TranscriptReadError);

    for (const format of ['srt', 'otter', 'lines'] as const) {
      expect(readTranscript('', format), format).toEqual({ format, turns: [], labels: [], durationMs: null });
    }
    expect(readTranscript('WEBVTT', 'vtt')).toEqual({ format: 'vtt', turns: [], labels: [], durationMs: null });
    expect(readTranscript('{ "title": "no sentences" }', 'fireflies')).toEqual({ format: 'fireflies', turns: [], labels: [], durationMs: null });
  });

  it('is exported by the library module as by its browser entry', async () => {
    const library = await import('../index.js');
    const page = await import('../browser.js');

    for (const name of ['readTranscript', 'readWordTranscript', 'transcriptFormatOf', 'TranscriptReadError', 'planEntries', 'sha256Hex'] as const) {
      expect(library[name], name).toBe(page[name]);
      expect(typeof page[name], name).toBe('function');
    }
  });
});
