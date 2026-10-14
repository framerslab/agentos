import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createVoiceProvidersFromEnv,
  createSttChainFromEnv,
  NoVoiceProvidersAvailableError,
  createSttChain,
  parseSttEntry,
  sttEntryPricePerMinute,
  STT_CHAIN_VENDORS,
} from '../env-constructor.js';
import { openAITranscriptionPricing } from '../../../core/llm/providers/implementations/openaiPricing.js';
import { DEEPGRAM_STREAMING_PRICING, deepgramStreamingPricing } from '../providers/deepgramPricing.js';

describe('createVoiceProvidersFromEnv', () => {
  it('builds chains with only ELEVENLABS_API_KEY', () => {
    const { stt, tts } = createVoiceProvidersFromEnv({
      env: { ELEVENLABS_API_KEY: 'el' },
    });
    expect(stt.providers.map((p) => p.providerId)).toContain(
      'elevenlabs-streaming-stt'
    );
    expect(tts.providers.map((p) => p.providerId)).toContain(
      'elevenlabs-streaming'
    );
  });

  it('prefers Deepgram for STT when both keys present', () => {
    const { stt } = createVoiceProvidersFromEnv({
      env: { DEEPGRAM_API_KEY: 'dg', ELEVENLABS_API_KEY: 'el' },
    });
    const ids = stt.providers.map((p) => p.providerId);
    expect(ids.indexOf('deepgram-streaming')).toBeLessThan(
      ids.indexOf('elevenlabs-streaming-stt')
    );
  });

  it('throws when no viable keys', () => {
    expect(() => createVoiceProvidersFromEnv({ env: {} })).toThrow(
      NoVoiceProvidersAvailableError
    );
  });

  it('NoVoiceProvidersAvailableError names every checked env var', () => {
    try {
      createVoiceProvidersFromEnv({ env: {} });
      expect.fail('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('DEEPGRAM_API_KEY');
      expect(msg).toContain('ELEVENLABS_API_KEY');
      expect(msg).toContain('OPENAI_API_KEY');
    }
  });

  it('shared breaker across STT + TTS chains', () => {
    const { stt, tts, breaker } = createVoiceProvidersFromEnv({
      env: { ELEVENLABS_API_KEY: 'el' },
    });
    expect(breaker).toBeDefined();
    // Internal assertion: both chains reference the same breaker instance.
    expect((stt as unknown as { opts: { breaker: unknown } }).opts.breaker).toBe(
      breaker
    );
    expect((tts as unknown as { opts: { breaker: unknown } }).opts.breaker).toBe(
      breaker
    );
  });

  it('includes OpenAI Realtime TTS + batch fallback when OPENAI_API_KEY is set', () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { OPENAI_API_KEY: 'op', ELEVENLABS_API_KEY: 'el' },
    });
    const ids = tts.providers.map((p) => p.providerId);
    expect(ids).toContain('openai-realtime');
    expect(ids.some((id) => id.startsWith('openai-tts'))).toBe(true);
  });

  it('enables failover modes by default', () => {
    const { stt, tts } = createVoiceProvidersFromEnv({
      env: { ELEVENLABS_API_KEY: 'el' },
    });
    expect(
      (stt as unknown as { opts: { enableMidUtteranceFailover?: boolean } })
        .opts.enableMidUtteranceFailover
    ).toBe(true);
    expect(
      (tts as unknown as { opts: { enableMidSynthesisFailover?: boolean } })
        .opts.enableMidSynthesisFailover
    ).toBe(true);
  });

  it('puts Deepgram Aura ahead of ElevenLabs streaming TTS by default', () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { DEEPGRAM_API_KEY: 'dg', ELEVENLABS_API_KEY: 'el', OPENAI_API_KEY: 'op' },
    });
    const ids = tts.providers.map((p) => p.providerId);
    expect(ids).toContain('deepgram-aura');
    expect(ids).toContain('elevenlabs-streaming');
    expect(ids.indexOf('deepgram-aura')).toBeLessThan(ids.indexOf('elevenlabs-streaming'));
  });

  it('puts ElevenLabs streaming TTS ahead of Aura when ttsPreference is elevenlabs', () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { DEEPGRAM_API_KEY: 'dg', ELEVENLABS_API_KEY: 'el', OPENAI_API_KEY: 'op' },
      ttsPreference: 'elevenlabs',
    });
    const ids = tts.providers.map((p) => p.providerId);
    expect(ids.indexOf('elevenlabs-streaming')).toBeLessThan(ids.indexOf('deepgram-aura'));
  });

  it('omits Aura TTS when no Deepgram key is set', () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { ELEVENLABS_API_KEY: 'el', OPENAI_API_KEY: 'op' },
    });
    expect(tts.providers.map((p) => p.providerId)).not.toContain('deepgram-aura');
  });
});

