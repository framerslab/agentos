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
 * - **STT providers**: OpenAI Whisper, Deepgram, AssemblyAI, Azure Speech
 * - **VAD providers**: BuiltInAdaptiveVadProvider
 * - **Batch transcription**: transcribePieces, which sends a recording's
 *   pieces in order and joins their texts with mergeSeam
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

// A recording transcribed in pieces
export { transcribePieces, mergeSeam, lastSentence, PiecesFailed, type PieceInput, type PieceTranscript, type PieceOutcome, type TranscribePiece, type TranscribePiecesOptions } from './transcribePieces.js';
