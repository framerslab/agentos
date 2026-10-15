/** Versioned published supplier shutdown notice; no secret or model key is stored here. */
export interface SpeechRetirement {
  providerId: string; modelId: string; shutdownAt: string; source: string;
  replacement: string | null; replacementProtocol: 'realtime' | null;
}
/** Notices read on 12 October 2026. The date-only shutdown uses the start of that UTC day as a conservative library cutoff. */
export const SPEECH_RETIREMENTS: readonly Readonly<SpeechRetirement>[] = Object.freeze([
  { providerId: 'hume', modelId: '*', shutdownAt: '2026-11-13T05:01:00Z', source: 'https://dev.hume.ai/voice/changelog.md', replacement: null, replacementProtocol: null },
  ...['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts-2025-12-15'].map((modelId) => ({
    providerId: 'openai', modelId, shutdownAt: '2027-01-06T00:00:00Z', source: 'https://developers.openai.com/api/docs/deprecations.md', replacement: 'gpt-realtime-2.1-mini', replacementProtocol: 'realtime' as const,
  })),
].map((row) => Object.freeze(row)));
/** Refuses hosted/default admission immediately, and explicit local/provider admission at the documented cutoff. */
export function assertSpeechAvailable(providerId: string, modelId: string, now: number, mode: 'local' | 'hosted' | 'provider', use: 'explicit' | 'default' = 'explicit'): void {
  if (!Number.isFinite(now)) throw new Error('retirement clock required');
  const normalized = providerId.toLowerCase();
  const row = SPEECH_RETIREMENTS.find((item) => item.providerId === 'hume' ? /^hume(?:-|$)/.test(normalized) : item.modelId === modelId);
  if (row && (mode === 'hosted' || use === 'default' || now >= Date.parse(row.shutdownAt))) throw new Error('speech retirement admission refused');
}
