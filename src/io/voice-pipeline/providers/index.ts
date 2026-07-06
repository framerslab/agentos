/**
 * @module voice-pipeline/providers
 *
 * Concrete provider implementations for the voice pipeline:
 * - {@link DeepgramStreamingSTT} — Deepgram WebSocket streaming STT
 * - {@link ElevenLabsStreamingTTS} — ElevenLabs WebSocket streaming TTS
 * - {@link AgentSessionVoiceAdapter} — AgentOS session → voice pipeline adapter
 * - {@link OpenAIBatchTTS} — OpenAI batch (one-shot) TTS
 * - {@link ElevenLabsBatchTTS} — ElevenLabs batch (one-shot) TTS
 * - {@link BatchTTSFallback} — Priority-ordered multi-provider TTS fallback
 */

export { DeepgramStreamingSTT, type DeepgramStreamingSTTConfig } from './DeepgramStreamingSTT.js';
export {
  ElevenLabsStreamingSTT,
  type ElevenLabsStreamingSTTConfig,
} from './ElevenLabsStreamingSTT.js';
export {
  ElevenLabsStreamingTTS,
  type ElevenLabsStreamingTTSConfig,
} from './ElevenLabsStreamingTTS.js';
export {
  DeepgramAuraStreamingTTS,
  type DeepgramAuraStreamingTTSConfig,
} from './DeepgramAuraStreamingTTS.js';
export { AgentSessionVoiceAdapter } from './AgentSessionVoiceAdapter.js';
export { OpenAIBatchTTS, type OpenAIBatchTTSConfig } from './OpenAIBatchTTS.js';
export { ElevenLabsBatchTTS, type ElevenLabsBatchTTSConfig } from './ElevenLabsBatchTTS.js';
export {
  DeepgramAuraBatchTTS,
  type DeepgramAuraBatchTTSConfig,
  chunkForAura,
} from './DeepgramAuraBatchTTS.js';
export { BatchTTSFallback } from './BatchTTSFallback.js';
// Batch (one-shot) STT providers.
export {
  BatchSTTFallback,
  EmptyTranscriptError,
} from './BatchSTTFallback.js';
export {
  DeepgramPreRecordedBatchSTT,
  type DeepgramPreRecordedBatchSTTConfig,
} from './DeepgramPreRecordedBatchSTT.js';
export {
  OpenAIWhisperBatchSTT,
  type OpenAIWhisperBatchSTTConfig,
} from './OpenAIWhisperBatchSTT.js';
export { OpenAIRealtimeTTS, type OpenAIRealtimeTTSConfig } from './OpenAIRealtimeTTS.js';
export {
  StreamingSTTChain,
  type StreamingSTTChainOptions,
  type ProviderSelectedEvent,
  type ProviderFailedEvent,
  type ProviderFailoverEvent,
} from './StreamingSTTChain.js';
export {
  StreamingTTSChain,
  type StreamingTTSChainOptions,
  type TTSProviderSelectedEvent,
  type TTSProviderFailedEvent,
  type TTSProviderFailoverEvent,
} from './StreamingTTSChain.js';
