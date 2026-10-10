/**
 * @module hearing
 *
 * Audio processing utilities and speech-to-text (STT) / voice activity
 * detection (VAD) providers for the AgentOS perception layer.
 *
 * This module consolidates the "hearing" side of perception:
 *
 * - **Audio processing**: AdaptiveVAD, SilenceDetector,
 *   EnvironmentalCalibrator, AudioProcessor
 * - **STT providers**: OpenAI Whisper, Deepgram, AssemblyAI, Azure Speech (batch), and OpenAI Realtime transcription (streaming, from the voice pipeline)
 * - **VAD providers**: BuiltInAdaptiveVadProvider
 */

// Audio processing utilities
export { AdaptiveVAD } from './AdaptiveVAD.js';
export type { AdaptiveVADConfig, VADResult } from './AdaptiveVAD.js';
export { SilenceDetector } from './SilenceDetector.js';
export type { SilenceDetectorConfig } from './SilenceDetector.js';
export { EnvironmentalCalibrator } from './EnvironmentalCalibrator.js';
export type { NoiseProfile, CalibrationConfig } from './EnvironmentalCalibrator.js';
export { AudioProcessor } from './AudioProcessor.js';

// STT providers
export { OpenAIWhisperSpeechToTextProvider } from './providers/OpenAIWhisperSpeechToTextProvider.js';
export { DeepgramBatchSTTProvider } from './providers/DeepgramBatchSTTProvider.js';
export { AssemblyAISTTProvider } from './providers/AssemblyAISTTProvider.js';
export { AzureSpeechSTTProvider } from './providers/AzureSpeechSTTProvider.js';
export { BuiltInAdaptiveVadProvider } from './providers/BuiltInAdaptiveVadProvider.js';

// Streaming STT over OpenAI Realtime transcription sessions (a voice pipeline provider)
export { OpenAIRealtimeTranscriptionSTT } from '../voice-pipeline/providers/OpenAIRealtimeTranscriptionSTT.js';
export type {
  OpenAIRealtimeTranscriptionSTTConfig,
  OpenAIRealtimeTranscriptionRollover,
  OpenAIRealtimeRolloverRequest,
  OpenAIRealtimeTurnDetection,
} from '../voice-pipeline/providers/OpenAIRealtimeTranscriptionSTT.js';