describe('cartesia + hume env wiring', () => {
  it('adds cartesia streaming when CARTESIA_API_KEY + voice id are present', () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { DEEPGRAM_API_KEY: 'd', CARTESIA_API_KEY: 'c', CARTESIA_VOICE_ID: 'v1' },
    });
    expect(tts.providers.map((p) => p.providerId)).toContain('cartesia-sonic-stream');
  });

  it('skips cartesia without a voice id (provider needs one)', () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { DEEPGRAM_API_KEY: 'd', CARTESIA_API_KEY: 'c' },
    });
    expect(tts.providers.map((p) => p.providerId)).not.toContain('cartesia-sonic-stream');
  });

  it('leaves hume out when HUME_API_KEY is present without the hume preference', () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { DEEPGRAM_API_KEY: 'd', HUME_API_KEY: 'h' },
    });
    expect(tts.providers.map((p) => p.providerId)).not.toContain('hume-octave-stream');
  });

  it('key absence = absent from chain (no throw)', () => {
    const { tts } = createVoiceProvidersFromEnv({ env: { DEEPGRAM_API_KEY: 'd' } });
    const ids = tts.providers.map((p) => p.providerId);
    expect(ids).not.toContain('cartesia-sonic-stream');
    expect(ids).not.toContain('hume-octave-stream');
  });

  it("ttsPreference 'cartesia' promotes it to first-try", () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { DEEPGRAM_API_KEY: 'd', CARTESIA_API_KEY: 'c', CARTESIA_VOICE_ID: 'v1' },
      ttsPreference: 'cartesia',
    });
    expect(tts.providers[0].providerId).toBe('cartesia-sonic-stream');
  });

  it("ttsPreference 'hume' promotes it to first-try", () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { DEEPGRAM_API_KEY: 'd', HUME_API_KEY: 'h' },
      ttsPreference: 'hume',
    });
    expect(tts.providers[0].providerId).toBe('hume-octave-stream');
  });

  it('default incumbent ordering is unchanged when no new keys are set', () => {
    const { tts } = createVoiceProvidersFromEnv({
      env: { DEEPGRAM_API_KEY: 'd', ELEVENLABS_API_KEY: 'e', OPENAI_API_KEY: 'o' },
    });
    // Byte-identical incumbent chain head — the no-regression guard.
    expect(tts.providers.slice(0, 3).map((p) => p.providerId)).toEqual([
      'deepgram-aura',
      'elevenlabs-streaming',
      'openai-realtime',
    ]);
  });
});

describe('OpenAI Realtime transcription in the voice bundle', () => {
  it('joins the STT chain after the incumbents when OPENAI_API_KEY is set', () => {
    const { stt } = createVoiceProvidersFromEnv({
      env: { DEEPGRAM_API_KEY: 'dg', ELEVENLABS_API_KEY: 'el', OPENAI_API_KEY: 'op' },
    });
    expect(stt.providers.map((p) => p.providerId)).toEqual([
      'deepgram-streaming',
      'elevenlabs-streaming-stt',
      'openai-realtime-transcription',
    ]);
  });

  it('builds a voice bundle from OPENAI_API_KEY alone', () => {
    const { stt, tts } = createVoiceProvidersFromEnv({ env: { OPENAI_API_KEY: 'op' } });
    expect(stt.providers.map((p) => p.providerId)).toEqual(['openai-realtime-transcription']);
    expect(tts.providers.map((p) => p.providerId)).toContain('openai-realtime');
  });
});

