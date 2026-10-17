#!/usr/bin/env node
// Example: transcript files from other notetakers read to turns, and the plan of an archive's entries.
//
// Docs: docs/features/LIBRARY_INDEX.md, "Transcript files from other notetakers" and "An archive's plan".
//
// This script demonstrates, all from the browser entry @framers/agentos/cognition/library/browser,
// which a page imports and Node runs too:
//   - transcriptFormatOf naming a file's format from its name and its bytes
//   - readTranscript reading one call written as SubRip, WebVTT, Otter's text, Fireflies's JSON and
//     plain lines into the same turns, with the speakers' names kept apart from the turns
//   - the turns cut into passages by chunkTurns, searched with LexicalIndex, and a hit's speaker
//     found again from the labels the page kept
//   - planEntries saying what each entry of an archive becomes before anything is read, and sha256Hex
//     finding two copies of one text once they are read
//
// With no file named, it reads the five layouts written below. Name files to read those instead; a Word
// file is read through mammoth, a dependency of the package:
//   node examples/transcript-files.mjs call.vtt call_otter_ai.txt notes.docx
//
// Usage (no API key, no network):
//   pnpm install && pnpm run build
//   node examples/transcript-files.mjs

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  LexicalIndex,
  chunkTurns,
  lexicalTokens,
  planEntries,
  readTranscript,
  readWordTranscript,
  sha256Hex,
  snippetAround,
  transcriptFormatOf,
} from '@framers/agentos/cognition/library/browser';

/** One call of four turns, as five notetakers write it. */
const SAMPLES = {
  'Planning call.srt': [
    '1',
    '00:00:01,000 --> 00:00:04,200',
    'Ana Silva: Good morning. Shall we start with the budget?',
    '',
    '2',
    '00:00:04,500 --> 00:00:09,000',
    'Leo Park: Travel is ten percent over plan.',
    '',
    '3',
    '00:00:09,400 --> 00:00:13,800',
    'Ana Silva: Can we move the offsite to May?',
    '',
    '4',
    '00:00:14,000 --> 00:00:19,500',
    'Leo Park: May works, and the venue holds',
    'forty people.',
    '',
  ].join('\n'),
  'Planning call.vtt': [
    'WEBVTT',
    '',
    '00:00:01.000 --> 00:00:04.200',
    '<v Ana Silva>Good morning. Shall we start with the budget?</v>',
    '',
    '00:00:04.500 --> 00:00:09.000',
    '<v Leo Park>Travel is ten percent over plan.</v>',
    '',
    '00:00:09.400 --> 00:00:13.800',
    '<v Ana Silva>Can we move the <i>offsite</i> to May?</v>',
    '',
    '00:00:14.000 --> 00:00:19.500',
    '<v Leo Park>May works, and the venue holds forty people.</v>',
    '',
  ].join('\n'),
  'Planning call_otter_ai.txt': [
    'Ana Silva  0:01',
    'Good morning. Shall we start with the budget?',
    '',
    'Leo Park  0:04',
    'Travel is ten percent over plan.',
    '',
    'Ana Silva  0:09',
    'Can we move the offsite to May?',
    '',
    'Leo Park  0:14',
    'May works, and the venue holds forty people.',
    '',
    'Transcribed by https://otter.ai',
    '',
  ].join('\n'),
  'Planning call.json': JSON.stringify({
    sentences: [
      { index: 0, speaker_name: 'Ana Silva', text: 'Good morning. Shall we start with the budget?', start_time: 1.0, end_time: 4.2 },
      { index: 1, speaker_name: 'Leo Park', text: 'Travel is ten percent over plan.', start_time: 4.5, end_time: 9.0 },
      { index: 2, speaker_name: 'Ana Silva', text: 'Can we move the offsite to May?', start_time: 9.4, end_time: 13.8 },
      { index: 3, speaker_name: 'Leo Park', text: 'May works, and the venue holds forty people.', start_time: 14.0, end_time: 19.5 },
    ],
  }),
  'Planning call notes.txt': [
    'Ana Silva: Good morning. Shall we start with the budget?',
    'Leo Park: Travel is ten percent over plan.',
    'Ana Silva: Can we move the offsite to May?',
    'Leo Park: May works, and the venue holds forty people.',
    '',
  ].join('\n'),
};

/** A file's turns, read by the format its name and its bytes give; `null` for a file that is none of them. */
async function read(name, bytes) {
  // The whole file: Fireflies's JSON can hold its sentences, and Otter's export its second turn, past a file's first bytes.
  const format = transcriptFormatOf(name, bytes);
  if (format === null) return null;
  if (format === 'docx') {
    // mammoth's Node build reads { buffer }; a page passes mammoth's browser build, which reads { arrayBuffer }, as it is.
    const { default: mammoth } = await import('mammoth');
    return readWordTranscript(bytes, {
      extractRawText: ({ arrayBuffer }) => mammoth.extractRawText({ buffer: Buffer.from(arrayBuffer) }),
    });
  }
  return readTranscript(bytes, format);
}

/** Prints a read: its format, its length, and each turn with its speaker joined back from the labels. */
function show(name, transcript) {
  const speakers = new Map(transcript.labels.map((label) => [label.seq, label.label]));
  const length = transcript.durationMs === null ? 'no length given' : `${transcript.durationMs / 1000} s`;
  console.log(`${name}: ${transcript.format}, ${transcript.turns.length} turns, ${length}`);
  for (const turn of transcript.turns) {
    const at = turn.startMs === null ? '' : `[${(turn.startMs / 1000).toFixed(1)} s] `;
    console.log(`  ${turn.seq}. ${at}${speakers.get(turn.seq) ?? '(no speaker named)'}: ${turn.text}`);
  }
}

