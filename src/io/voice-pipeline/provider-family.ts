/**
 * @module voice-pipeline/provider-family
 *
 * Canonical provider FAMILY for a TTS/STT provider id.
 *
 * The pipeline routes on a coarse family label (`'deepgram'` / `'openai'` /
 * `'elevenlabs'`) while each concrete provider reports a granular
 * {@link IBatchTTS.providerId} (`'deepgram-aura'`, `'openai-tts-1'`,
 * `'openai-tts-1-hd'`, `'elevenlabs-batch'`, …). Consumers that content-address
 * synthesized audio (a durable clip cache) need the two to agree: a cache
 * lookup keyed on the routing label must find a clip written under the
 * synthesis id. `ttsProviderFamily` collapses both to the family so they never
 * diverge.
 *
 * Owning this map here — where the provider ids are defined — keeps downstream
 * consumers from hardcoding agentos-internal id strings that could rename out
 * from under them.
 */

/** Coarse provider family. Unknown labels pass through verbatim. */
export type TtsProviderFamily = 'deepgram' | 'openai' | 'elevenlabs' | (string & {});

/**
 * Collapse a granular provider id (or an already-coarse routing label) to its
 * canonical family. Unknown labels — including the fallback wrapper's `'cache'`
 * / `'fallback'` markers and any future vendor — return verbatim so a genuinely
 * distinct provider can never collide with a known family.
 *
 * @example
 * ttsProviderFamily('deepgram-aura')   // 'deepgram'
 * ttsProviderFamily('openai-tts-1-hd') // 'openai'
 * ttsProviderFamily('elevenlabs-batch')// 'elevenlabs'
 * ttsProviderFamily('cache')           // 'cache'
 */
export function ttsProviderFamily(providerId: string): TtsProviderFamily {
  const p = providerId.toLowerCase();
  if (p.startsWith('deepgram')) return 'deepgram';
  if (p.startsWith('openai')) return 'openai';
  if (p.startsWith('elevenlabs')) return 'elevenlabs';
  return providerId;
}