describe('createSttChainFromEnv', () => {
  it('builds an STT chain with no TTS key', () => {
    const { stt } = createSttChainFromEnv({ env: { OPENAI_API_KEY: 'op' } });
    expect(stt.providers.map((p) => p.providerId)).toEqual(['openai-realtime-transcription']);
  });

  it('leaves mid-utterance failover off by default, so a session is the provider session itself and keeps flush()', () => {
    const { stt } = createSttChainFromEnv({ env: { OPENAI_API_KEY: 'op' } });
    expect(
      (stt as unknown as { opts: { enableMidUtteranceFailover?: boolean } }).opts
        .enableMidUtteranceFailover
    ).toBe(false);
  });

  it('passes the OpenAI Realtime options to the provider', () => {
    const { stt } = createSttChainFromEnv({
      env: { DEEPGRAM_API_KEY: 'dg', OPENAI_API_KEY: 'op' },
      openaiRealtime: { priority: 5 },
    });
    expect(stt.providers.map((p) => p.providerId)).toEqual([
      'openai-realtime-transcription',
      'deepgram-streaming',
    ]);
  });

  it('shares its breaker with the chain', () => {
    const { stt, breaker } = createSttChainFromEnv({ env: { DEEPGRAM_API_KEY: 'dg' } });
    expect((stt as unknown as { opts: { breaker: unknown } }).opts.breaker).toBe(breaker);
  });

  it('throws NoVoiceProvidersAvailableError naming the STT keys when none is set', () => {
    expect(() => createSttChainFromEnv({ env: { CARTESIA_API_KEY: 'c' } })).toThrow(
      NoVoiceProvidersAvailableError
    );
    try {
      createSttChainFromEnv({ env: {} });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as NoVoiceProvidersAvailableError).checkedEnvVars).toEqual([
        'DEEPGRAM_API_KEY',
        'ELEVENLABS_API_KEY',
        'OPENAI_API_KEY',
      ]);
    }
  });
});

describe('createSttChain from entries', () => {
  it('keeps the entries in order as the chain tries them, each with its vendor and model', () => {
    const chain = createSttChain(['openai:gpt-4o-transcribe', 'openai:gpt-4o-mini-transcribe', 'deepgram:nova-3'], {
      openai: { apiKey: 'sk-test-not-a-real-key' },
      deepgram: { apiKey: 'dg-test' },
    });
    expect(chain.providers.map((provider) => [provider.providerId, provider.priority])).toEqual([
      ['openai-realtime-transcription', 10],
      ['openai-realtime-transcription', 20],
      ['deepgram-streaming', 30],
    ]);
    expect(chain.providers.map((provider) => (provider as unknown as { config: { model?: string } }).config.model)).toEqual([
      'gpt-4o-transcribe',
      'gpt-4o-mini-transcribe',
      'nova-3',
    ]);
  });

  it('refuses an empty list, an entry twice, a device entry, an unknown vendor and a vendor with no options', () => {
    expect(() => createSttChain([], {})).toThrow(RangeError);
    expect(() => createSttChain(['openai:gpt-4o-transcribe', 'openai:gpt-4o-transcribe'], { openai: { apiKey: 'k' } })).toThrow('twice');
    expect(() => createSttChain(['device:moonshine-auto'], {})).toThrow(RangeError);
    expect(() => createSttChain(['whisper:large'], {})).toThrow(RangeError);
    expect(() => createSttChain(['openai:gpt-4o-transcribe'], {})).toThrow('openai');
  });

  it('parses an entry and refuses another shape', () => {
    expect(parseSttEntry('openai:gpt-4o-mini-transcribe')).toEqual({ vendor: 'openai', model: 'gpt-4o-mini-transcribe' });
    for (const bad of ['openai', 'openai:', ':model', 'device:moonshine-auto', 'open ai:x']) expect(() => parseSttEntry(bad)).toThrow(RangeError);
    expect(STT_CHAIN_VENDORS).toEqual(['openai', 'deepgram', 'elevenlabs']);
  });

  it("prices an entry from AgentOS's rows, OpenAI's transcription models among them, and knows no price without a row", () => {
    expect(openAITranscriptionPricing('gpt-4o-transcribe')).toBe(0.006);
    expect(openAITranscriptionPricing('gpt-transcribe')).toBe(0.0045);
    expect(openAITranscriptionPricing('gpt-live-transcribe')).toBe(0.017);
    expect(sttEntryPricePerMinute('openai:gpt-4o-mini-transcribe')).toBe(0.003);
    expect(sttEntryPricePerMinute('openai:no-such-model')).toBeUndefined();
    expect(sttEntryPricePerMinute('openai:constructor')).toBeUndefined();
  });

  it('refuses to price an entry parseSttEntry refuses, a device entry among them', () => {
    expect(() => sttEntryPricePerMinute('device:moonshine-auto')).toThrow(RangeError);
    expect(() => sttEntryPricePerMinute('openai')).toThrow(RangeError);
  });

  it('prices a deepgram entry from its streaming row, and no other model of it', () => {
    expect(sttEntryPricePerMinute('deepgram:nova-3')).toBe(0.0077);
    expect(sttEntryPricePerMinute('deepgram:nova-2')).toBeUndefined();
    expect(sttEntryPricePerMinute('elevenlabs:scribe_v1')).toBeUndefined();
    expect(deepgramStreamingPricing('constructor')).toBeUndefined();
    expect(deepgramStreamingPricing(undefined)).toBeUndefined();
    // Every spend bound in the process reads this one table: Reflect.set answers false for a frozen object, where an
    // assignment would throw in strict code, and the price stays as listed.
    expect(Reflect.set(DEEPGRAM_STREAMING_PRICING, 'nova-3', 0)).toBe(false);
    expect(Reflect.set(DEEPGRAM_STREAMING_PRICING, 'nova-2', 0.001)).toBe(false);
    expect(sttEntryPricePerMinute('deepgram:nova-3')).toBe(0.0077);
    expect(sttEntryPricePerMinute('deepgram:nova-2')).toBeUndefined();
  });
});

