/**
 * Integration test of the Moonshine browser speech-to-text provider on the
 * real @moonshine-ai/moonshine-wasm.
 *
 * The package's core runs in Node, as its own wasm test suite runs it, so the
 * provider runs here on the calling thread: the tiny streaming model's files
 * come from disk through the provider's modelBaseUrl, served on the loopback
 * address, and a recorded clip goes in as 100 ms frames. The package's Web
 * Worker host is a browser's; the fakes cover it.
 *
 * It runs when AGENTOS_TEST_MOONSHINE_DIR names a folder holding
 * tiny-streaming-en/ (the files of MOONSHINE_STREAMING_MODEL_FILES) and
 * two_cities_16k.wav; CI's Test & Lint job fetches them and sets it. On a
 * folder that lacks one of them, or holds one empty, the test is skipped
 * with a note naming the file, so a stale folder shows why.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MOONSHINE_STREAMING_MODEL_FILES, MoonshineBrowserSTT } from '../providers/MoonshineBrowserSTT.js';
import type { TranscriptEvent } from '../types.js';

/** The folder with the model and the clip; without it the suite is skipped. */
const MODEL_DIR = process.env.AGENTOS_TEST_MOONSHINE_DIR ?? '';

/** The model's folder inside MODEL_DIR, and the recorded clip beside it. */
const MODEL_FOLDER = 'tiny-streaming-en';
const CLIP = 'two_cities_16k.wav';

/**
 * The note the suite's test is skipped with on `dir`: it names the first of
 * the model's files and the clip that the folder lacks or holds empty, so a
 * developer whose folder is stale sees which; `undefined` when the folder
 * holds them all.
 */
function skipNote(dir: string): string | undefined {
  for (const file of [...MOONSHINE_STREAMING_MODEL_FILES.map((name) => `${MODEL_FOLDER}/${name}`), CLIP]) {
    const stat = statSync(join(dir, file), { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile() || stat.size === 0) {
      return `AGENTOS_TEST_MOONSHINE_DIR=${dir} lacks ${file} (missing or empty)`;
    }
  }
  return undefined;
}

/** The samples of a mono 16-bit PCM WAV file, as floats in [-1, 1], and its sample rate. */
function readWav(bytes: Buffer): { samples: Float32Array; sampleRate: number } {
  let offset = 12; // past "RIFF", the size and "WAVE"
  let sampleRate = 16_000;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'fmt ') sampleRate = bytes.readUInt32LE(offset + 12);
    if (id === 'data') {
      const count = Math.floor(Math.min(size, bytes.length - offset - 8) / 2);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) samples[i] = bytes.readInt16LE(offset + 8 + i * 2) / 32768;
      return { samples, sampleRate };
    }
    offset += 8 + size + (size & 1);
  }
  throw new Error('The clip has no data chunk');
}

describe("the suite's check of the folder AGENTOS_TEST_MOONSHINE_DIR names", () => {
  it('names the first file the folder lacks or holds empty, and nothing for a whole folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentos-moonshine-'));
    try {
      await mkdir(join(dir, MODEL_FOLDER));
      for (const name of MOONSHINE_STREAMING_MODEL_FILES) await writeFile(join(dir, MODEL_FOLDER, name), 'x');
      expect(skipNote(dir)).toBe(`AGENTOS_TEST_MOONSHINE_DIR=${dir} lacks two_cities_16k.wav (missing or empty)`);
      await writeFile(join(dir, CLIP), 'x');
      expect(skipNote(dir)).toBeUndefined();
      await writeFile(join(dir, MODEL_FOLDER, 'encoder.ort'), '');
      expect(skipNote(dir)).toBe(`AGENTOS_TEST_MOONSHINE_DIR=${dir} lacks tiny-streaming-en/encoder.ort (missing or empty)`);
      await rm(join(dir, MODEL_FOLDER, 'adapter.ort'));
      expect(skipNote(dir)).toBe(`AGENTOS_TEST_MOONSHINE_DIR=${dir} lacks tiny-streaming-en/adapter.ort (missing or empty)`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!MODEL_DIR)('MoonshineBrowserSTT on the real package, in Node', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      readFile(join(MODEL_DIR, path)).then(
        (bytes) => res.writeHead(200, { 'content-length': bytes.length }).end(bytes),
        () => res.writeHead(404).end()
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("transcribes a clip on the calling thread: Moonshine's line ids, a line's interims and final under one id, flush and one close", async ({ skip }) => {
    // A folder that lacks a file skips the test, with a note naming the file, rather than failing it.
    const note = skipNote(MODEL_DIR);
    if (note) skip(note);
    const stt = new MoonshineBrowserSTT({
      moonshine: () => import('@moonshine-ai/moonshine-wasm'),
      thread: 'calling',
      model: 'moonshine-tiny',
      modelBaseUrl: baseUrl,
    });
    const session = await stt.startSession();
    const transcripts: TranscriptEvent[] = [];
    const errors: Error[] = [];
    let closes = 0;
    session.on('transcript', (event: TranscriptEvent) => transcripts.push(event));
    session.on('error', (err: Error) => errors.push(err));
    session.on('close', () => {
      closes += 1;
    });

    const { samples, sampleRate } = readWav(await readFile(join(MODEL_DIR, 'two_cities_16k.wav')));
    const step = sampleRate / 10;
    for (let at = 0; at < samples.length; at += step) {
      session.pushAudio({ samples: samples.subarray(at, at + step), sampleRate, timestamp: Date.now() });
    }
    const pushedMs = (samples.length / sampleRate) * 1000;
    await session.flush();
    session.close();
    stt.dispose();

    expect(errors).toEqual([]);
    expect(closes).toBe(1);
    const finals = transcripts.filter((event) => event.isFinal);
    const interims = transcripts.filter((event) => !event.isFinal);
    expect(finals.length).toBeGreaterThan(0);
    for (const event of transcripts) {
      // Moonshine's line ids are 64-bit decimal strings, kept whole.
      expect(event.itemId).toMatch(/^\d+$/);
      expect(event.startMs).toBeGreaterThanOrEqual(0);
      expect(event.endMs).toBeGreaterThanOrEqual(event.startMs ?? 0);
      // On the session clock, within the audio pushed (a frame's slack for rounding).
      expect(event.endMs).toBeLessThanOrEqual(pushedMs + 100);
    }
    expect(new Set(finals.map((event) => event.itemId)).size).toBe(finals.length);
    expect(finals.some((final) => interims.some((interim) => interim.itemId === final.itemId))).toBe(true);
    expect(finals.map((event) => event.text).join(' ').toLowerCase()).toMatch(/best of times/);
  });
});