const files = process.argv.slice(2);

if (files.length > 0) {
  for (const file of files) {
    const transcript = await read(basename(file), new Uint8Array(await readFile(file)));
    if (transcript === null) console.log(`${file}: not SubRip, WebVTT, Otter's text, Fireflies's JSON, plain lines or a Word file`);
    else show(file, transcript);
  }
} else {
  console.log('\n=== one call in five layouts, each read from its bytes ===\n');
  const encoder = new TextEncoder();
  const reads = [];
  for (const [name, text] of Object.entries(SAMPLES)) {
    const transcript = await read(name, encoder.encode(text));
    if (transcript === null) throw new Error(`${name} was named no transcript format`);
    show(name, transcript);
    reads.push(transcript);
  }

  // Whatever the layout, the call reads into the same words and the same speakers by turn.
  const words = (transcript) => JSON.stringify(transcript.turns.map((turn) => turn.text));
  const voices = (transcript) => JSON.stringify(transcript.labels);
  for (const transcript of reads) {
    if (words(transcript) !== words(reads[0]) || voices(transcript) !== voices(reads[0])) {
      throw new Error(`the ${transcript.format} layout read into other turns than the ${reads[0].format} layout`);
    }
  }
  console.log(`\nall five: the same ${reads[0].turns.length} turns and ${reads[0].labels.length} labels`);

  console.log('\n=== the turns as passages, searched on the device ===\n');
  const call = reads[1];
  const speakers = new Map(call.labels.map((label) => [label.seq, label.label]));
  const passages = chunkTurns(
    call.turns.map((turn) => ({ ...turn, itemId: `turn-${turn.seq}` })),
    { maxChars: 100 },
  );
  const index = new LexicalIndex({ tokenize: lexicalTokens });
  for (const passage of passages) index.addDocument(`call#${passage.index}`, passage.text);
  console.log(`${passages.length} passages`);

  const [hit] = index.search('offsite', 5);
  if (hit === undefined) throw new Error('the search for "offsite" found no passage');
  const passage = passages[Number(hit.id.split('#')[1])];
  const snippet = snippetAround(passage.text, ['offsite']);
  // The passage records where each turn sits in its text: the turn that holds the word, and the speaker the page kept.
  const turn = passage.turns.find((placed) => placed.start <= snippet.at && snippet.at < placed.end);
  if (turn === undefined) throw new Error('the word found lies in no turn of its passage');
  console.log(`"offsite": ${hit.id}, turn ${turn.seq}, said by ${speakers.get(turn.seq)}: ${snippet.text}`);

  console.log('\n=== an archive\'s plan, before anything is read ===\n');
  const MB = 1_048_576;
  const plan = await planEntries(
    [
      { path: 'Planning 0123456789abcdef0123456789abcdef/Offsite 89abcdef0123456789abcdef01234567.md', size: 2_048 },
      { path: 'Planning 0123456789abcdef0123456789abcdef/Budget.pdf', size: 3 * MB },
      { path: 'Calls/standup.vtt', size: 9_000 },
      { path: 'Calls/standup.m4a', size: 8 * MB },
      { path: 'Calls/Agenda.txt', size: 16 },
      { path: 'Calls/Agenda copy.txt', size: 16 },
      { path: 'Scans/receipt.heic', size: 900_000 },
      { path: 'Scans/manual.pdf', size: 40 * MB },
      { path: 'more.zip', size: 30_000 },
      { path: '../outside.md', size: 100 },
    ],
    {
      documentTypes: { '.md': 'text/markdown', '.txt': 'text/plain', '.pdf': 'application/pdf' },
      transcriptExtensions: ['.srt', '.vtt'],
      recordingExtensions: ['.m4a', '.mp3'],
      maxBytes: (kind) => (kind === 'recording' ? 500 * MB : 10 * MB),
      // A nested archive is listed by the caller, one level deep; here, from a list.
      openArchive: async (path) => (path === 'more.zip' ? [{ path: 'Inner.md', size: 500 }, { path: 'deeper.zip', size: 900 }] : []),
    },
  );
  for (const entry of plan) {
    const what = entry.becomes === 'skipped' ? `skipped (${entry.reason})` : entry.becomes;
    const where = `${entry.folder ?? 'the top'}${entry.within === null ? '' : ` of ${entry.within}`}`;
    console.log(`  ${what.padEnd(18)} "${entry.title}" in ${where}`);
  }
  if (plan[0].title !== 'Offsite' || plan[0].folder !== 'Planning') throw new Error('a Notion export\'s ids were left in a title');
  if (plan.find((entry) => entry.path === 'Scans/manual.pdf')?.reason !== 'size') throw new Error('a file past its bound was planned');

  // The plan reads no file, so two copies of one text are planned alike; the caller finds them by what it reads.
  const texts = { 'Calls/Agenda.txt': 'Book the venue.\n', 'Calls/Agenda copy.txt': 'Book the venue.\n' };
  const seen = new Map();
  for (const [path, text] of Object.entries(texts)) {
    const digest = await sha256Hex(text);
    if (seen.has(digest)) console.log(`\n${path} holds the same text as ${seen.get(digest)} (SHA-256 ${digest.slice(0, 16)}...)`);
    else seen.set(digest, path);
  }
  if (seen.size !== 1) throw new Error('two copies of one text hashed apart');
}
