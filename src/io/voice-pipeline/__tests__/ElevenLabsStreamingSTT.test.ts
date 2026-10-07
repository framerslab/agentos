import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsStreamingSTT } from '../providers/ElevenLabsStreamingSTT.js';

/** Reads one field from the multipart body the session builds by hand. */
function formField(body: Buffer, name: string): string | undefined {
  const match = body
    .toString('latin1')
    .match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`));
  return match?.[1];
}

/**
 * Pushes one chunk of audio through a session, flushes it, and returns the
 * body of the single request the session sent to ElevenLabs.
 */
async function transcribeOnce(model?: string): Promise<Buffer> {
  const bodies: Buffer[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(init?.body as unknown as Buffer);
      return new Response(JSON.stringify({ text: 'hello', words: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );

  const stt = new ElevenLabsStreamingSTT({ apiKey: 'xi-test', model });
  const session = await stt.startSession({ language: 'en' });
  const errors: unknown[] = [];
  session.on('error', (err: unknown) => errors.push(err));
  try {
    session.pushAudio({
      samples: new Float32Array(1600).fill(0.25),
      sampleRate: 16000,
      timestamp: 0,
    });
    await session.flush();
  } finally {
    session.close();
  }

  expect(errors).toEqual([]);
  expect(bodies).toHaveLength(1);
  return bodies[0];
}

describe('ElevenLabsStreamingSTT', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends model_id scribe_v2 when no model is configured', async () => {
    // ElevenLabs requires model_id and lists scribe_v1 as deprecated in favour of scribe_v2.
    expect(formField(await transcribeOnce(), 'model_id')).toBe('scribe_v2');
  });

  it('sends a configured model as model_id', async () => {
    expect(formField(await transcribeOnce('scribe_v2_medical'), 'model_id')).toBe(
      'scribe_v2_medical'
    );
  });
});