/**
 * The part of the ws package's WebSocketServer the session tests use. The package's module entry exports the
 * server as `WebSocketServer`; the repository's ambient declaration of 'ws' (for the channel adapters) does not
 * name it, so the tests read it from the module at run time with this shape.
 */
interface LocalRealtimeSocket {
  on(event: 'message', listener: (data: Buffer) => void): void;
  send(data: string): void;
  terminate(): void;
}

interface LocalRealtimeServer {
  clients: Set<LocalRealtimeSocket>;
  on(event: 'connection', listener: (socket: LocalRealtimeSocket) => void): void;
  once(event: 'listening', listener: () => void): void;
  address(): AddressInfo;
  close(callback: () => void): void;
}

interface LocalRealtimeServerOptions {
  host: string;
  port: number;
  verifyClient: (
    info: { req: IncomingMessage },
    accept: (verified: boolean, code?: number, message?: string) => void
  ) => void;
}

describe('createSttChain sessions', () => {
  // A local stand-in for OpenAI's Realtime endpoint. It answers an upgrade for a model in `refused` with
  // HTTP 503 and confirms any other connection's session update. It records the model each connection asks
  // for (a host other than api.openai.com gets it as a query parameter) and the model of each session update
  // it confirms.
  const refused = new Set<string>();
  const asked: string[] = [];
  const confirmed: string[] = [];
  let server: LocalRealtimeServer;
  let openai: { apiKey: string; baseUrl: string };

  beforeAll(async () => {
    const { WebSocketServer } = (await import('ws')) as unknown as {
      WebSocketServer: new (options: LocalRealtimeServerOptions) => LocalRealtimeServer;
    };
    server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (
        info: { req: IncomingMessage },
        accept: (verified: boolean, code?: number, message?: string) => void
      ) => {
        const model = new URL(info.req.url ?? '/', 'http://127.0.0.1').searchParams.get('model') ?? '';
        asked.push(model);
        if (refused.has(model)) accept(false, 503, 'Service Unavailable');
        else accept(true);
      },
    });
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        const event = JSON.parse(String(data)) as {
          type?: string;
          session?: { audio?: { input?: { transcription?: { model?: string } } } };
        };
        if (event.type !== 'session.update') return;
        confirmed.push(event.session?.audio?.input?.transcription?.model ?? '');
        socket.send(JSON.stringify({ type: 'session.updated', event_id: 'event_confirm', session: event.session }));
      });
    });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    openai = { apiKey: 'sk-test-not-a-real-key', baseUrl: `ws://127.0.0.1:${port}/v1/realtime` };
  });

  afterAll(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    refused.clear();
    asked.length = 0;
    confirmed.length = 0;
  });

  it('opens on the next entry when one refuses, in the order given, each connection with its model', async () => {
    refused.add('gpt-4o-transcribe');
    const failed: string[] = [];
    const attempts: number[] = [];
    const chain = createSttChain(
      ['openai:gpt-4o-transcribe', 'openai:gpt-4o-mini-transcribe'],
      { openai },
      {
        onProviderFailed: (event) => failed.push(event.providerId),
        onProviderSelected: (event) => attempts.push(event.attempt),
      }
    );
    const session = await chain.startSession({ language: 'en' });
    try {
      expect(asked).toEqual(['gpt-4o-transcribe', 'gpt-4o-mini-transcribe']);
      expect(confirmed).toEqual(['gpt-4o-mini-transcribe']);
      expect(failed).toEqual(['openai-realtime-transcription']);
      expect(attempts).toEqual([2]);
      // Failover is off, so the session is the provider's own, which ends a turn with flush().
      expect(typeof session.flush).toBe('function');
    } finally {
      session.close();
    }
  });

  it('stays on the first entry when its session opens, and never asks for the next', async () => {
    const chain = createSttChain(['openai:gpt-4o-transcribe', 'openai:gpt-4o-mini-transcribe'], { openai });
    const session = await chain.startSession({ language: 'en' });
    try {
      expect(asked).toEqual(['gpt-4o-transcribe']);
      expect(confirmed).toEqual(['gpt-4o-transcribe']);
    } finally {
      session.close();
    }
  });
});
